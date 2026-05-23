// Secrets redaction (PRD v0.5 §10). Pre-eval action mutation. Format:
//   - env-var match → [REDACTED:ENV_VAR_NAME]
//   - pattern match → [REDACTED:pattern=<short prefix>...]

const MIN_ENV_VAR_LEN = 8; // don't redact short values that may be meaningful (e.g., port numbers)

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
