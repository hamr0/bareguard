// Secrets redaction (PRD v0.5 §10). Pre-eval action mutation. Format:
//   - env-var match → [REDACTED:ENV_VAR_NAME]
//   - pattern match → [REDACTED:pattern=<short prefix>...]

// Don't redact short env values that may be meaningful (e.g., port numbers).
// Trade-off: a secret shorter than this is NOT masked via `envVars` — use a
// `patterns` entry for short secrets that must be redacted.
const MIN_ENV_VAR_LEN = 8;

/**
 * Redact configured secrets from an action/value by serializing, replacing
 * env-var values and pattern matches, then re-parsing. Env-var values shorter
 * than 8 chars are skipped; patterns are forced global so every match on a line
 * is replaced.
 * @template T
 * @param {T} action value to redact (typically an action object; returned as-is
 *   if falsy or non-serializable)
 * @param {import("../types.js").SecretsConfig} [cfg] secrets config
 * @returns {T} redacted copy, or the original value if nothing changed / it
 *   could not be processed
 */
export function redact(action, cfg = {}) {
  if (!action) return action;
  let serialized;
  try { serialized = JSON.stringify(action); }
  catch { return action; } // non-serializable; bail
  let changed = false;

  for (const varName of cfg.envVars ?? []) {
    const val = process.env[varName];
    if (!val || val.length < MIN_ENV_VAR_LEN) continue;
    if (serialized.includes(val)) {
      serialized = serialized.split(val).join(`[REDACTED:${varName}]`);
      changed = true;
    }
  }

  for (const re of cfg.patterns ?? []) {
    // Force global matching: a non-global pattern (a natural config mistake,
    // e.g. /sk-[a-z0-9]+/) would replace only the FIRST match via
    // String.replace, leaving a second secret on the same line in cleartext.
    const g = re.global ? re : new RegExp(re.source, re.flags + "g");
    const next = serialized.replace(g, m => {
      changed = true;
      const prefix = m.slice(0, 4).replace(/[\\"]/g, "_");
      return `[REDACTED:pattern=${prefix}...]`;
    });
    serialized = next;
  }

  if (!changed) return action;
  try { return JSON.parse(serialized); }
  catch { return action; }
}
