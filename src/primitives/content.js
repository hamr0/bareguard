// content primitive (PRD §8 row 12, §11 safe defaults). Pattern-matches over
// the action's OPERATION shape, NOT the bytes of a file it writes. Two rules:
//   - denyPatterns at step 2 (universal deny)
//   - askPatterns  at step 4 (universal ask — fires even on allowlisted tools)
//
// Scope (BG-3/F35): these patterns target destructive *operations*
// (`DROP TABLE`, `rm -rf /`, HTTP DELETE) — a command/verb signal. The write
// PAYLOAD (`action.args.content`/`.contents`) is excluded from the match input:
// scanning a written document's bytes for words like "drop"/"remove" false-fires
// on ordinary code vocabulary, adds no safety (an in-scope write is guarded by
// `fs.writeScope`; dangerous bytes are caught when they are *executed* as a bash
// action, not when written), and duplicates the wrong layer — payload/value
// inspection is `secrets`' job, not `content`'s. Exclusion is fail-LOUD: unknown
// fields are still matched, so a new action shape can only regress to a visible
// false-fire, never a silent miss. Extend PAYLOAD_FIELDS if a write primitive
// adds a distinct payload field.

/**
 * Field names under `action.args` that carry a file-write payload (the written
 * document, not the operation). Stripped before pattern matching. Today's
 * complete set across the callers: `content` (shell_write) + `contents`
 * (edit_file). Fail-loud polarity: absent entries regress to a false-fire, not
 * a silent hole — extend only when a real payload field is added.
 * @type {string[]}
 */
export const PAYLOAD_FIELDS = ["content", "contents"];

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

// Serialize the action for pattern matching with any write-payload field under
// `action.args` removed (non-mutating shallow copy). content patterns inspect
// the operation, never the written document — see the header note (BG-3/F35).
function serializeForMatch(action) {
  try {
    let a = action;
    const args = action?.args;
    if (args && typeof args === "object" && PAYLOAD_FIELDS.some((f) => f in args)) {
      const cleanArgs = { ...args };
      for (const f of PAYLOAD_FIELDS) delete cleanArgs[f];
      a = { ...action, args: cleanArgs };
    }
    return JSON.stringify(a);
  } catch { return String(action); }
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
