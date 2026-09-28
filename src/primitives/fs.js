// fs primitive (PRD §8 row 3). Runs at step 3 (action-type deny) when
// action.type is read/write/edit.
//
// Governing rule: nothing inferred — say it or don't; not saying is deny. No
// setting implies another (write != read, a parent folder's grant != a
// child's, `fs.deny` != a scope). See fs-config.js for entry
// validation/normalization (the ONE place that decides what an entry means).
//
// Design:
//  - deny-by-default for file actions: unset OR `[]` scope = nothing allowed.
//  - `read` must be inside `readScope`; `write`/`edit` must be inside
//    `writeScope`. A folder listed only in `writeScope` is NOT readable —
//    list it in both to grant both.
//  - `fs.deny` is an optional EXTRA layer inside the allowed folders (unset =
//    no extra layer, not "nothing denied" vs "everything denied" — it never
//    widens what a scope allows, only narrows it).
//  - agent paths are NEVER canonicalized by the gate (item 4): non-string,
//    `~`-prefixed, or relative -> rejected outright, before any scope/deny
//    matching runs. The EXECUTOR canonicalizes before it actually opens the
//    path, and opens that same resolved string (TOCTOU is the executor's
//    problem, not this check's — see CONTRACT.md §E).
//  - symlink/resolved-path check is ON BY DEFAULT, no opt-out: realpath the
//    nearest existing ancestor + tail (so a not-yet-created file/dir still
//    checks cleanly), and realpath every configured scope/deny ROOT the same
//    way, FRESH on every call (no caching — a root's on-disk symlink target
//    can legitimately change between two checks, e.g. a workdir alias being
//    retargeted, and the check must see the current target, not a stale one).
//    Must pass BOTH the lexical check and the resolved check. A dangling
//    symlink anywhere on the walk, an ELOOP cycle, or EACCES/EPERM along the
//    way -> deny (not "no opinion", not a crash).

import path from "node:path";
import fsSync from "node:fs";
import { resolveFsConfig } from "./fs-config.js";

const FS_TYPES = new Set(["read", "write", "edit"]);

function norm(p) {
  return path.posix.normalize(p.replace(/\\/g, "/"));
}

// Boundary-aware containment: `p` is `base` itself or a path *under* `base`.
function within(p, base) {
  let b = norm(base);
  if (b === "/") return p.startsWith("/");
  if (b.endsWith("/")) b = b.slice(0, -1);
  return p === b || p.startsWith(b + "/");
}

// `cfg.fs` objects are held by reference (per Gate's existing model); cache
// the resolved/validated form keyed by that same object IDENTITY so repeated
// checks against the same live config don't re-parse/re-validate it on every
// action, while a direct call to `fsCheck()` with raw config still goes
// through the ONE validator (`resolveFsConfig`). This cache holds only the
// validated STRING entries (post tilde-expansion) — it never caches a
// `realpath()` result, so scope-root freshness (see header) is untouched.
const _resolvedCache = new WeakMap();
const EMPTY = Object.freeze({});

function getResolvedConfig(rawCfg) {
  const key = rawCfg ?? EMPTY;
  if (_resolvedCache.has(key)) return _resolvedCache.get(key);
  const resolved = resolveFsConfig(rawCfg); // throws on a bad entry — caller's job to fail closed
  _resolvedCache.set(key, resolved);
  return resolved;
}

// Recursion/loop bound for the nearest-existing-ancestor walk. A real
// filesystem path is a handful of segments deep; 200 is far past any
// legitimate depth and stands in for a genuine ELOOP the platform itself
// didn't already report via ELOOP/ENOENT.
const MAX_WALK = 200;

// Windows drive-letter root, e.g. "C:/" out of "C:/Users/x/.ssh/id_rsa".
const WIN_DRIVE_ROOT = /^[A-Za-z]:\//;
// UNC root, e.g. "//server/share/" out of "//server/share/x/y".
const UNC_ROOT = /^\/\/[^/]+\/[^/]+\//;

/**
 * The root prefix of an already-normalized (forward-slash), absolute path —
 * platform-aware so the ancestor walk below terminates at the actual root
 * (a drive letter or UNC share on Windows, `/` everywhere else) instead of
 * mis-popping through a drive letter as if it were an ordinary segment, or
 * walking past it into a bare `"/"` that means something different on
 * Windows (the root of the CURRENT drive, not a stable, config-independent
 * root). One definition, shared by both the target-path walk and the
 * scope/deny-root walk (`resolveRootFresh` below) — no separate "absolute"
 * concept for config entries vs agent paths.
 * @param {string} p
 * @returns {string|null} the root prefix (trailing `/` included), or null if `p` isn't recognizably absolute
 */
