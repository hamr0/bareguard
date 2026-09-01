// Secrets redaction (PRD v0.5 §10; BG-1 key-aware layer for F16). Audit-line
// mutation only — eval always sees the real action. Two complementary layers:
//   - value-based (opt-in): env-var values + RegExp patterns → [REDACTED:…]
//   - key-aware (DEFAULT-ON, BG-1): blank a field by *name* regardless of value,
//     plus a narrow set of default value-patterns (`Bearer …`, `sk-…`).
// Tags:
//   - key match      → [REDACTED:key=<name>]
//   - env-var match  → [REDACTED:ENV_VAR_NAME]
//   - pattern match  → [REDACTED:pattern=<short prefix>...]

// Don't redact short env values that may be meaningful (e.g., port numbers).
// Trade-off: a secret shorter than this is NOT masked via `envVars` — use a
// `patterns` entry for short secrets that must be redacted.
const MIN_ENV_VAR_LEN = 8;

// BG-1 default-on key set. Deliberately NARROW — case-insensitive exact names
// only, no `*_token` / `*_secret` globs, because those live where benign
// `page_token` / `csrf_token` false-positives are (audit corruption / broken
// policy-reproduction). Operators extend via `cfg.keys` (globs supported there).
const DEFAULT_SECRET_KEYS = ["apiKey", "api_key", "authorization"];

// BG-1 default-on value patterns — the literal F16 leak shapes. Low false-
// positive: an `Authorization: Bearer …` header value and a bare `sk-…` key.
// NB: these run over the SERIALIZED JSON, so the token charset is bounded (NOT
// `\S+`) — a greedy `\S+` would swallow the closing `"` and corrupt the JSON,
// making JSON.parse bail back to the un-redacted original (secret leak).
const DEFAULT_SECRET_VALUE_PATTERNS = [/Bearer\s+[A-Za-z0-9._\-+/=]+/, /sk-[\w-]{16,}/];

/**
 * Effective key specs = default set (unless `redactKeys:false`) + caller's.
 * @param {import("../types.js").SecretsConfig} cfg
 * @returns {string[]}
 */
function effectiveKeys(cfg) {
  const base = cfg.redactKeys === false ? [] : DEFAULT_SECRET_KEYS;
  // `redact()`'s own contract is never-throw — spreading a present-but-non-
  // array `keys` (a string spreads into single-char specs, an object throws
  // "is not iterable") would violate that contract, and it runs synchronously
  // inside `Audit.emit()`/`gate.check()`, so a throw here stops the gate dead
  // on every subsequent action. `secrets.keys` is already in
  // `ARRAY_SHAPED_CONFIG`, so the Gate constructor already throws loudly on a
  // malformed value at the stage that can afford to throw; this guards the two
  // paths construction cannot cover — a direct public `redact(cfg)` call and a
  // post-construction `cfg` swap (held by reference). Falling back to `[]`
  // keeps `base` (the default-on set) fully active — fail-SAFE, not fail-open.
  const extra = Array.isArray(cfg.keys) ? cfg.keys : [];
  return [...base, ...extra];
}

/**
 * Effective value patterns = default set (unless `redactKeys:false`) + caller's.
 * @param {import("../types.js").SecretsConfig} cfg
 * @returns {RegExp[]}
 */
function effectiveValuePatterns(cfg) {
  const base = cfg.redactKeys === false ? [] : DEFAULT_SECRET_VALUE_PATTERNS;
  // Same class and same reasoning as `effectiveKeys` above: a non-array
  // `patterns` used to spread chars into the RegExp list, which then crashed
  // `new RegExp(re.source, ...)` below with a SyntaxError — inside `redact()`,
  // which must never throw. Fall back to `[]` so `base` stays active.
  const extra = Array.isArray(cfg.patterns) ? cfg.patterns : [];
  return [...base, ...extra];
}

/**
 * Case-insensitive key match. A spec of the form `*suffix` matches any key
 * ending in `suffix` (e.g. `*_token`); otherwise the match is exact.
 * @param {string} key
 * @param {string[]} specs
 */
function keyMatches(key, specs) {
  const lk = key.toLowerCase();
  for (const spec of specs) {
    const s = spec.toLowerCase();
    if (s.startsWith("*")) { if (lk.endsWith(s.slice(1))) return true; }
    else if (lk === s) return true;
  }
  return false;
}

