// bash primitive (PRD §8 row 1). Runs at step 3 (action-type deny) when
// action.type === "bash".

export function bashCheck(action, cfg = {}) {
  if (action.type !== "bash") return null;
  const cmd = action.cmd ?? "";

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
