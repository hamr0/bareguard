// tools primitive (PRD §8 row 7). Three rules:
//   - tools.denylist        — step 1
//   - tools.denyArgPatterns — step 3 (action-type deny)
//   - tools.allowlist       — step 5 (scope check); set+match allow, set+miss deny

import { matchAny } from "../glob.js";

/**
 * Step-1 deny: action type matches a glob in the denylist.
 * @param {object} action action being evaluated
 * @param {string} action.type tool/action type name
 * @param {object} [cfg] tools config
 * @param {string[]} [cfg.denylist] glob patterns of denied tool types
 * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} deny decision, or null if no match
 */
export function toolsDenylistCheck(action, cfg = {}) {
  if (!cfg.denylist || cfg.denylist.length === 0) return null;
  if (matchAny(action.type, cfg.denylist)) {
    return { outcome: "deny", severity: "action", rule: "tools.denylist", reason: `${action.type} on denylist` };
  }
  return null;
}

/**
 * Step-3 deny: serialized action matches a per-type denyArgPattern RegExp.
 * @param {object} action action being evaluated (serialized via JSON.stringify)
 * @param {string} action.type tool/action type name
 * @param {object} [cfg] tools config
 * @param {Object<string, RegExp[]>} [cfg.denyArgPatterns] map of action type → RegExp list tested against the serialized action
 * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} deny decision, or null if no match
 */
export function toolsDenyArgsCheck(action, cfg = {}) {
  const map = cfg.denyArgPatterns;
  if (!map) return null;
  const patterns = map[action.type];
  if (!patterns || patterns.length === 0) return null;
  let argStr;
  try { argStr = JSON.stringify(action); }
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

/**
 * Step-5 scope check: with an allowlist set, allow on match and deny on miss.
 * @param {object} action action being evaluated
 * @param {string} action.type tool/action type name
 * @param {object} [cfg] tools config
 * @param {string[]} [cfg.allowlist] glob patterns of allowed tool types
 * @returns {{outcome:string,severity:string,rule:string,reason:(string|null)}|null} allow/deny decision, or null if no allowlist configured
 */
export function toolsAllowlistCheck(action, cfg = {}) {
  // An ABSENT allowlist means "scope not configured" (no opinion). An EMPTY one
  // is a configured scope of nothing and must deny everything: folding `[]` into
  // "not configured" made the tightest possible scope fail OPEN to default allow.
  if (!cfg.allowlist) return null;
  if (matchAny(action.type, cfg.allowlist)) {
    return { outcome: "allow", severity: "action", rule: "tools.allowlist", reason: null };
  }
  return {
    outcome: "deny", severity: "action", rule: "tools.allowlist.exclusive",
    reason: `${action.type} not in allowlist`,
  };
}
