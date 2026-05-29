// fs primitive (PRD §8 row 3). Runs at step 3 (action-type deny) when
// action.type is read/write/edit. Path-based scope and deny matching.

import path from "node:path";

const FS_TYPES = new Set(["read", "write", "edit"]);

// Collapse `.` / `..` segments before matching so a path can't escape a deny
// entry or a scope root via traversal (PRD §8 row 3 lists `..` as deny-worthy).
// Backslashes are folded to `/` FIRST so a Windows-style path
// (`/scope/..\..\etc`) can't slip past `path.posix.normalize` — which treats
// `\` as an ordinary character and would leave the `..` segments uncollapsed,
// a scope escape on win32 where `\` is a real separator. NOTE: this resolves
// lexical traversal only — it does NOT follow symlinks (would require async
// realpath); callers needing symlink-proofing must canonicalise before the gate.
function norm(p) {
  return path.posix.normalize(p.replace(/\\/g, "/"));
}

// Boundary-aware containment: `p` is `base` itself or a path *under* `base`.
// The trailing-separator guard stops `/app/data` from matching `/app/data-x`.
// `path.posix.normalize` keeps a single trailing slash, so strip it from the
// base first — otherwise a config entry written as `/etc/secret/` would miss
// the directory node itself (`/etc/secret`): a fail-open on deny and a
// fail-closed on scope.
function within(p, base) {
  let b = norm(base);
  if (b === "/") return p.startsWith("/"); // root contains every absolute path
  if (b.endsWith("/")) b = b.slice(0, -1);
  return p === b || p.startsWith(b + "/");
}

// Accepts either flat (action.path) or nested (action.args.path) shapes so
// wireGate-style {type, args, _ctx} adapters compose without a translation
// layer. (v0.4.1, multis seam fix.)
/**
 * Step-3 deny for `read`/`write`/`edit` actions: lexical-normalized path deny + read/write scope enforcement.
 * @param {object} action action being evaluated; path read from action.path or action.args.path
 * @param {string} action.type action type ("read", "write", or "edit"; no-op otherwise)
 * @param {string} [action.path] target path (flat shape)
 * @param {object} [action.args] nested-shape args
 * @param {object} [cfg] fs config
 * @param {string[]} [cfg.deny] paths/prefixes denied for all fs actions
 * @param {string[]} [cfg.readScope] if set, read paths must fall under one of these
 * @param {string[]} [cfg.writeScope] if set, write/edit paths must fall under one of these
 * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} deny decision, or null if allowed/not applicable
 */
export function fsCheck(action, cfg = {}) {
  if (!FS_TYPES.has(action.type)) return null;
  const raw = action.path ?? action.args?.path;
  // A present-but-non-string path (array, object with `toString`, number) must
  // NOT fall through as "no opinion" — that fails OPEN, letting the action
  // reach the allowlist while the executor coerces the value back to a real
  // path (e.g. `{ toString: () => "/etc/passwd" }`), escaping deny/scope.
  // Deny anything that isn't a plain string. (Absent → not an fs shape we gate.)
  if (raw != null && typeof raw !== "string") {
    return { outcome: "deny", severity: "action", rule: "fs.invalidPath", reason: `path is not a string (type ${typeof raw})` };
  }
  if (typeof raw !== "string") return null;
  const p = norm(raw);

  if (cfg.deny) {
    for (const d of cfg.deny) {
      if (within(p, d)) {
        return { outcome: "deny", severity: "action", rule: "fs.deny", reason: `path ${raw} matches deny entry ${d}` };
      }
    }
  }

  if (action.type === "read" && cfg.readScope) {
    if (!cfg.readScope.some(s => within(p, s))) {
      return { outcome: "deny", severity: "action", rule: "fs.readScope", reason: `path ${raw} outside readScope` };
    }
  }

  if ((action.type === "write" || action.type === "edit") && cfg.writeScope) {
    if (!cfg.writeScope.some(s => within(p, s))) {
      return { outcome: "deny", severity: "action", rule: "fs.writeScope", reason: `path ${raw} outside writeScope` };
    }
  }

  return null;
}
