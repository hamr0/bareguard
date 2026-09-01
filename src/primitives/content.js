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
// false-fire, never a silent miss. If a future write primitive ships a distinct
// payload field, adding it here is a one-line lib change (fix-at-the-lib) — it
// is NOT a runtime knob: the array is frozen and read only from the default set,
// never merged with per-Gate config (a consumer needing different behavior scopes
// `content.{ask,deny}Patterns`, which they already fully control).

/**
 * Field names under `action.args` that carry a file-write payload (the written
 * document, not the operation), stripped before pattern matching. Exported
 * **frozen, for introspection** — read it to see what `content` excludes; do not
 * mutate it (frozen so an accidental push fails loudly instead of silently
 * changing every Gate in the process). Complete set across the shipping callers:
 * `content` (shell_write) + `contents` (edit_file). Fail-loud polarity: an
 * unlisted field regresses to a visible false-fire, never a silent hole.
 * @type {readonly string[]}
 */
export const PAYLOAD_FIELDS = Object.freeze(["content", "contents"]);

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
  const raw = cfg?.denyPatterns;
  // `?? SAFE_DEFAULT_DENY_PATTERNS` only falls back on null/undefined, so a
  // present-but-non-array value (config held by reference, swapped post-
  // construction) silently REPLACES the safe default deny floor instead of
  // being rejected — and then `for (const re of patterns)` throws mid-eval on
  // most non-array shapes anyway. Fail CLOSED instead, same as `tools.allowlist`.
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    return {
      outcome: "deny", severity: "action", rule: "content.denyPatterns.invalid",
      reason: `content.denyPatterns is not an array (type ${typeof raw})`,
    };
  }
  const patterns = raw ?? SAFE_DEFAULT_DENY_PATTERNS;
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
  const raw = cfg?.askPatterns;
  // Same class as `contentDenyCheck` above: a non-array `askPatterns` would
  // silently replace the safe default ask floor and then throw mid-eval.
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    return {
      outcome: "deny", severity: "action", rule: "content.askPatterns.invalid",
      reason: `content.askPatterns is not an array (type ${typeof raw})`,
    };
  }
  const patterns = raw ?? SAFE_DEFAULT_ASK_PATTERNS;
  if (!patterns.length) return null;
  const s = serializeForMatch(action);
  for (const re of patterns) {
    if (re.test(s)) {
      return { outcome: "askHuman", severity: "action", rule: "content.askPatterns", reason: `matched ${re}` };
    }
  }
  return null;
}
