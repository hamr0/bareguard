// tools primitive (PRD §8 row 7). Three rules:
//   - tools.denylist        — step 1
//   - tools.denyArgPatterns — step 3 (action-type deny)
//   - tools.allowlist       — step 5 (scope check); set+match allow, set+miss deny

import { matchAny } from "../glob.js";

export function toolsDenylistCheck(action, cfg = {}) {
  if (!cfg.denylist || cfg.denylist.length === 0) return null;
  if (matchAny(action.type, cfg.denylist)) {
    return { outcome: "deny", severity: "action", rule: "tools.denylist", reason: `${action.type} on denylist` };
  }
  return null;
}

export function toolsDenyArgsCheck(action, cfg = {}) {
  const map = cfg.denyArgPatterns;
  if (!map) return null;
  const patterns = map[action.type];
  if (!patterns || patterns.length === 0) return null;
  let argStr;
  try { argStr = JSON.stringify({ args: action.args, ...action }); }
  catch { return null; }
  for (const re of patterns) {
    if (re.test(argStr)) {
      return {
        outcome: "deny", severity: "action", rule: "tools.denyArgPatterns",
        reason: `${action.type} args match ${re}`,
      };
    }
  }
  return null;
}

export function toolsAllowlistCheck(action, cfg = {}) {
  if (!cfg.allowlist || cfg.allowlist.length === 0) return null;
  if (matchAny(action.type, cfg.allowlist)) {
    return { outcome: "allow", severity: "action", rule: "tools.allowlist", reason: null };
  }
  return {
    outcome: "deny", severity: "action", rule: "tools.allowlist.exclusive",
    reason: `${action.type} not in allowlist`,
  };
}