function rootOf(p) {
  const win = WIN_DRIVE_ROOT.exec(p);
  if (win) return win[0];
  const unc = UNC_ROOT.exec(p);
  if (unc) return unc[0];
  if (p.startsWith("/")) return "/";
  return null;
}

/**
 * Resolve `absPath` via realpath of its nearest EXISTING ancestor, then
 * reattach the non-existent tail (normalized; a path component that doesn't
 * exist yet cannot itself be a symlink, so no resolution is needed or
 * possible for it). Used for BOTH agent-supplied target paths and configured
 * scope/deny ROOTS — one function, one set of symlink semantics, so "a root
 * that doesn't exist yet" is resolved exactly the same way as "a new file
 * inside an existing scope" (no separate lexical-only fallback for either).
 * The walk never pops past the path's own root (drive letter / UNC share /
 * `/`) — see `rootOf`.
 * @param {string} absPath already lexically-normalized absolute (posix-style) path
 * @returns {{resolved:string}|{error:"ELOOP"|"EACCES"|"DANGLING"|string}}
 */
function resolveWithSymlinks(absPath) {
  const root = rootOf(absPath);
  if (root === null) return { error: "EINVAL" };
  let testPath = absPath;
  const tail = [];
  let iterations = 0;
  while (true) {
    if (++iterations > MAX_WALK) return { error: "ELOOP" };
    let lst;
    try {
      lst = fsSync.lstatSync(testPath);
    } catch (e) {
      if (e.code === "ELOOP") return { error: "ELOOP" };
      if (e.code === "EACCES" || e.code === "EPERM") return { error: "EACCES" };
      if (e.code === "ENOENT" || e.code === "ENOTDIR") {
        // Genuinely absent (not a broken symlink) — pop the last segment
        // onto the tail and retry the parent. Candidate for "new file/dir
        // inside an existing (or still-to-be-created) ancestor".
        if (testPath === root) {
          // The root itself doesn't exist (e.g. an unmounted drive) — no
          // further ancestor to try; hand back the lexical join so the
          // caller sees a resolved-looking path rather than an error for
          // what is, at worst, a root that was never going to exist.
          return { resolved: root + tail.join("/") };
        }
        const rest = testPath.slice(root.length); // no leading slash; root already ends in "/"
        const parts = rest.split("/").filter((s) => s !== "");
        const last = parts.pop();
        if (last !== undefined) tail.unshift(last);
        testPath = parts.length ? root + parts.join("/") : root;
        continue;
      }
      return { error: e.code || "EUNKNOWN" };
    }
    if (lst.isSymbolicLink()) {
      try {
        // `realpathSync` returns a NATIVE path — backslash-separated on
        // Windows. `norm()` folds it back to the same forward-slash form
        // every other path in this module is compared in, so
        // `path.posix.join` with the (posix-style) tail never produces a
        // mixed-separator string.
        const real = norm(fsSync.realpathSync(testPath));
        return { resolved: tail.length ? path.posix.join(real, ...tail) : real };
      } catch (e) {
        if (e.code === "ELOOP") return { error: "ELOOP" };
        if (e.code === "EACCES" || e.code === "EPERM") return { error: "EACCES" };
        // The symlink component exists but its target chain is broken
        // somewhere further along — a dangling link anywhere on the walk.
        return { error: "DANGLING" };
      }
    }
    // Real (non-symlink) existing node — realpath it (resolves any
    // symlinked ANCESTOR directory above it) and reattach the tail.
    try {
      const real = norm(fsSync.realpathSync(testPath));
      return { resolved: tail.length ? path.posix.join(real, ...tail) : real };
    } catch (e) {
      if (e.code === "ELOOP") return { error: "ELOOP" };
      if (e.code === "EACCES" || e.code === "EPERM") return { error: "EACCES" };
      return { error: e.code || "EUNKNOWN" };
    }
  }
}

/**
 * Resolve a configured scope/deny ROOT, fresh, every call — no cache, no
 * lexical-only fallback for a root that doesn't exist yet (that fallback was
 * considered and rejected: it would silently degrade symlink protection for
 * any root created after construct time, exactly the class of root a fresh
 * workdir scope is). A root this call cannot resolve (ELOOP, a dangling link
 * IN the root's own path, EACCES) is excluded from resolved-scope matching
 * for this one check — never a silent allow, and never a crash; the other
 * configured roots (if any) can still match.
 * @param {string} root already-normalized absolute root path
 * @returns {string|null}
 */
