// fs primitive (PRD §8 row 3). Runs at step 3 (action-type deny) when
// action.type is read/write/edit. Path-based scope and deny matching.

const FS_TYPES = new Set(["read", "write", "edit"]);

// Accepts either flat (action.path) or nested (action.args.path) shapes so
// wireGate-style {type, args, _ctx} adapters compose without a translation
// layer. (v0.4.1, multis seam fix.)
export function fsCheck(action, cfg = {}) {
  if (!FS_TYPES.has(action.type)) return null;
  const p = action.path ?? action.args?.path;
  if (typeof p !== "string") return null;

  if (cfg.deny) {
    for (const d of cfg.deny) {
      if (p === d || p.startsWith(d.endsWith('/') ? d : d + '/')) {
        return { outcome: "deny", severity: "action", rule: "fs.deny", reason: `path ${p} matches deny entry ${d}` };
      }
    }
  }

  if (action.type === "read" && cfg.readScope) {
    if (!cfg.readScope.some(s => p.startsWith(s))) {
      return { outcome: "deny", severity: "action", rule: "fs.readScope", reason: `path ${p} outside readScope` };
    }
  }

  if ((action.type === "write" || action.type === "edit") && cfg.writeScope) {
    if (!cfg.writeScope.some(s => p.startsWith(s))) {
      return { outcome: "deny", severity: "action", rule: "fs.writeScope", reason: `path ${p} outside writeScope` };
    }
  }

  return null;
}