/**
 * Structural walk that blanks the *value* at any key matching `specs`, with
 * structural sharing: an unchanged subtree returns its original reference (so
 * the no-op path preserves referential identity). Built objects use a null
 * prototype so a literal `__proto__` own-key can't pollute via assignment.
 * @param {*} node
 * @param {string[]} specs
 * @returns {{ value: *, changed: boolean }}
 */
function walkKeys(node, specs) {
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((el) => {
      const r = walkKeys(el, specs);
      if (r.changed) changed = true;
      return r.value;
    });
    return changed ? { value: out, changed } : { value: node, changed: false };
  }
  if (node && typeof node === "object") {
    let changed = false;
    const out = Object.create(null);
    for (const [k, v] of Object.entries(node)) {
      if (keyMatches(k, specs)) {
        out[k] = `[REDACTED:key=${k}]`;
        changed = true;
      } else {
        const r = walkKeys(v, specs);
        if (r.changed) changed = true;
        out[k] = r.value;
      }
    }
    return changed ? { value: out, changed } : { value: node, changed: false };
  }
  return { value: node, changed: false };
}

/**
 * Redact configured + default secrets from an action/value. Runs the key-aware
 * walk first (structural), then the value-based env-var / pattern passes over
 * the serialized form. Returns the original reference when nothing matched.
 * @template T
 * @param {T} action value to redact (typically an action object; returned as-is
 *   if falsy or non-serializable)
 * @param {import("../types.js").SecretsConfig} [cfg] secrets config
 * @returns {T} redacted copy, or the original value if nothing changed / it
 *   could not be processed
 */
export function redact(action, cfg = {}) {
  if (!action) return action;

  // 1. Key-aware walk (BG-1). Blank by field name regardless of value.
  const keySpecs = effectiveKeys(cfg);
  let work = action;
  let changed = false;
  if (keySpecs.length) {
    const r = walkKeys(action, keySpecs);
    work = r.value;
    changed = r.changed;
  }

  // 2. Value-based passes over the serialized form.
  let serialized;
  try { serialized = JSON.stringify(work); }
  catch { return changed ? work : action; } // non-serializable; bail

  // Same class/reasoning as `effectiveKeys`/`effectiveValuePatterns` above: a
  // non-array `envVars` used to iterate a string's characters as bogus env-var
  // names (silently wrong, no crash) or throw "is not iterable" for a
  // non-iterable object — inside `redact()`, which must never throw. Fall
  // back to `[]`; `envVars` has no default set to preserve, but the key-aware
  // walk above and `effectiveValuePatterns` below still run unaffected.
  const envVars = Array.isArray(cfg.envVars) ? cfg.envVars : [];
  for (const varName of envVars) {
    const val = process.env[varName];
    if (!val || val.length < MIN_ENV_VAR_LEN) continue;
    if (serialized.includes(val)) {
      serialized = serialized.split(val).join(`[REDACTED:${varName}]`);
      changed = true;
    }
  }

  for (const re of effectiveValuePatterns(cfg)) {
    // Force global matching: a non-global pattern (a natural config mistake,
    // e.g. /sk-[a-z0-9]+/) would replace only the FIRST match via
    // String.replace, leaving a second secret on the same line in cleartext.
    const g = re.global ? re : new RegExp(re.source, re.flags + "g");
    serialized = serialized.replace(g, (m) => {
      changed = true;
      const prefix = m.slice(0, 4).replace(/[\\"]/g, "_");
      return `[REDACTED:pattern=${prefix}...]`;
    });
  }

  if (!changed) return action;
  try { return JSON.parse(serialized); }
  catch { return work; } // key-walk may have changed even if re-parse fails
}

/**
 * Build the audit redactor for a gate. Returns `null` (no-op fast path) only
 * when the default-on backstop is explicitly disabled AND no explicit secrets
 * config is present; otherwise returns a redactor that applies the defaults.
 * @param {import("../types.js").SecretsConfig} [cfg]
 * @returns {((x: *) => *)|null}
 */
export function makeRedactor(cfg) {
  const c = cfg ?? {};
  const active =
    c.redactKeys !== false ||
    (c.keys?.length ?? 0) > 0 ||
    (c.patterns?.length ?? 0) > 0 ||
    (c.envVars?.length ?? 0) > 0;
  return active ? (x) => redact(x, c) : null;
}
