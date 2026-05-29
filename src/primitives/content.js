// content primitive (PRD §8 row 12, §11 safe defaults). Pattern-matches over
// JSON.stringify(action). Two rules:
//   - denyPatterns at step 2 (universal deny)
//   - askPatterns  at step 4 (universal ask — fires even on allowlisted tools)

/**
 * Patterns denied outright when `content.denyPatterns` is not configured:
 * `DROP TABLE`, unscoped `DELETE FROM`, `rm -rf /`, `--force`, `TRUNCATE TABLE`.
 * Pass `content: { denyPatterns: [] }` to opt out (pure-allow).
 * @type {RegExp[]}
 */
export const SAFE_DEFAULT_DENY_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDELETE\s+FROM\s+\w+\b(?!\s+WHERE\b)/i,
  /\brm\s+-rf\s+\//,
  /(?:^|[\s"'])--force(?=[\s"'}]|$)|:(force|--force|-f)\s/,
  /\bTRUNCATE\s+TABLE\b/i,
];

/**
 * Patterns that escalate to the human when `content.askPatterns` is not
 * configured: destructive verbs (delete/drop/revoke/…), force-push, and
 * destructive HTTP methods. Pass `content: { askPatterns: [] }` to opt out.
 * @type {RegExp[]}
 */
export const SAFE_DEFAULT_ASK_PATTERNS = [
  /\b(delete|drop|revoke|truncate|destroy|remove|purge)\b/i,
  /\bforce[- ]push\b/i,
  /"method"\s*:\s*"(DELETE|PUT|PATCH)"/i,
];

function serializeForMatch(action) {
  try { return JSON.stringify(action); }
  catch { return String(action); }
}

/**
 * Step-2 universal deny: serialized action matches a deny RegExp.
 * @param {object} action action being evaluated (serialized via JSON.stringify)
 * @param {object} [cfg] content config
 * @param {RegExp[]} [cfg.denyPatterns] deny patterns (defaults to SAFE_DEFAULT_DENY_PATTERNS)
 * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} deny decision, or null if no match
 */
export function contentDenyCheck(action, cfg) {
  const patterns = cfg?.denyPatterns ?? SAFE_DEFAULT_DENY_PATTERNS;
  if (!patterns.length) return null;
  const s = serializeForMatch(action);
  for (const re of patterns) {
    if (re.test(s)) {
      return { outcome: "deny", severity: "action", rule: "content.denyPatterns", reason: `matched ${re}` };
    }
  }
  return null;
}

/**
 * Step-4 universal ask: serialized action matches an ask RegExp (fires even on allowlisted tools).
 * @param {object} action action being evaluated (serialized via JSON.stringify)
 * @param {object} [cfg] content config
 * @param {RegExp[]} [cfg.askPatterns] ask patterns (defaults to SAFE_DEFAULT_ASK_PATTERNS)
 * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} askHuman decision, or null if no match
 */
export function contentAskCheck(action, cfg) {
  const patterns = cfg?.askPatterns ?? SAFE_DEFAULT_ASK_PATTERNS;
  if (!patterns.length) return null;
  const s = serializeForMatch(action);
  for (const re of patterns) {
    if (re.test(s)) {
      return { outcome: "askHuman", severity: "action", rule: "content.askPatterns", reason: `matched ${re}` };
    }
  }
  return null;
}
