// bash primitive (PRD §8 row 1). Runs at step 3 (action-type deny) when
// action.type === "bash".

// Accepts either flat (action.cmd) or nested (action.args.cmd / .command)
// shapes so wireGate-style {type, args, _ctx} adapters compose without a
// translation layer. Flat shape is the documented canonical form; nested
// fallbacks exist because every wireGate-style adapter surfaces the same
// seam. (v0.4.1, multis seam fix.)
// Shell-control metacharacters that chain, substitute, or redirect — a prefix
// allowlist can't bound what runs after them (`git x; rm -rf ~` starts with an
// allowed prefix but runs `rm`). When `bash.allow` is set, any of these makes
// the command unallowlistable, so it's denied. content.denyPatterns scans the
// whole string and is the right tool when you genuinely need pipes/chaining.
const SHELL_META = /[;&|<>$`()\n\r]/;

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
    const meta = cmd.match(SHELL_META);
    if (meta) {
      return {
        outcome: "deny", severity: "action", rule: "bash.allow.shellMeta",
        reason: `command contains shell metacharacter ${JSON.stringify(meta[0])}; bash.allow is prefix-only`,
      };
    }
    const allowed = cfg.allow.some(prefix => cmd.startsWith(prefix));
    if (!allowed) {
      return { outcome: "deny", severity: "action", rule: "bash.allow", reason: "command not in bash.allow" };
    }
  }

  return null;
}
