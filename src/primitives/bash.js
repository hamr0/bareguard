// bash primitive (PRD §8 row 1). Runs at step 3 (action-type deny) when
// action.type === "bash".

// Accepts either flat (action.cmd) or nested (action.args.cmd / .command)
// shapes so wireGate-style {type, args, _ctx} adapters compose without a
// translation layer. Flat shape is the documented canonical form; nested
// fallbacks exist because every wireGate-style adapter surfaces the same
// seam. (v0.4.1, multis seam fix.)
export function bashCheck(action, cfg = {}) {
  if (action.type !== "bash") return null;
  const cmd = action.cmd ?? action.args?.cmd ?? action.args?.command ?? "";

  if (cfg.denyPatterns) {
    for (const re of cfg.denyPatterns) {
      if (re.test(cmd)) {
        return { outcome: "deny", severity: "action", rule: "bash.denyPatterns", reason: `matches ${re}` };
      }
    }
  }

  if (cfg.allow) {
    const allowed = cfg.allow.some(prefix => cmd.startsWith(prefix));
    if (!allowed) {
      return { outcome: "deny", severity: "action", rule: "bash.allow", reason: "command not in bash.allow" };
    }
  }

  return null;
}