function resolveRootFresh(root) {
  const rr = resolveWithSymlinks(norm(root));
  return "error" in rr ? null : rr.resolved;
}

/**
 * @param {object} action
 * @param {object} [cfg] fs config (raw; validated/resolved here via fs-config.js)
 * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} deny decision, or null if allowed/not applicable
 */
export function fsCheck(action, cfg = {}) {
  if (!FS_TYPES.has(action.type)) return null;
  const raw = action.path ?? action.args?.path;

  if (raw != null && typeof raw !== "string") {
    return { outcome: "deny", severity: "action", rule: "fs.invalidPath", reason: `path is not a string (type ${typeof raw})` };
  }
  if (typeof raw !== "string") return null;

  // Agent paths are NEVER canonicalized by the gate (item 4) — reject
  // anything that isn't already an unambiguous absolute path, before any
  // scope/deny matching runs.
  if (raw === "") {
    return { outcome: "deny", severity: "action", rule: "fs.invalidPath", reason: "path is an empty string" };
  }
  if (raw.startsWith("~")) {
    return { outcome: "deny", severity: "action", rule: "fs.invalidPath", reason: `agent path must not use "~": ${raw}` };
  }
  if (!path.isAbsolute(raw)) {
    return { outcome: "deny", severity: "action", rule: "fs.invalidPath", reason: `agent path must be absolute: ${raw}` };
  }

  const p = norm(raw);

  let resolved;
  try {
    resolved = getResolvedConfig(cfg);
  } catch (e) {
    // The ONE validator threw (a bad scope/deny entry). Fail closed — never
    // silently ignore a malformed config, same polarity as every other
    // `<key>.invalid` rule in this codebase. `e.key` (set by resolveFsConfig
    // for every entry-level failure) attributes this to the released
    // `fs.deny.invalid`/`fs.readScope.invalid`/`fs.writeScope.invalid` rule;
    // only a section-shape error (`fs` itself isn't a plain object — no
    // single key to blame) falls back to `fs.config.invalid`.
    const rule = e.key ? `fs.${e.key}.invalid` : "fs.config.invalid";
    return { outcome: "deny", severity: "action", rule, reason: e.message };
  }

  // fs.deny: optional extra layer INSIDE the allowed folders (lexical pass).
  for (const d of resolved.deny) {
    if (within(p, d)) {
      return { outcome: "deny", severity: "action", rule: "fs.deny", reason: `path ${raw} matches deny entry ${d}` };
    }
  }

  const scopeKey = action.type === "read" ? "readScope" : "writeScope";
  const scopeRule = action.type === "read" ? "fs.readScope" : "fs.writeScope";
  const scopeList = resolved[scopeKey];

  // Deny-by-default: unset or [] = nothing allowed. A write-only scope does
  // not imply read, and vice versa — no crossover either direction.
  if (!scopeList || scopeList.length === 0) {
    return { outcome: "deny", severity: "action", rule: `${scopeRule}.unset`, reason: `no ${scopeKey} configured — file actions deny by default` };
  }

  const lexicalHit = scopeList.some((s) => within(p, s));
  if (!lexicalHit) {
    return { outcome: "deny", severity: "action", rule: scopeRule, reason: `path ${raw} outside ${scopeKey}` };
  }

  // Symlink/resolved-path check, ON by default, no opt-out.
  const rr = resolveWithSymlinks(p);
  if ("error" in rr) {
    const rule = rr.error === "DANGLING" ? `${scopeRule}.danglingSymlink` : `${scopeRule}.resolveError`;
    return { outcome: "deny", severity: "action", rule, reason: `could not resolve ${raw}: ${rr.error}` };
  }
  const resolvedPath = rr.resolved;
  const resolvedHit = scopeList.some((s) => {
    const root = resolveRootFresh(s);
    return root !== null && within(resolvedPath, root);
  });
  if (!resolvedHit) {
    return { outcome: "deny", severity: "action", rule: `${scopeRule}.symlinkEscape`, reason: `path ${raw} resolves to ${resolvedPath}, outside ${scopeKey}` };
  }

  // fs.deny re-checked against the RESOLVED path — a symlink pointing into a
  // denied folder from inside an allowed scope must not slip past deny.
  for (const d of resolved.deny) {
    const root = resolveRootFresh(d);
    if (root !== null && within(resolvedPath, root)) {
      return { outcome: "deny", severity: "action", rule: "fs.deny.resolved", reason: `path ${raw} resolves to ${resolvedPath}, matching deny entry ${d}` };
    }
  }

  return null;
}

export { resolveFsConfig } from "./fs-config.js";
