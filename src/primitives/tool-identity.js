// `action.tool` — an identity field separate from `action.type`, agreed with
// bare-agent.
//
// - `type` is the action KIND (read/write/edit/bash/net/spawn/defer/llm/…):
//   kind checks (fs, bash, net, spawn, defer) stay on `type` only, unchanged
//   — `tool` never affects which primitive applies.
// - `tool` is an optional identity for the ALLOW-side lookups that used to
//   read `action.type` as a stand-in for "which tool": `tools.allowlist`,
//   the rwx tools-map row, and the key `tools.denyArgPatterns` is looked up
//   under. Identity = `action.tool ?? action.type`.
// - DENY-side checks (`tools.denylist`, `tools.denyArgPatterns`) must never
//   get WEAKER because `tool` is present: they match if EITHER `tool` OR
//   `type` matches. Adding `tool` can only ADD deny surface, never remove it.
// - `tool` present but not a non-empty string -> deny, fail closed, rule
//   `tools.invalidTool` — ONE name whether `tools` or `rwx` is the primitive
//   evaluating it (`action.tool` is one shared field, not owned by either).
// - `tool: null` is treated the SAME as absent (falls back to `type`) — this
//   mirrors the existing convention elsewhere in this codebase that `null`
//   reads as "caller didn't set this" (e.g. `fs.js`'s `raw != null` treats
//   `null`/`undefined` alike). `tool: ""` is different: it's a PRESENT value
//   that can never be a real tool name, so it denies, same as any other
//   non-string/empty value. This is a judgment call (an upstream bug that
//   accidentally sends `tool: null` falls back to today's shipped `type`-only
//   behavior rather than denying outright) — chosen because `type`-only can
//   never be a NEW hole, it's exactly what every action did before this field
//   existed.

/**
 * @param {*} raw `action.tool`
 * @returns {{ok:true,present:boolean}|{ok:false}}
 */
function validateToolField(raw) {
  if (raw === undefined || raw === null) return { ok: true, present: false };
  if (typeof raw !== "string" || raw === "") return { ok: false };
  return { ok: true, present: true };
}

const INVALID_TOOL_DENY = Object.freeze({
  outcome: "deny", severity: "action", rule: "tools.invalidTool",
});

/**
 * Identity for ALLOW-side lookups: `action.tool ?? action.type`.
 * @param {object} action
 * @returns {{ok:true,identity:*}|{ok:false,decision:object}}
 */
export function resolveIdentity(action) {
  const v = validateToolField(action?.tool);
  if (!v.ok) {
    return { ok: false, decision: { ...INVALID_TOOL_DENY, reason: `action.tool is not a non-empty string (type ${typeof action?.tool})` } };
  }
  return { ok: true, identity: v.present ? action.tool : action?.type };
}

/**
 * The keys a DENY-side check must test: `type` always, plus `tool` when
 * present, valid, and different from `type`. Never fewer than one key. A bad
 * `tool` value denies outright (fail closed) — same polarity as
 * `resolveIdentity`.
 * @param {object} action
 * @returns {{ok:true,keys:string[]}|{ok:false,decision:object}}
 */
export function resolveDenyKeys(action) {
  const v = validateToolField(action?.tool);
  if (!v.ok) {
    return { ok: false, decision: { ...INVALID_TOOL_DENY, reason: `action.tool is not a non-empty string (type ${typeof action?.tool})` } };
  }
  const keys = v.present && action.tool !== action.type ? [action?.type, action.tool] : [action?.type];
  return { ok: true, keys };
}

/**
 * Never-throwing, never-denying identity lookup for pure accrual/snapshot
 * paths that must not fail an action on a bad `tool` value (e.g.
 * `matchRwxLetter`'s budget accrual, and the check/add race snapshot) — an
 * unusable `tool` simply falls back to `type`, same as absent.
 * @param {*} action
 * @returns {*} `action.tool` when it's a non-empty string, else `action.type`
 */
export function looseIdentity(action) {
  const raw = action?.tool;
  if (typeof raw === "string" && raw !== "") return raw;
  return action?.type;
}
