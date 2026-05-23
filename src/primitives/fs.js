// fs primitive (PRD §8 row 3). Runs at step 3 (action-type deny) when
// action.type is read/write/edit. Path-based scope and deny matching.

import path from "node:path";

const FS_TYPES = new Set(["read", "write", "edit"]);

// Collapse `.` / `..` segments before matching so a path can't escape a deny
// entry or a scope root via traversal (PRD §8 row 3 lists `..` as deny-worthy).
// posix semantics: action paths are unix-style. NOTE: this resolves lexical
// traversal only — it does NOT follow symlinks (would require async realpath);
// callers needing symlink-proofing must canonicalise before the gate.
function norm(p) {
  return path.posix.normalize(p);
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
export function fsCheck(action, cfg = {}) {
  if (!FS_TYPES.has(action.type)) return null;
  const raw = action.path ?? action.args?.path;
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
