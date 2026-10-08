// Gate-side rubric state (Module 2): config shape, the in-memory state a Gate keeps
// for a signed rubric, and its cold-start rebuild from the audit. Pure helpers, no
// I/O; gate.js owns the audit writes and the ordering lock. Kept out of rubric.js
// so that module stays the pure core, and out of gate.js to keep it readable.
//
// State that ENFORCES a limit (minted verdicts, red counts, ACCEPTs, seed baselines)
// lives here and is rebuilt from the audit exactly like the budget: a resume never
// resets a count. It is matched by (run_id, rubricSha): a gate constructed with a
// different (or no) stable `runId` starts with FRESH state, by design and stated
// plainly in the docs.

import { isPlainObject } from "./plain-object.js";

const MAX_AUDIT_STR = 160;
const MAX_AUDIT_GAPS = 8;

const blank = (s) => typeof s !== "string" || s.trim() === "";

/**
 * Read the `rubric` config block's SHAPE (not the spec: createRubric does that).
 * Used at construct (throw on !ok) and again at every runtime read site (deny
 * `rubric.invalid` on !ok), the same two-layer pattern as every `<key>.invalid`.
 * @param {*} r the value of `config.rubric`
 * @returns {{ok:true, advanceOn:Set<string>}|{ok:false, why:string}}
 */
export function readRubricConfig(r) {
  try {
    if (!isPlainObject(r)) return { ok: false, why: "rubric must be a plain object { spec, sha256, advanceOn }" };
    for (const k of Object.keys(r)) {
      if (k !== "spec" && k !== "sha256" && k !== "advanceOn") return { ok: false, why: `rubric.${k} is not a recognised key (spec, sha256, advanceOn)` };
    }
    if (!isPlainObject(r.spec)) return { ok: false, why: "rubric.spec must be a plain object" };
    if (blank(r.sha256)) return { ok: false, why: "rubric.sha256 must be the signed fingerprint string" };
    const a = r.advanceOn;
    const list = typeof a === "string" ? [a] : a;
    if (!Array.isArray(list) || list.length === 0 || list.some(blank)) {
      return { ok: false, why: "rubric.advanceOn must be an action type or tool name string (or a non-empty array of non-blank strings)" };
    }
    return { ok: true, advanceOn: new Set(list) };
  } catch {
    return { ok: false, why: "rubric config is unreadable (a getter threw)" };
  }
}

/** @returns {RubricState} */
export function newRubricState(rubric, sha) {
  return {
    rubric, sha,
    verdicts: new Map(), // checkpoint -> { verdict, outputSha }
    reds: new Map(),     // checkpoint -> reds since the last re-sign/ACCEPT
    accepts: new Set(),  // `${checkpoint}\0${outputSha}`
    baselines: new Map(), // `${checkpoint}\0${checkId}` -> { baseline, baselineSource }
    inflight: new Map(),  // acceptKey -> in-flight live-ask promise (never rebuilt)
    gaps: new Map(),     // checkpoint -> worker gaps awaiting drainGaps (NOT rebuilt: ephemeral)
  };
}

export const acceptKey = (checkpoint, outputSha) => `${checkpoint}\0${outputSha}`;
export const baselineKey = (checkpoint, checkId) => `${checkpoint}\0${checkId}`;

/**
 * Replay the audit into `state`. Only lines of THIS run (`run_id`) and THIS signed
 * rubric (`rubricSha`) count: a re-sign is a new sha and starts clean.
 * @param {RubricState} state
 * @param {object[]} lines
 * @param {string} runId
 */
export function rebuildRubricState(state, lines, runId) {
  for (const l of lines) {
    if (l == null || l.run_id !== runId || l.rubricSha !== state.sha) continue;
    const cp = l.checkpoint;
    if (typeof cp !== "string" || !Object.hasOwn(state.rubric.checkpoints, cp)) continue;
    if (l.phase === "rubric") {
      if (l.verdict !== "green" && l.verdict !== "red" && l.verdict !== "stopped") continue;
      state.verdicts.set(cp, { verdict: l.verdict, outputSha: typeof l.outputSha === "string" ? l.outputSha : null });
      if (l.verdict === "red") state.reds.set(cp, (state.reds.get(cp) ?? 0) + 1);
    } else if (l.phase === "rubric_baseline") {
      const k = baselineKey(cp, l.checkId);
      if (typeof l.checkId === "string" && typeof l.baseline === "number" && !state.baselines.has(k)) {
        state.baselines.set(k, { baseline: l.baseline, baselineSource: l.baselineSource ?? null });
      }
    } else if (l.phase === "rubric_accept") {
      if (typeof l.outputSha === "string") state.accepts.add(acceptKey(cp, l.outputSha));
      state.reds.set(cp, 0);
    }
  }
}

/** JSON-safe, string-clipped, array-bounded copy for an audit line (the line cap still applies after redaction). */
export function auditView(v, depth = 0) {
  if (typeof v === "string") return v.length > MAX_AUDIT_STR ? v.slice(0, MAX_AUDIT_STR) + "…" : v;
  if (v === null || typeof v !== "object") return typeof v === "number" || typeof v === "boolean" ? v : v === undefined ? undefined : String(v);
  if (depth > 4) return "[deep]";
  if (Array.isArray(v)) return v.slice(0, MAX_AUDIT_GAPS * 3).map((x) => auditView(x, depth + 1));
  const out = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (k === "__proto__") continue;
    if (++n > 24) break;
    const x = auditView(v[k], depth + 1);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

export function auditGaps(gaps) {
  return { gaps: gaps.slice(0, MAX_AUDIT_GAPS).map((g) => auditView(g)), gapsTotal: gaps.length };
}

/**
 * @typedef {Object} RubricState
 * @property {any} rubric
 * @property {string} sha
 * @property {Map<string,{verdict:string,outputSha:(string|null)}>} verdicts
 * @property {Map<string,number>} reds
 * @property {Set<string>} accepts
 * @property {Map<string,{baseline:number,baselineSource:any}>} baselines
 * @property {Map<string,Promise<any>>} inflight
 * @property {Map<string,object[]>} gaps
 */
