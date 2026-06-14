// flags primitive — gate on a named action FIELD's value (structured, not text).
//
// Mirrors content.js's two-arm split, but reads a named field DIRECTLY off the
// action instead of matching a RegExp over JSON.stringify(action):
//   - deny outcomes resolve at step 2 (universal deny, before the allowlist)
//   - ask  outcomes resolve at step 4 (universal ask,  before the allowlist)
//
// Config shape: { <field>: { <value>: "deny" | "ask" } }, e.g.
//   flags: { provenance: { web: "ask" }, injectionRisk: { high: "deny" } }
//
// WHY a structured field gate (the §6/§8.2 boundary): a memory adopter (litectx)
// reduces a content verdict to a shape flag on the action — the SOURCE
// (`provenance:"web"`) plus an optional guardrails `injectionRisk:"high"`.
// bareguard's existing levers can't read that: `tools.allowlist` keys on
// `action.type`, `content.*` regexes `JSON.stringify(action)`. Forcing the flag
// through the regex route would make the consumer serialize its verdict into
// matchable text. Reading `action[field]` directly keeps the verdict structured:
// litectx states the source, bareguard's policy renders deny/ask.
//
// A flag only ever RESTRICTS — outcomes are deny | ask, never allow (`allow`
// stays the default fall-through). An absent field, an unconfigured field, or a
// value with no mapping is a no-op (like net/bash on a non-matching action.type).

/**
 * Scan the configured fields for one whose value on the action maps to
 * `wantOutcome`. First match wins (config insertion order).
 * @param {object} action action being evaluated (field read directly, not serialized)
 * @param {Object<string, Object<string, "deny"|"ask">>|undefined} cfg flags config (may be undefined)
 * @param {"deny"|"ask"} wantOutcome which arm is asking (deny → step 2, ask → step 4)
 * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} decision, or null if no match
 */
function flagsCheck(action, cfg, wantOutcome) {
  if (!cfg) return null;
  for (const field of Object.keys(cfg)) {
    const valueMap = cfg[field];
    if (!valueMap) continue;
    const v = action[field];
    if (v == null) continue;                 // field absent → no-op
    // Only a primitive value can be a configured map key. Skip objects/arrays
    // (incl. a hostile `toString`/`Symbol.toPrimitive` that would throw when
    // coerced to a property key) rather than index with them — keeps the lookup
    // total and the gate decision exception-free on a malformed field.
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    const key = String(v);
    // OWN keys only — a non-own lookup would read an inherited property, so a
    // polluted `Object.prototype` (e.g. `Object.prototype.web = "ask"`) could
    // make a flag fire on an empty/unconfigured value-map. Honor only what the
    // operator actually configured.
    if (!Object.hasOwn(valueMap, key)) continue; // absent / inherited → no-op
    if (valueMap[key] !== wantOutcome) continue; // the other arm's outcome
    return {
      outcome: wantOutcome === "deny" ? "deny" : "askHuman",
      severity: "action",
      rule: `flags.${field}`,
      reason: `${field}=${v} → ${wantOutcome}`,
    };
  }
  return null;
}

/**
 * Step-2 structured deny: an action field's value maps to `"deny"`.
 * @param {object} action action being evaluated
 * @param {Object<string, Object<string, "deny"|"ask">>} [cfg] flags config
 * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} deny decision, or null
 */
export function flagsDenyCheck(action, cfg) {
  return flagsCheck(action, cfg, "deny");
}

/**
 * Step-4 structured ask: an action field's value maps to `"ask"` (fires even on
 * allowlisted tools).
 * @param {object} action action being evaluated
 * @param {Object<string, Object<string, "deny"|"ask">>} [cfg] flags config
 * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} askHuman decision, or null
 */
export function flagsAskCheck(action, cfg) {
  return flagsCheck(action, cfg, "ask");
}
