// content primitive (PRD §8 row 12, §11 safe defaults). Pattern-matches over
// JSON.stringify(action). Two rules:
//   - denyPatterns at step 2 (universal deny)
//   - askPatterns  at step 4 (universal ask — fires even on allowlisted tools)

export const SAFE_DEFAULT_DENY_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDELETE\s+FROM\s+\w+(?!\s+WHERE)/i,
  /\brm\s+-rf\s+\//,
  /:(force|--force|-f)\s/,
  /\bTRUNCATE\s+TABLE\b/i,
];

export const SAFE_DEFAULT_ASK_PATTERNS = [
  /\b(delete|drop|revoke|truncate|destroy|remove|purge)\b/i,
  /\bforce[- ]push\b/i,
  /"method"\s*:\s*"(DELETE|PUT|PATCH)"/i,
];

function serializeForMatch(action) {
  try { return JSON.stringify(action); }
  catch { return String(action); }
}

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
