// Gate — the orchestrator. Single decision path through PRE-EVAL halt checks
// then the 6-step eval order (PRD v0.5 §3). Calls humanChannel for ask/halt
// events; applies the human decision atomically; returns terminal allow/deny.

import { randomUUID } from "node:crypto";
import { Audit, defaultAuditPath } from "./primitives/audit.js";
import { Budget, sanitizeSpend } from "./primitives/budget.js";
import { Limits } from "./primitives/limits.js";
import { redact, makeRedactor } from "./primitives/secrets.js";
import { bashCheck } from "./primitives/bash.js";
import { bashClassifyCheck } from "./primitives/classify.js";
import { fsCheck } from "./primitives/fs.js";
import { netCheck } from "./primitives/net.js";
import {
  toolsDenylistCheck, toolsDenyArgsCheck, toolsAllowlistCheck,
} from "./primitives/tools.js";
import { assertRwxConfig, rwxCheck, matchRwxLetter, resolveAgentLetters, clampLetters, normalizeEntry } from "./primitives/rwx.js";
import { contentDenyCheck, contentAskCheck } from "./primitives/content.js";
import { flagsDenyCheck, flagsAskCheck } from "./primitives/flags.js";
import { deferRateCheck } from "./primitives/defer-rate.js";
import { spawnRateCheck } from "./primitives/spawn-rate.js";

const MAX_TOPUP_ITERATIONS = 5;

function structuredError(decision, action) {
  return {
    error: {
      type: "policy_denied",
      rule: decision.rule,
      severity: decision.severity,
      reason: decision.reason ?? null,
      action_summary: actionSummary(action),
    },
  };
}

function actionSummary(action) {
  if (!action) return "(no action)";
  try {
    const s = JSON.stringify(action);
    return s.length > 200 ? s.slice(0, 197) + "..." : s;
  } catch {
    return `[unserializable action.type=${action.type}]`;
  }
}

/**
 * Normalize an action to OWN properties only — a null-prototype shallow copy
 * (plus a null-proto `args`). Every eval step reads `action.<field>` or
 * `action.args.<field>` directly, so without this a polluted `Object.prototype`
 * (e.g. `Object.prototype.type = "bash"`) could inject a field the action never
 * declared and flip a decision — including deny→allow on the allowlist. Applied
 * once at each public entry (`check`/`allows`/`record`/`run`) so the decision,
 * the audit line, the humanChannel event, and what `run` executes all see the
 * same inheritance-free action. Shallow (top-level + `args`) is sufficient: no
 * primitive reads deeper. ~0.2µs/call; idempotent. Complete-mediation, applied
 * at the chokepoint — no primitive needs to change.
 * @param {import("./types.js").Action} action the action to normalize
 * @returns {import("./types.js").Action} a null-prototype shallow copy (own props preserved)
 */
// `Object.assign` READS every own enumerable property, which invokes getters —
// so a field defined as a getter that throws killed this function, and with it
// `check()`, before a single eval step ran. Copy key by key instead and mark the
// one field that cannot be read, so the other fields still reach the floors: a
// broken `action.debug` must not stop `bash.denyPatterns` seeing `args.command`.
// Marked rather than dropped — a dropped key is indistinguishable from a key the
// caller never sent, and this is the one shape where the gate genuinely does not
// know what it was handed.
const UNREADABLE = "[UNREADABLE]";
function copyOwnSafely(src) {
  const out = Object.create(null);
  for (const k of Object.keys(src)) {
    try { out[k] = src[k]; } catch { out[k] = UNREADABLE; }
  }
  return out;
}

function safeAction(action) {
  if (action == null || typeof action !== "object") return action;
  // `Object.keys` itself can throw on a revoked Proxy — there is no readable
  // action left at that point, so hand back an empty own-props object and let
  // the floors decide on nothing (tools' closed allowlist denies an absent
  // `type`), rather than throwing out of the gate.
  let safe;
  try { safe = copyOwnSafely(action); } catch { return Object.create(null); }
  let args;
  try { args = action.args; } catch { args = undefined; }
  if (args != null && typeof args === "object") {
    try { safe.args = copyOwnSafely(args); } catch { safe.args = UNREADABLE; }
  }
  return safe;
}

/**
 * Pure Axis-B routing (§6.6/§8.2.2): a fact's surface flag × the gated action's
 * reversibility × the operator's escalation knob → where the fact goes. No LLM,
 * no side effects. `surface` comes from the caller-computed judge verdict
 * (`broke` ⇒ true); `reversible` is read from the GATED ACTION's type via the
 * operator's config — never the fact, the agent, or the model.
 * @param {boolean} surface  true if the answer did NOT honor the request
 * @param {boolean} reversible  true if the gated action's type is operator-declared undoable
 * @param {"strict"|"relaxed"} [knob]  operator knob; default "strict"
 * @returns {"pass"|"annotate-floor-ask"|"HITL"|"log"}
 *   pass = audit only · annotate-floor-ask = rides A's already-happening stop ·
 *   HITL = rides A's next ask · log = audit + agent-feedback only (no human)
 * @when Only when you are building the Axis-B path by hand and need to know where a fact WOULD go before you pay to compute it. `gate.annotate()` already routes internally, so most callers never call this directly.
 * @category axis-b
 * @fails Never throws and has no side effects — it is a pure four-way lookup over three booleans. Any `knob` value other than `"strict"` behaves as `"relaxed"`.
 * @example
 * import { routeAnnotation } from "bareguard";
 * routeAnnotation(true, false);            // "annotate-floor-ask" — irreversible + broke
 * routeAnnotation(true, true, "relaxed"); // "log" — reversible + broke, no human
 */
export function routeAnnotation(surface, reversible, knob = "strict") {
  if (!surface) return reversible ? "pass" : "annotate-floor-ask"; // honored
  if (!reversible) return "annotate-floor-ask";        // irreversible broke: rides A's stop
  return knob === "strict" ? "HITL" : "log";           // reversible broke: strict rides, relaxed logs
}

/**
 * Why a fact cannot be read as an annotation — or `null` when it is well-formed.
 * The rule is one line: `surface` must be an EXPLICIT boolean. It is the only
 * load-bearing (and only non-optional) field, so a caller who sets it is speaking
 * the contract and a caller who doesn't is speaking a different dialect — an array,
 * the retired pre-E6 sketch, `{}`, or a typo. Without the rule all of those
 * normalize to a fact byte-identical to a legitimate `honored` one, i.e. "I could
 * not read what you sent" and "everything was fine" share a value (fail-open).
 * Takes `surface` as an ARGUMENT rather than re-reading it: the value validated
 * here must be the identical value that gets stored, or a getter answering
 * differently on a second read slips past the check (see normalizeAnnotation).
 * Reading it can also throw (a getter, a Proxy trap, a revoked Proxy), so the
 * read and this check both sit inside readAnnotation's try/catch.
 * @param {*} fact
 * @param {*} surface  the already-read `fact.surface`
 * @returns {"not-an-object"|"array"|"missing-surface"|null}
 */
function annotationDefect(fact, surface) {
  if (fact == null || typeof fact !== "object") return "not-an-object";
  if (Array.isArray(fact)) return "array";           // typeof [] === "object"
  if (typeof surface !== "boolean") return "missing-surface";
  return null;
}

/**
 * Normalize a well-formed fact, bounding each field at the source so an annotate
 * audit line stays well under the audit's PIPE_BUF line cap (atomic shared-file
 * appends): `where`/`meta` are reply-derived and otherwise unbounded. This also
 * bounds what reaches the human/agent — `where` is a one-line summary by design.
 * Every read here is caller-controlled and may throw, so it runs inside
 * {@link readAnnotation}'s try/catch — which is also where `surface` was read.
 * @param {*} fact
 * @param {*} surface  `fact.surface` as already read by {@link readAnnotation};
 *   taken as a parameter, never re-read, so the validated value is the stored one
 * @returns {import("./types.js").Annotation}
 */
function normalizeAnnotation(fact, surface) {
  // Each caller field is read into a local ONCE and only the local is used after.
  // Re-reading `fact.x` to test it and again to store it is a TOCTOU seam: a getter
  // that answers differently on the second call validates as one value and lands as
  // another. `surface` is the dangerous one — `=== true` coerces silently, so the
  // divergence is toward `false`/"honored"/invisible, i.e. the exact fail-open this
  // rejection rule exists to close, reachable straight through the guard.
  const verdict = fact.verdict;
  const where   = fact.where;
  return {
    surface: surface === true,
    verdict: typeof verdict === "string" ? verdict.slice(0, 80)  : null,
    where:   typeof where   === "string" ? where.slice(0, 300)   : null,
    meta:    boundMeta(fact.meta),
  };
}

/**
 * Read a caller-supplied annotation fact WITHOUT EVER THROWING — the single place
 * every property of `fact` is touched. Both the shape check and the normalization
 * live inside the guard, because a getter / Proxy trap can throw on any of them
 * (`surface` during the check, `verdict`/`where`/`meta` during the normalize);
 * guarding only the first is a half-fix that still breaks the agent loop. A throw
 * becomes the `"unreadable"` defect and the fact is rejected WHOLE — half-read is
 * not "everything was fine", the same conflation the rejection rule exists to kill.
 * @param {*} fact
 * @returns {{defect: "not-an-object"|"array"|"missing-surface"|"unreadable", norm: null}
 *   | {defect: null, norm: import("./types.js").Annotation}}
 */
function readAnnotation(fact) {
  try {
    // `surface` is read here, ONCE, and the same value is both validated and stored.
    const surface = fact == null ? undefined : fact.surface;
    const defect = annotationDefect(fact, surface);
    return defect ? { defect, norm: null } : { defect: null, norm: normalizeAnnotation(fact, surface) };
  } catch {
    return { defect: "unreadable", norm: null };
  }
}

/**
 * Bound an annotation `meta` object so an annotate audit line can't exceed the
 * audit's atomic-append cap. Non-objects → null; oversized / unserializable →
 * a small marker that replaces it everywhere downstream (buffer / event / drain).
 * Under the cap the fact carries a DECOUPLED COPY, not the caller's object — the
 * caller keeps their original and can mutate it freely without moving the bound.
 * @param {*} meta
 * @returns {object|null}
 */
function boundMeta(meta) {
  if (meta == null || typeof meta !== "object") return null;
  try {
    const json = JSON.stringify(meta);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > 1000) return { _truncated: true, bytes };
    // DECOUPLE from the caller's object. Returning `meta` itself made the cap
    // undoable: a judge that kept appending evidence to the object it had already
    // handed over grew the drained/event fact past 1000 bytes AFTER the bound ran,
    // while the audit row (serialized at emit time) kept the small version — so the
    // two sinks silently disagreed. A round-trip through the JSON we already
    // computed costs nothing extra and makes the bound a fact, not a request.
    // Drop any `__proto__` KEY while copying, at every depth. `JSON.parse` creates
    // it as an ordinary own property rather than setting the prototype, so it is
    // inert here — but it stays inert only until a consumer merges the fact
    // (`Object.assign({}, fact.meta)`, a spread), which DOES set the prototype of
    // the merged object. `meta` is reply-derived, i.e. the least trusted data in
    // the gate, so it gets the same treatment `safeAction()` gives an action.
    const copy = JSON.parse(json, (k, v) => (k === "__proto__" ? undefined : v));
    // A `meta` whose toJSON yields a scalar (e.g. a bare Date) cannot be carried
    // structurally at all; that is the existing total-loss marker, not a new one.
    return copy !== null && typeof copy === "object" ? copy : { _unserializable: true };
  } catch {
    return { _unserializable: true };
  }
}

/**
 * §23.21: the size cap `gate.add()` enforces on `rwx.tools`. Landing exactly
 * at this many keys is fine; only a batch that would push the map PAST it
 * refuses (throws, nothing lands) — there is no separate gate-wide
 * poisoned-past-cap state, since `add()` is the only way the map grows.
 * @type {number}
 */
const RWX_TOOLS_CAP = 10000;

/**
 * Letter rank for `gate.add()`'s tighten-only check (§23.21): a letter can
 * only rise, never fall (`r` < `w` < `x`).
 * @type {Readonly<{r:number,w:number,x:number}>}
 */
const RWX_LETTER_RANK = Object.freeze({ r: 0, w: 1, x: 2 });

/**
 * Deep, decoupled copy of an already construct-time-validated `rwx` config
 * (§23.21) — closes the live-reference hole where mutating the caller's
 * original `rwx.tools`/`bash`/`agents` object AFTER construction changed a
 * running gate's decisions (every eval step reads `this.cfg.rwx` by
 * reference). A JSON round-trip is sufficient because `assertRwxConfig` has
 * already required every legal `rwx` value to be JSON-shaped (strings, or
 * plain `{letter,marker}` objects); `__proto__` is stripped at every depth
 * in the reviver, the same treatment {@link boundMeta} gives reply-derived
 * `meta`. `rwx` is operator-authored config (not agent-reachable input), so
 * a construct-time throw on an unserializable value (e.g. a circular
 * reference) is the right failure mode — the same posture as every other
 * construct-time config validator in this file.
 * @param {object} rwx already-validated rwx config
 * @returns {object} a decoupled deep copy
 */
function deepCopyRwx(rwx) {
  try {
    return JSON.parse(JSON.stringify(rwx), (k, v) => (k === "__proto__" ? undefined : v));
  } catch (err) {
    throw new Error(`invalid bareguard config: rwx could not be deep-copied at construct time (${err.message})`);
  }
}

/**
 * Best-effort key list for an `add()` batch that failed before it could be
 * safely snapshotted (a bad shape, or a rejection raised before `add()` even
 * reads `entries`) — used only for the `rwx.add_rejected` audit line's
 * `keys` field, never for anything that decides what lands. Never throws.
 * @param {*} entries the raw `add()` argument
 * @returns {string[]}
 */
function attemptedRwxKeys(entries) {
  try { return (entries && typeof entries === "object") ? Object.keys(entries) : []; }
  catch { return []; }
}

/**
 * §23.21 decision 5 (check()/add() race fix) — a JSON-stable snapshot of the
 * ONE tools-map entry a given action would match, or a sentinel for "not
 * applicable": `undefined` for a `bash` action (`add()` only ever touches
 * `rwx.tools`, never `rwx.bash`, so a bash action's match can never have
 * changed — structurally exempt) or when `rwxCfg` isn't usable; `null` for
 * an action type absent from the tools map ("unlisted"). Module-level (not
 * a `check()`-local closure) so it can be called from BOTH `check()` (the
 * default, top-of-iteration baseline) and `_stepEval` (the precise,
 * same-tick overwrite taken exactly when step 5 reads the map) — see
 * `check()`'s race-snapshot comment for why both call sites exist.
 * @param {*} rwxCfg `cfg.rwx`
 * @param {object} action the action being evaluated
 * @returns {string|null|undefined}
 */
function rwxToolsEntrySnapshot(rwxCfg, action) {
  if (action?.type === "bash") return undefined;
  if (!isPlainObject(rwxCfg)) return null;
  const toolsMap = isPlainObject(rwxCfg.tools) ? rwxCfg.tools : {};
  if (!Object.prototype.hasOwnProperty.call(toolsMap, action?.type)) return null; // "absent"
  // A JSON-stable string is enough to compare "did THIS key's raw value
  // change at all" — the exact shape doesn't matter, only equality.
  try { return JSON.stringify(toolsMap[action.type]); }
  catch { return "[unserializable]"; }
}

/**
 * The single chokepoint every agent action passes through. Construct once per
 * run, `await gate.init()`, then call {@link Gate#check} / {@link Gate#record}
 * (or {@link Gate#run}) for each action. Runs PRE-EVAL halt checks then the
 * 6-step eval order, resolves ask/halt events via `humanChannel`, and returns
 * terminal allow/deny decisions. See README.md and bareguard.context.md for
 * wiring recipes.
 */

/**
 * Config keys that MUST be arrays when present. A non-array in any of them was
 * never validated, and produced four different silent wrongs: a replaced
 * safe-default deny floor (fail OPEN), a string iterated per-character so one
 * entry matched everything (deny ALL), a throw out of the gate mid-action, or a
 * runtime deny. Validate once, loudly, where the operator can see it — matching
 * `budget`, which already throws on an invalid resource cap or softRatio.
 * @type {ReadonlyArray<[string, string]>}
 */
const ARRAY_SHAPED_CONFIG = Object.freeze([
  ["tools", "allowlist"], ["tools", "denylist"],
  ["content", "denyPatterns"], ["content", "askPatterns"],
  ["fs", "deny"], ["fs", "readScope"], ["fs", "writeScope"],
  ["net", "allowDomains"],
  ["bash", "allow"], ["bash", "denyPatterns"],
  ["bash", "extraDestructive"], ["bash", "extraSuperDestructive"],
  ["secrets", "keys"], ["secrets", "patterns"], ["secrets", "envVars"],
  ["axisB", "reversible"],
]);

/**
 * Bound a caller-supplied config key before it is interpolated into an error
 * message. Errors are not redacted and not size-capped by anything downstream.
 * @param {string} k config key
 * @returns {string} the key, clipped
 */
function clipKey(k) {
  const s = String(k);
  return s.length > 64 ? s.slice(0, 64) + "…" : s;
}

/**
 * True for a plain object — `{}`-literal shaped, or the null-prototype shape
 * `safeAction()` deliberately produces gate-wide (0.6.0) — and false for
 * everything else a config section must not be: an array, a string/number/
 * boolean (primitives coerce through `Object.getPrototypeOf` to their wrapper
 * prototype, e.g. `String.prototype`, never `Object.prototype`), or an exotic
 * object like `Map`/`Set`/`Date`. The prior guard at each of these three call
 * sites was `typeof s !== "object" || Array.isArray(s)`, which a `Map` passes
 * (`typeof` is `"object"`, it is not an `Array`) — so `new Gate({ tools: new
 * Map([["allowlist",["x"]]]) })` constructed with no error, and `s["allowlist"]`
 * on a Map is always `undefined` (Map entries are not own properties), reading
 * as "unconfigured" — full fail-OPEN, same failure as the string-section bug
 * this replaces, just a different exotic type slipping through the same hole.
 * One structural check closes the whole family (Map, Set, Date, anything else
 * with a foreign prototype) instead of enumerating bad types one at a time.
 * @param {*} v value to check
 * @returns {boolean} true if `v` is a plain object (Object.prototype or null prototype)
 */
function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Throw if any array-shaped config key is present but not an array.
 * `undefined`/`null` mean "not configured" and are left alone; `[]` is a legal
 * array (an empty scope, or the documented pure-allow opt-out).
 * @param {object} config gate config
 * @returns {void}
 */
function assertArrayShapedConfig(config) {
  // `tools.denyArgPatterns` is the one config surface that is a MAP of arrays
  // rather than an array, so the flat [section, key] model above cannot express
  // it. Its per-tool values are as array-shaped as any key in that list, and the
  // natural authoring slip — one pattern, forgotten wrapper — threw
  // `patterns is not iterable` out of check() mid-action.
  const dap = config?.tools?.denyArgPatterns;
  if (dap !== undefined && dap !== null) {
    if (!isPlainObject(dap)) {
      throw new Error(
        `invalid bareguard config: tools.denyArgPatterns must be an object mapping tool name to an array of patterns, got ${Array.isArray(dap) ? "array" : typeof dap === "object" ? dap.constructor?.name ?? "object" : typeof dap}`,
      );
    }
    for (const [tool, patterns] of Object.entries(dap)) {
      if (patterns === undefined || patterns === null) continue;
      if (!Array.isArray(patterns)) {
        // The key is interpolated into the message, so bound it. A config key
        // can be built programmatically from an upstream tool registry, and a
        // thrown Error is NOT routed through the audit redactor — an unbounded
        // key would carry arbitrary caller data into whatever logs construction
        // failures. Measured unbounded: a 2,000,000-char key produced a
        // 2,000,077-char message.
        throw new Error(
          `invalid bareguard config: tools.denyArgPatterns.${clipKey(tool)} must be an array, got ${typeof patterns}`,
        );
      }
    }
  }

  // `flags` is the second MAP-shaped config surface (§8.2, litectx's gate for
  // poisoned memory writes) and — unlike `denyArgPatterns` — had NO
  // construction-time check at all before this: `new Gate({ flags: "oops" })`
  // constructed silently and then every `flags.*` rule silently no-opped
  // forever (see `flagsCheck`'s runtime guard for the full story). Two levels
  // to validate, same as `denyArgPatterns`: the top-level map itself, and each
  // field's nested value→outcome map (`{ provenance: "deny" }` is a natural
  // authoring slip for `{ provenance: { web: "deny" } }` and is just as silent
  // a no-op as the top-level case).
  const flagsCfg = config?.flags;
  if (flagsCfg !== undefined && flagsCfg !== null) {
    if (!isPlainObject(flagsCfg)) {
      throw new Error(
        `invalid bareguard config: flags must be an object mapping field name to a value->outcome map, got ${Array.isArray(flagsCfg) ? "array" : typeof flagsCfg === "object" ? flagsCfg.constructor?.name ?? "object" : typeof flagsCfg}`,
      );
    }
    for (const [field, valueMap] of Object.entries(flagsCfg)) {
      if (valueMap === undefined || valueMap === null) continue;
      if (!isPlainObject(valueMap)) {
        // Key bounded before interpolation — same reasoning as `denyArgPatterns.${clipKey(tool)}` above.
        throw new Error(
          `invalid bareguard config: flags.${clipKey(field)} must be an object mapping value to "deny"|"ask", got ${Array.isArray(valueMap) ? "array" : typeof valueMap === "object" ? valueMap.constructor?.name ?? "object" : typeof valueMap}`,
        );
      }
    }
  }

  for (const [section, key] of ARRAY_SHAPED_CONFIG) {
    const s = config?.[section];
    if (s === undefined || s === null) continue;
    // A section that is present but not a plain object (a string, a number, an
    // array, or an exotic object like `Map`/`Set`/`Date`) used to be treated
    // the same as "not configured" — `continue`d past silently. First found
    // with a string (`typeof s !== "object"` is also true for the legitimate
    // "absent" case): `new Gate({ tools: "search", fs: "/etc" })` constructed
    // with no error and then evaluated every action as `rule:"default",
    // outcome:"allow"`. Then found AGAIN with a `Map` after the string fix
    // shipped (`typeof` a Map is `"object"` and it is not an `Array`, so the
    // old `typeof s !== "object" || Array.isArray(s)` check let it straight
    // through): `s[key]` on a string OR a Map both read as a named property
    // lookup that is always `undefined` (a Map's entries are not its own
    // properties), so the leaf-level check below never sees either shape at
    // all — full fail-OPEN for a config typo either way. `isPlainObject`
    // closes the whole family in one check instead of enumerating bad types
    // one at a time. Same shape check `tools.denyArgPatterns`/`flags` use above.
    if (!isPlainObject(s)) {
      throw new Error(
        `invalid bareguard config: ${section} must be a plain object, got ${Array.isArray(s) ? "array" : typeof s === "object" ? s.constructor?.name ?? "object" : typeof s}`,
      );
    }
    const v = s[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) {
      throw new Error(
        `invalid bareguard config: ${section}.${key} must be an array, got ${typeof v}`,
      );
    }
  }
}

export class Gate {
  /**
   * @param {import("./types.js").GateConfig & { _clock?: () => number }} [config]
   *   Gate configuration. `_clock` is a millisecond clock override for tests.
   * @signature new Gate(config?: GateConfig)
   * @when Start here — this IS the chokepoint. Construct one per agent run, `await init()`, then `check()` every action before it runs and `record()` what it cost. Every other export in this package is a piece of this or a helper around it.
   * @category gate
   * @fails Throws at CONSTRUCTION on malformed config — a section that is not a plain object, or an array-shaped key (`tools.allowlist`, `bash.denyPatterns`, …) that is not an array. A config typo fails CLOSED rather than silently gating nothing. After construction a policy stop is a returned `outcome`, never a throw; `check()` resolves to a terminal allow/deny and never returns `askHuman` (it resolves that internally through `humanChannel`).
   * @example
   * import { Gate } from "bareguard";
   * const gate = new Gate({
   *   tools:  { allowlist: ["bash", "read"] },
   *   bash:   { allow: ["git", "ls"] },
   *   budget: { maxCostUsd: 5.00 },
   *   humanChannel: async (event) => ({ decision: "allow" }),
   * });
   * await gate.init();
   * const action = { type: "bash", args: { command: "git status" } };
   * const decision = await gate.check(action);
   * if (decision.outcome === "allow") await gate.record(action, { costUsd: 0.01 });
   */
  constructor(config = {}) {
    assertArrayShapedConfig(config);
    assertRwxConfig(config); // §23.2: rwx is a second mode, mutually exclusive with tools.allowlist/bash.allow
    // §23.21: the gate copies `rwx` at construct time, deep and decoupled —
    // every other section is still held by reference (unchanged), but rwx
    // alone gets this treatment because `gate.add()` needs a private map it
    // owns to mutate, and because a caller mutating their own `rwx.tools`
    // object post-construct must no longer be able to flip a running gate's
    // decisions (the hole §23.21 exists to close). `config` itself is never
    // mutated by `add()` — only this private copy is.
    this.cfg = config.rwx != null ? { ...config, rwx: deepCopyRwx(config.rwx) } : config;
    this.runId = config.runId ?? randomUUID();
    this.parentRunId = config.parentRunId ?? process.env.BAREGUARD_PARENT_RUN_ID ?? null;
    this.spawnDepth = config.spawnDepth ?? +(process.env.BAREGUARD_SPAWN_DEPTH ?? 0);
    this.rootRunId = config.rootRunId ?? process.env.BAREGUARD_ROOT_RUN_ID ?? this.parentRunId ?? this.runId;

    // audit.path: null is an explicit opt-in to fileless in-memory mode
    // (B4, v0.4). Use `audit.path === undefined`-style fall-through to env
    // / default; only an explicit `null` triggers fileless.
    const auditPath = (config.audit && "path" in config.audit)
      ? config.audit.path
      : (process.env.BAREGUARD_AUDIT_PATH ?? defaultAuditPath(this.rootRunId));
    this._clock = config._clock ?? (() => Date.now());
    this.audit = new Audit({
      filePath: auditPath, runId: this.runId,
      parentRunId: this.parentRunId, spawnDepth: this.spawnDepth,
      rootRunId: this.rootRunId, clock: this._clock,
      // Auto-redact persisted action/result. The key-aware backstop (BG-1) is
      // DEFAULT-ON, so even a caller that never sets `secrets` won't leak a
      // `_ctx.provider.apiKey` to disk; explicit `secrets` layers on top. Eval
      // still sees the real action (redaction is audit-only). `null` only when
      // the backstop is explicitly disabled with no other secrets config.
      redact: makeRedactor(config.secrets),
    });

    const sharedFile = config.budget?.sharedFile ?? process.env.BAREGUARD_BUDGET_FILE ?? null;
    this.budget = new Budget({ ...config.budget, sharedFile });
    this.limits = new Limits({ ...config.limits, startingDepth: this.spawnDepth });

    this.humanChannel = config.humanChannel ?? null;
    this.humanChannelTimeoutMs = config.humanChannelTimeoutMs ?? null;
    this.terminated = false;
    this._initialized = false;
    // Memoized in-flight init() promise: two concurrent first callers (e.g.
    // two `check()`s racing on the `!this._initialized` guard) must share
    // ONE init run, not each kick off their own audit.init()/budget.init()
    // (the latter's cold-start rebuild reads the whole audit log and writes
    // the shared budget file — two concurrent runs are a lost-update race,
    // not a safe no-op). Cleared on failure so the next call retries fresh;
    // every waiter on a failed init sees the SAME rejection.
    this._initPromise = null;
    // Axis B (§6.6/§8.2): buffered return-time-judge facts awaiting a human ask
    // to ride / an agent-feedback drain. Empty unless the caller calls annotate().
    this._annotations = [];
    // §23.21 decision 5: bumped once per successfully-landed `add()` batch.
    // `check()` snapshots this before awaiting a human decision and, if it
    // changed by the time a human "allow" is about to be returned, re-checks
    // rwx fresh (the check()/add() race fix) — gated on this counter so the
    // common case (no concurrent add()) costs nothing and an ordinary
    // `askOn:"loose"` ask-then-allow stays byte-identical.
    this._addGeneration = 0;
    // §23.21 "check and audit in the same logical order" — ONE ordering
    // lock, shared by `add()` (its whole `_addOnce`: validate → audit →
    // mutate) and by `check()`'s final commit (`_commitDecision`: possibly
    // downgrade an allow → write exactly one final audit line). Uncontended
    // acquisition proceeds immediately (a promise chain whose head is
    // already resolved); contended acquisition waits its turn, in call
    // order. A throw from the locked function never wedges it — see
    // `_withLock`'s own `finally`. This is what makes the audit log's line
    // order the TRUE order: whichever of a `check()`'s final commit or an
    // `add()`'s mutation acquires the lock first is unambiguously "first,"
    // and the other sees its effects (or doesn't) consistently with that.
    this._gateLock = Promise.resolve();
  }

  /**
   * §23.21 "check and audit in the same logical order" — run `fn` with
   * exclusive access to the gate's ordering lock. Every caller links onto
   * the previous caller's queue token and awaits it before running its own
   * `fn`; the token this call hands to the NEXT caller always resolves —
   * never rejects — regardless of whether `fn` threw, so one failing call
   * can never wedge the lock for whatever comes after it. Shared by `add()`
   * (`_addOnce` runs inside it) and `check()`'s final commit
   * (`_commitDecision` runs inside it) — nothing else acquires it.
   * @template T
   * @param {() => (T|Promise<T>)} fn
   * @returns {Promise<T>}
   */
  async _withLock(fn) {
    const previous = this._gateLock;
    let releaseNext = (_value) => {}; // always overwritten synchronously below; the no-op default is only to satisfy TS's definite-assignment check
    this._gateLock = new Promise((resolve) => { releaseNext = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      releaseNext();
    }
  }

  /**
   * Initialize audit and budget subsystems (idempotent; auto-called by check/allows/record/etc.).
   * Concurrent first callers share a single in-flight init (memoized on
   * `_initPromise`) rather than each independently running audit.init()/
   * budget.init() — the latter's cold-start rebuild reads the whole audit
   * log and writes the shared budget file, so two concurrent runs race on
   * that write instead of being a safe no-op. A failed init clears the
   * memo so the next call retries; every waiter on that failed init sees
   * the same rejection.
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await this.audit.init();
      await this.budget.init({
        rebuildFromAudit: async () => {
          const rebuilt = await this._rebuildBudgetFromAudit();
          this.limits.turns = rebuilt.turns;
          this.limits.toolRounds = rebuilt.toolRounds;
          return rebuilt;
        },
      });
      this._initialized = true;
    })().catch((err) => {
      this._initPromise = null;
      throw err;
    });
    return this._initPromise;
  }

  async _rebuildBudgetFromAudit() {
    const lines = await this.audit.readAll();
    let spentUsd = 0, spentTokens = 0, capUsd = null, capTokens = null, turns = 0, toolRounds = 0;
    for (const l of lines) {
      if (l.phase === "record" && l.result) {
        // Reconstruct spend through the SAME sanitizer live accrual uses, so the
        // rebuild can't diverge: it clamps negatives (else the cap under-counts after
        // a restart) and honors pricing/non-finite (else it over-counts an unpriced
        // round). One source of truth — sanitizeSpend.
        const { dUsd, dTok } = sanitizeSpend(l.result);
        spentUsd    += dUsd;
        spentTokens += dTok;
        turns++;
        if (l.action && l.action.type !== "llm") toolRounds++;
      }
      if (l.phase === "topup") {
        if (l.dimension === "costUsd") capUsd    = l.newCap;
        if (l.dimension === "tokens")  capTokens = l.newCap;
      }
    }
    return { spentUsd, spentTokens, capUsd, capTokens, turns, toolRounds };
  }

  // PRE-EVAL: cross-cutting halt checks (budget exhaustion, maxTurns, terminated).
  _haltCheck() {
    if (this.terminated) {
      return {
        outcome: "askHuman", severity: "halt",
        rule: "gate.terminated", reason: "gate has been terminated",
      };
    }
    return this.budget.check() ?? this.limits.preCheck() ?? null;
  }

  // STEP 1-6 (PRD v0.5 §3). First terminal wins.
  /**
   * @param {object} action
   * @param {{gen:number, entry:(string|null|undefined)}} [raceSnapshot]
   *   §23.21 decision 5 out-parameter, mutated in place. `check()` seeds it
   *   with a default (the top-of-iteration generation + entry, used as-is
   *   when step 5 below never runs — an earlier step already denied/asked).
   *   If step 5 DOES run, it overwrites both fields with a read taken in the
   *   exact same synchronous tick as `rwxCheck` itself — more precise than
   *   the default, because steps 3/3b (`deferRateCheck`/`spawnRateCheck`)
   *   can await real I/O before step 5 is ever reached, during which a
   *   concurrent `add()` could otherwise land unnoticed. A plain per-call
   *   object, not shared instance state — `check()` calls can run
   *   concurrently for different actions.
   */
  async _stepEval(action, raceSnapshot) {
    const t = this.cfg.tools;
    const c = this.cfg.content;

    // 1. tools.denylist → deny
    const d1 = toolsDenylistCheck(action, t);
    if (d1) return d1;

    // 2. content.denyPatterns → deny
    const d2 = contentDenyCheck(action, c);
    if (d2) return d2;

    // 2b. flags deny → deny (structured field-value gate). Co-located with
    // step 2 so a flagged action (e.g. injectionRisk:"high") is denied BEFORE
    // the allowlist — blocked even if its `type` is allowlisted. Floor supremacy.
    const d2f = flagsDenyCheck(action, this.cfg.flags);
    if (d2f) return d2f;

    // 3. per-action-type deny primitives → deny
    let d3 = bashCheck(action, this.cfg.bash)
          ?? fsCheck(action,   this.cfg.fs)
          ?? netCheck(action,  this.cfg.net)
          ?? this.limits.spawnCheck(action)
          ?? toolsDenyArgsCheck(action, t);
    if (!d3 && action.type === "defer") {
      d3 = await deferRateCheck(action, this.cfg.defer, this._rateCtx());
    }
    if (!d3 && action.type === "spawn") {
      d3 = await spawnRateCheck(action, this.cfg.spawn, this._rateCtx());
    }
    if (d3) return d3;

    // 4. bash.classify → tiered askHuman. Runs BEFORE content.askPatterns so a
    // bash command carries its severity tier (classification + tier) on the
    // event; a generic content ask would lose that detail. (harness §7.1.)
    const d4b = bashClassifyCheck(action, this.cfg.bash);
    if (d4b) return d4b;

    // 4. content.askPatterns → askHuman
    const d4 = contentAskCheck(action, c);
    if (d4) return d4;

    // 4b. flags ask → askHuman (structured field-value gate). Co-located with
    // step 4 so a flagged action (e.g. provenance:"web") escalates to the human
    // BEFORE the allowlist — fires even if its `type` is allowlisted.
    const d4f = flagsAskCheck(action, this.cfg.flags);
    if (d4f) return d4f;

    // 5. rwx mode (§23.5) OR tools.allowlist enforcement — mutually exclusive
    // (construct-time throw enforces exactly one), same eval-order slot.
    if (this.cfg.rwx != null) {
      // §23.21 decision 5: overwrite the race snapshot HERE, synchronously,
      // in the exact same tick `rwxCheck` reads the map — no await between
      // this line and the read. This is what the ask decision below is
      // actually computed from; a snapshot taken any earlier (even one
      // statement earlier, if something above it had awaited) or any later
      // could disagree with what `rwxCheck` itself just saw.
      if (raceSnapshot) {
        raceSnapshot.gen = this._addGeneration;
        raceSnapshot.entry = rwxToolsEntrySnapshot(this.cfg.rwx, action);
      }
      const d5 = rwxCheck(action, this.cfg.rwx);
      if (d5) return d5;
    } else {
      const d5 = toolsAllowlistCheck(action, t);
      if (d5) return d5;
    }

    // 6. default → allow
    return { outcome: "allow", severity: "action", rule: "default", reason: null };
  }

  _rateCtx() {
    return {
      auditPath: this.audit.filePath,
      entries: this.audit.fileless ? this.audit.entries : null,
      now: this._clock(),
    };
  }

  /**
   * Redact configured secrets from an action using this gate's secrets config.
   * @template T
   * @param {T} action value to redact
   * @returns {T} redacted copy (or the original if nothing changed)
   */
  redact(action) {
    return redact(action, this.cfg.secrets);
  }

  // Pure query: would this action be allowed? Used for catalog pre-filter.
  // No audit, no budget delta, no humanChannel call. (PRD v0.5 §11.)
  // Accepts either a full action object or a tool-name string (shorthand for { type: name }).
  /**
   * Pure query: would this action be allowed? No audit, budget delta, or humanChannel call.
   * @param {import("./types.js").Action|string} actionOrName a full action
   *   object, or a tool-name string (shorthand for `{ type: name }`)
   * @returns {Promise<boolean>} true unless a deny decision (or halt) applies
   */
  async allows(actionOrName) {
    if (!this._initialized) await this.init();
    const action = safeAction(typeof actionOrName === "string" ? { type: actionOrName } : actionOrName);
    const halt = this._haltCheck();
    if (halt) return false;
    const decision = await this._stepEval(action);
    return decision.outcome !== "deny";
  }

  // Main eval entry. Returns terminal { outcome, severity, rule, reason } —
  // never askHuman; bareguard resolves that internally via humanChannel.
  /**
   * Main eval entry: evaluate the action, audit, and resolve any ask/halt via humanChannel.
   * @param {import("./types.js").Action} action action to evaluate
   * @returns {Promise<import("./types.js").Decision>} terminal decision (never askHuman)
   */
  /**
   * §23.21 "check and audit in the same logical order" — the ONE place
   * every final decision from `check()` is committed. Runs entirely inside
   * the gate's ordering lock (`_withLock`, shared with `add()`), so no
   * `add()` can land between the freshness compare below and the single
   * audit line this writes — the audit log's line order IS the true order:
   * a final ALLOW line is always valid against the tools map as of its
   * position in the log.
   *
   * If `decision.outcome` is `"allow"`, rwx is active, and `raceSnapshot`
   * is given, first compares the matched tools-map entry against it (taken
   * at the step-5 read, or the conservative top-of-iteration default when
   * step 5 never ran this iteration — see `_stepEval`/`check()`).
   * Unchanged (fast path: `raceSnapshot.gen === this._addGeneration`, one
   * integer compare) → the allow stands as given. Changed → a fresh
   * `rwxCheck`; a non-allow result DOWNGRADES `decision` to a NEW
   * `rwx.tightened` deny object — `decision` itself is never mutated.
   * Exactly ONE audit line is written for this `aid`, reflecting whichever
   * decision is final — never the original AND then a correction; the
   * compare happens BEFORE any line is written, not after. A terminal
   * DENY, or an allow with no `raceSnapshot` (rwx not active, or the
   * matched entry is exempt — e.g. a bash-map match, since `add()` never
   * touches `rwx.bash`), skips the compare and commits as given.
   * @param {import("./types.js").Decision} decision the candidate final
   *   decision (already carries `aid`)
   * @param {object} [opts]
   * @param {object} [opts.action] the gated action (`null` for a line that
   *   names no specific action, matching each call site's own convention)
   * @param {{gen:number, entry:*}|null} [opts.raceSnapshot] required to
   *   consider a downgrade; omitted → never downgrades
   * @param {object} [opts.lineFields] extra fields for the audit line
   *   (e.g. `rwxLetters`/`rwxLetter`/`rwxMarker`), applied only when the
   *   decision commits AS GIVEN — a downgrade's line carries its own
   *   reason, not the original's extra fields
   * @param {string} [opts.phase] audit phase name (default `"gate"`; some
   *   call sites use `"approval"`, matching their pre-existing convention)
   * @returns {Promise<import("./types.js").Decision>}
   */
  async _commitDecision(decision, opts = {}) {
    const { action = null, raceSnapshot = null, lineFields = {}, phase = "gate" } = opts;
    return this._withLock(async () => {
      let final = decision;
      if (
        final.outcome === "allow" &&
        raceSnapshot != null &&
        this.cfg.rwx != null &&
        raceSnapshot.entry !== undefined &&
        raceSnapshot.gen !== this._addGeneration
      ) {
        const entryNow = rwxToolsEntrySnapshot(this.cfg.rwx, action);
        if (entryNow !== raceSnapshot.entry) {
          const fresh = rwxCheck(action, this.cfg.rwx);
          if (fresh.outcome !== "allow") {
            const reason = `rwx entry for "${clipKey(action?.type)}" was tightened by a concurrent gate.add() since it was read — re-evaluated as ${fresh.outcome} (${fresh.rule}${fresh.reason ? ": " + fresh.reason : ""})`;
            final = { outcome: "deny", severity: "action", rule: "rwx.tightened", reason, aid: decision.aid };
          }
        }
      }
      const isDowngraded = final !== decision;
      await this.audit.emit({
        aid: decision.aid, phase, action,
        decision: final.outcome, severity: final.severity,
        rule: final.rule, reason: final.reason,
        ...(isDowngraded ? {} : lineFields),
      });
      return final;
    });
  }

  async check(action) {
    if (!this._initialized) await this.init();
    action = safeAction(action); // own-props only — no inherited field can flip a decision

    // OQ4: one correlation id per eval. Stamped on every audit line this call
    // emits and returned on the decision, so a later record() (or the compose
    // seam) can join request → outcome even when two actions are identical.
    const aid = randomUUID().slice(0, 8);
    const emit = (fields) => this.audit.emit({ aid, ...fields });

    // §23.21 "check and audit in the same logical order" — the settled
    // design, after two earlier attempts each closed one race and opened
    // another (both superseded; PRD §23.21 keeps that history, not repeated
    // here). rwx step 5 reads the matched tools-map entry and the decision
    // is COMPUTED from that read; `check()` may then run for an unbounded
    // time (rate-check I/O, its own audit writes, a human wait) before it's
    // ready to COMMIT. A concurrent `add()` landing at ANY point in that
    // window must not let a stale allow ride through, and must not produce
    // more than one final audit line for this `aid`.
    //
    // `_commitDecision` (own doc below) is the ONE place that
    // compares-and-possibly-downgrades an allow AND writes the single final
    // audit line, atomically, inside the gate's ordering lock shared with
    // `add()` — so the compare can never be interleaved with a concurrent
    // `add()`'s own mutation. This makes the audit log's line order the
    // TRUE order: a final allow line is always valid against the tools map
    // as of its position in the log.
    //
    // `raceSnapshot` (fresh per loop iteration — never shared instance
    // state, since `check()` calls run concurrently) is seeded below with
    // the state at the very top of the iteration, before `_stepEval` runs.
    // `_stepEval`'s step 5 (if it runs this iteration) OVERWRITES both
    // fields with a same-tick read — more precise than the default,
    // because an earlier step (`deferRateCheck`/`spawnRateCheck`) can await
    // real I/O first. When step 5 does NOT run (an earlier step already
    // decided, e.g. `flags`/`content`), the top-of-iteration default is
    // what `_commitDecision` compares against.
    let iterations = 0;
    while (true) {
      const raceSnapshot = {
        gen: this._addGeneration,
        entry: this.cfg.rwx != null ? rwxToolsEntrySnapshot(this.cfg.rwx, action) : undefined,
      };
      // PRE-EVAL: halt, else the 6-step eval. `_stepEval` always returns a
      // terminal decision, so `??` makes `decision` provably non-null.
      const decision = this._haltCheck() ?? await this._stepEval(action, raceSnapshot);
      // bash.classify (harness §7.1) may attach a severity tier; read it via a
      // widened view since not every decision shape carries these optionals.
      const cls = /** @type {{classification?: ("destructive"|"super_destructive"), tier?: (2|3)}} */ (decision);
      // rwx (§23.5) may attach the agent's letters/matched letter/matched
      // marker (D103); same widened-view pattern as `cls` above, since not
      // every decision shape carries them.
      const rwxInfo = /** @type {{rwxLetters?: string, rwxLetter?: string, rwxMarker?: ("tight"|"loose"|"settled")}} */ (decision);
      const rwxAuditFields = rwxInfo.rwxLetters
        ? {
            rwxLetters: rwxInfo.rwxLetters,
            ...(rwxInfo.rwxLetter ? { rwxLetter: rwxInfo.rwxLetter } : {}),
            ...(rwxInfo.rwxMarker ? { rwxMarker: rwxInfo.rwxMarker } : {}),
          }
        : {};

      // Terminal allow/deny → commit (single lock-protected compare + one
      // audit line) and return. rwx (§23.5): "the audit line carries the
      // letter." rwxLetters/rwxLetter/rwxMarker are a closed, tiny alphabet
      // ("r"/"w"/"x"/"-", "tight"/"loose"/"settled") derived from OPERATOR
      // config, never caller/reply data — same non-redacted, non-LINE_FIELDS
      // treatment as `rule`/`severity`/classify's `classification`/`tier`.
      // Absent for every decision that isn't an rwx one, so a non-rwx
      // gate's audit line is byte-identical. Applied only when the decision
      // commits AS GIVEN — a downgrade to `rwx.tightened` carries its own
      // reason, not these fields (see `_commitDecision`).
      if (decision.outcome === "allow" || decision.outcome === "deny") {
        // Control flow above guarantees outcome is "allow" | "deny"; the cast
        // pins the internal eval result to the public Decision shape.
        const asDecision = /** @type {import("./types.js").Decision} */ ({ ...decision, aid });
        return this._commitDecision(asDecision, { action, raceSnapshot, lineFields: rwxAuditFields });
      }

      // askHuman path: emit gate audit (OUTSIDE the ordering lock — this is
      // not a final line, and `add()` must never block on a human),
      // dispatch to humanChannel, apply. rwx.askOn:"loose" (D103) resolves
      // an rwx match to askHuman too, so this line carries the same rwx
      // fields as the terminal branch above.
      await emit({
        phase: "gate", action,
        decision: "askHuman", severity: decision.severity,
        rule: decision.rule, reason: decision.reason,
        ...(cls.classification
          ? { classification: cls.classification, tier: cls.tier }
          : {}),
        ...rwxAuditFields,
      });

      // Halt: also emit dedicated halt line for operator grep.
      if (decision.severity === "halt") {
        await emit({
          phase: "halt", action: null,
          dimension: this._haltDimension(decision.rule),
          spent: this._haltSpent(decision.rule),
          cap:   this._haltCap(decision.rule),
          rule:  decision.rule, reason: decision.reason,
          awaiting: this.humanChannel ? "human" : "no-channel",
        });
      }

      if (!this.humanChannel) {
        if (!this._warnedNoChannel) {
          this._warnedNoChannel = true;
          process.stderr.write(
            `[bareguard] WARN: humanChannel is not registered; an ` +
            `ask/halt event for rule "${decision.rule}" will deny by default. ` +
            `Wire { humanChannel: async (event) => ({ decision: ... }) } in your Gate config. ` +
            `See https://github.com/hamr0/bareguard#wiring-with-humanchannel\n`
          );
        }
        return this._commitDecision(
          {
            outcome: "deny", severity: "halt", rule: decision.rule,
            reason: `${decision.reason} (no humanChannel registered)`, aid,
          },
          { action },
        );
      }

      // event.action is ALWAYS the action being checked (v0.4). For halt
      // events the cap was already exhausted on entry — this action didn't
      // by itself trip it — but it is the right hook for caller-attached
      // routing context (e.g. action._ctx in multi-tenant adopters).
      /** @type {import("./types.js").HumanEvent} */
      const event = {
        kind: decision.severity === "halt" ? "halt" : "ask",
        action,
        severity: decision.severity,
        rule: decision.rule,
        reason: decision.reason,
        context: await this.haltContext(),
      };

      // bash.classify (harness §7.1): surface the severity tier so the
      // humanChannel maps severity → ceremony. Additive — absent for every
      // event that didn't come from the classifier, so non-bash/non-classify
      // callers see a byte-identical event.
      if (cls.classification) {
        event.classification = cls.classification;
        event.tier = cls.tier;
      }

      // rwx.askOn:"loose" (D103): surface the matched letter/marker so
      // humanChannel can show what triggered the ask. Additive — absent for
      // every event that didn't come from rwx.ask, byte-identical otherwise.
      if (rwxInfo.rwxLetters) {
        event.rwxLetters = rwxInfo.rwxLetters;
        if (rwxInfo.rwxLetter) event.rwxLetter = rwxInfo.rwxLetter;
        if (rwxInfo.rwxMarker) event.rwxMarker = rwxInfo.rwxMarker;
      }

      // Axis B (§6.6): a buffered judge fact rides THIS ask if it should surface
      // and the knob doesn't downgrade it to log-only. Reversibility is read from
      // the GATED ACTION's type via the operator's config — never the fact, the
      // agent, or the model (a hallucinated "reversible" must not auto-pass). B
      // only attaches a note to an ask A already raised; it never changed the
      // decision, so this can never block or flip an outcome. Empty buffer ⇒ no
      // `annotations` key ⇒ byte-identical event (additive, opt-in).
      if (this._annotations.length) {
        const axisB = this.cfg.axisB ?? {};
        const knob = axisB.reversibleEscalation === "relaxed" ? "relaxed" : "strict";
        const reversible = Array.isArray(axisB.reversible) && axisB.reversible.includes(action?.type);
        // check() only needs log-vs-not: a surfacing fact attaches unless the knob
        // routed it to log-only. routeAnnotation's richer return (pass / annotate-
        // floor-ask / HITL) is for callers wiring their own Axis-B sink via the
        // exported fn; here every not-`log` surfacing fact rides this ask.
        const surfacing = this._annotations.filter(
          (a) => a.surface && routeAnnotation(a.surface, reversible, knob) !== "log",
        );
        if (surfacing.length) event.annotations = surfacing.map((a) => ({ ...a }));
      }

      let response;
      try {
        const channelPromise = this.humanChannel(event);
        if (this.humanChannelTimeoutMs != null && this.humanChannelTimeoutMs > 0) {
          const timeoutMs = this.humanChannelTimeoutMs;
          const TIMEOUT = Symbol("humanChannelTimeout");
          // Deliberately NOT unref'd: the timer firing is the only way this
          // promise (and therefore check()) can ever resolve when humanChannel
          // never settles, so it must keep the event loop alive while the
          // human decision is pending. It is always cleared below once the
          // race settles (answer, timeout, or throw), so a finished check()
          // never holds the process open for the remainder of timeoutMs.
          let timer;
          const timeoutPromise = new Promise((resolve) => {
            timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
          });
          let raced;
          try {
            raced = await Promise.race([channelPromise, timeoutPromise]);
          } finally {
            clearTimeout(timer);
          }
          if (raced === TIMEOUT) {
            const reason = `humanChannel timeout after ${this.humanChannelTimeoutMs}ms`;
            return this._commitDecision(
              { outcome: "deny", severity: "halt", rule: decision.rule, reason, aid },
              { action, phase: "approval" },
            );
          }
          response = raced;
        } else {
          response = await channelPromise;
        }
      }
      catch (err) {
        return this._commitDecision(
          {
            outcome: "deny", severity: "halt", rule: decision.rule,
            reason: `humanChannel threw: ${err.message}`, aid,
          },
          { action, phase: "approval" },
        );
      }

      const human = response ?? { decision: "deny", reason: "humanChannel returned nothing" };
      // The raw human response is its OWN audit fact, written unconditionally
      // and OUTSIDE the lock — it records what the human SAID, not what the
      // gate finally decided; the branch below still commits the actual
      // outcome (and, for "allow", still re-validates freshness).
      await emit({
        phase: "approval", action,
        decision: human.decision, reason: human.reason ?? null,
        newCap: human.newCap ?? null,
      });

      if (human.decision === "allow") {
        return this._commitDecision(
          { outcome: "allow", severity: "action", rule: "humanChannel.allow", reason: human.reason ?? null, aid },
          { action, raceSnapshot },
        );
      }
      if (human.decision === "deny") {
        return this._commitDecision(
          {
            outcome: "deny",
            severity: decision.severity, // preserve halt vs action source
            rule: decision.rule,
            reason: human.reason ?? "human denied",
            aid,
          },
          { action },
        );
      }
      if (human.decision === "topup") {
        if (decision.severity !== "halt") {
          // topup only meaningful for halt; for ask events, treat as allow.
          return this._commitDecision(
            { outcome: "allow", severity: "action", rule: "humanChannel.allow", reason: "topup-on-ask treated as allow", aid },
            { action, raceSnapshot },
          );
        }
        if (typeof human.newCap !== "number" || !isFinite(human.newCap) || human.newCap < 0) {
          return this._commitDecision(
            { outcome: "deny", severity: "halt", rule: decision.rule, reason: "topup with invalid newCap", aid },
            { action },
          );
        }
        const dimension = this._haltDimension(decision.rule);
        if (!dimension) {
          return this._commitDecision(
            { outcome: "deny", severity: "halt", rule: decision.rule, reason: "topup not applicable to this rule", aid },
            { action },
          );
        }
        const oldCap = this._haltCap(decision.rule);
        await this.budget.raiseCap(dimension, human.newCap);
        await emit({
          phase: "topup", action: null,
          dimension, oldCap, newCap: human.newCap,
        });
        if (++iterations >= MAX_TOPUP_ITERATIONS) {
          return this._commitDecision(
            {
              outcome: "deny", severity: "halt", rule: decision.rule,
              reason: `topup loop exceeded ${MAX_TOPUP_ITERATIONS} iterations`, aid,
            },
            { action },
          );
        }
        // re-evaluate gate.check in the next loop iteration
        continue;
      }
      if (human.decision === "terminate") {
        await this.terminate(human.reason ?? "human chose terminate");
        return this._commitDecision(
          {
            outcome: "deny", severity: "halt", rule: "gate.terminated",
            reason: human.reason ?? "human chose terminate", aid,
          },
          { action },
        );
      }

      // Unknown decision: defensive deny.
      return this._commitDecision(
        {
          outcome: "deny", severity: "halt", rule: decision.rule,
          reason: `humanChannel returned unknown decision: ${human.decision}`, aid,
        },
        { action },
      );
    }
  }

  /**
   * Record an executed action: tick limits, apply spend to budget, and emit a record audit line.
   * @param {import("./types.js").Action} action the executed action
   * @param {import("./types.js").Result} [result] execution result; `costUsd` / `tokens` / `counts` drive the budget
   * @param {object} [opts]
   * @param {string} [opts.aid] correlation id from the matching `check()` decision (OQ4); joins this record to its request. Defaults to a fresh id.
   * @returns {Promise<void>}
   */
  async record(action, result, opts = {}) {
    if (!this._initialized) await this.init();
    action = safeAction(action); // own-props only (reads action.type for limits/spawn)
    const aid = opts.aid ?? randomUUID().slice(0, 8);
    this.limits.tick(action);
    if (action?.type === "spawn") this.limits.noteSpawn();
    // rwx count caps (§23.10): "the gate accrues the letter count itself in
    // rwx mode instead of relying on the caller's result.counts." Merge a
    // `{ [letter]: 1 }` delta on top of whatever counts the caller already
    // supplied — additive, non-destructive (a fresh object; `result` itself
    // is never mutated). Only a resource actually capped via
    // `budget.resources` accrues (Budget.record ignores unconfigured names),
    // so this is a no-op unless the operator opted in with `{ w: 20 }` etc.
    let recordedResult = result;
    if (this.cfg.rwx != null) {
      const letter = matchRwxLetter(action, this.cfg.rwx);
      if (letter) {
        recordedResult = {
          ...result,
          counts: { ...(result?.counts ?? {}), [letter]: (result?.counts?.[letter] ?? 0) + 1 },
        };
      }
    }
    const { warnings, unpriced } = await this.budget.record(recordedResult);
    await this.audit.emit({
      phase: "record", action, aid,
      decision: null, severity: null, rule: null, reason: null, result,
    });
    // Cost contract (PRD §3.7/§3.8): an unpriced round means the cost axis could not
    // be priced this round. Surface it LOUDLY as its own phase — never a silent zero
    // — so the budget being unenforceable for this round is observable. (The halt,
    // if failClosedOnUnpriced is set, comes from budget.check() on the next preEval.)
    if (unpriced) {
      await this.audit.emit({
        phase: "unpriced", action, aid,
        reason: this.budget.failClosedOnUnpriced && isFinite(this.budget.capUsd)
          ? "cost unpriced under an active cap — budget axis will fail closed (failClosedOnUnpriced)"
          : "cost unpriced this round — budget axis unenforceable for this action",
      });
    }
    // OQ3 soft tier: surface each crossed warning as a non-blocking observability
    // line (the decision/halt path is untouched — a warn never stops the run).
    for (const w of warnings) {
      await this.audit.emit({
        phase: "budget_warn", action: null, aid,
        dimension: w.dimension, spent: w.spent, cap: w.cap, ratio: w.ratio,
        reason: `soft budget: ${w.dimension} at ${(w.ratio * 100).toFixed(0)}% (${w.spent}/${w.cap})`,
      });
    }
  }

  /**
   * Axis B (§6.6/§8.2) — buffer a return-time-judge FACT about whether a returned
   * value honored the user's request. bareguard NEVER computes the fact (no LLM)
   * and NEVER decides an outcome: it buffers, audits the fact (sink 1), lets it
   * ride the next human ask `check()` raises (sink 3, §6.6 routing), and exposes
   * it for agent feedback via {@link Gate#drainAnnotations} (sink 2). Additive and
   * opt-in: with no `annotate()` call the decision path is byte-identical.
   * @param {import("./types.js").Annotation} fact  caller-computed fact; `surface`
   *   MUST be an explicit boolean (e.g. `verdict !== "honored"`). Anything else —
   *   a non-object, an array, a fact missing `surface`, or a fact that THROWS when
   *   read (a getter / Proxy trap) — is MALFORMED: nothing is buffered and a
   *   distinct `annotate_malformed` audit row records the reason. Never changes a
   *   decision. Never throws because of the FACT — any shape, any hostile getter.
   *   An audit WRITE failure (disk full, unwritable path) still propagates, by
   *   design: a silently-dropped audit line is a worse failure than a loud one,
   *   and that is true of every other phase this gate emits.
   * @returns {Promise<void>}
   */
  async annotate(fact) {
    if (!this._initialized) await this.init();
    // Malformed is LOUD but inert: a record, not a verdict (same class as
    // `unpriced` / `budget_warn`). Its own phase, not a flag on `annotate`, so a
    // parser counting `phase === "annotate"` cannot miscount a rejection as a fact.
    //
    // EVERY read of `fact` is caller-controlled and can throw (a getter, a Proxy
    // trap), so all of them are inside readAnnotation's guard — that is what makes
    // "never throws because of the fact you passed" true. The audit WRITE below is
    // deliberately NOT guarded: a silently-dropped audit line is the worse failure.
    const read = readAnnotation(fact);
    if (read.defect !== null) {
      await this.audit.emit({ phase: "annotate_malformed", action: null, reason: read.defect });
      return;
    }
    const norm = read.norm;
    this._annotations.push(norm);
    // Sink 1: the fact is recorded even if no ask ever rides it.
    await this.audit.emit({
      phase: "annotate", action: null,
      surface: norm.surface, verdict: norm.verdict, where: norm.where, meta: norm.meta,
    });
  }

  /**
   * Axis B sink 2 — drain buffered annotations for agent feedback. Returns the
   * buffered facts (a copy) and clears the buffer; clearing also stops stale facts
   * from riding a later, unrelated ask. Call once per turn.
   * @returns {import("./types.js").Annotation[]}
   */
  drainAnnotations() {
    const out = this._annotations.map((a) => ({ ...a }));
    this._annotations = [];
    return out;
  }

  // Convenience: gate.check + execute + gate.record. Caller supplies executor.
  /**
   * Convenience: check the action, run the executor if allowed, then record the result.
   * @param {import("./types.js").Action} action action to gate and execute
   * @param {(action: import("./types.js").Action) => (import("./types.js").Result | Promise<import("./types.js").Result>)} executor
   *   invoked with the action when allowed; its return value is recorded and returned
   * @returns {Promise<import("./types.js").Result | { error: { type: string, rule: string, severity: string, reason: (string|null), action_summary: string } }>}
   *   the executor's result, or a structured `policy_denied` error object if denied
   */
  async run(action, executor) {
    // Normalize once so the DECISION and what the executor RUNS are the same
    // action — otherwise an inherited field could be evaluated-away yet still
    // execute (TOCTOU). check()/record() re-normalize (idempotent).
    action = safeAction(action);
    const decision = await this.check(action);
    if (decision.outcome !== "allow") {
      return structuredError(decision, action);
    }
    const result = await executor(action);
    await this.record(action, result, { aid: decision.aid }); // OQ4: join record → its decision
    return result;
  }

  /**
   * Raise (or set) a budget cap and emit a topup audit line.
   * @param {import("./types.js").BudgetDimension} dimension which cap to change
   * @param {number} newCap new cap value (finite, >= 0)
   * @returns {Promise<void>}
   */
  async raiseCap(dimension, newCap) {
    if (!this._initialized) await this.init();
    const oldCap = dimension === "costUsd" ? this.budget.capUsd
                 : dimension === "tokens" ? this.budget.capTokens
                 : this.budget.resourceCaps[dimension]; // generic resource (OQ3)
    await this.budget.raiseCap(dimension, newCap);
    await this.audit.emit({
      phase: "topup", action: null,
      dimension, oldCap, newCap,
    });
  }

  /**
   * rwx delegation clamp (§23.9) — attenuate ONLY: a spawned child's letters
   * are `min(what the parent requested for it, what this gate itself holds)`
   * per letter, so a child can never outgrow its parent (an `r-x` manager can
   * only produce `r--`/`r-x` helpers, never a `w`-holding one). Runs in the
   * PARENT's gate at spawn time — a child never verifies its own letters.
   * Pass the returned string as the child's `rwx.letters` (the same channel
   * `spawnDepth` travels on: a config field, with a `BAREGUARD_RWX_LETTERS`
   * env-var fallback mirroring `BAREGUARD_SPAWN_DEPTH`). A gate not in rwx
   * mode (`cfg.rwx` unset) has nothing to delegate and returns `"---"`.
   * @param {string} [requestedLetters] letters requested for the child; default `"rwx"` (ask for everything — the clamp does the rest)
   * @returns {string} the clamped 3-char letters string, never wider than this gate's own grant
   */
  clampRwxLetters(requestedLetters = "rwx") {
    if (this.cfg.rwx == null) return "---";
    const { letters } = resolveAgentLetters(this.cfg.rwx);
    return clampLetters(letters, requestedLetters);
  }

  /**
   * §23.21 — runtime, tighten-only growth of the rwx tools map, for
   * spec-less sites a harness meets mid-run that no operator committed or
   * reviewed. Callable from harness code only — the agent only ever sends
   * actions and never holds a `Gate` reference, so this stays structurally
   * out of its reach. The committed `bareguard.rwx.json` (or a
   * construct-time `rwx.tools` map) is never written to at runtime; `add()`
   * mutates only this gate's own private, construct-time-copied map (see
   * the constructor's `deepCopyRwx`).
   *
   * Validated exactly as at construct time (the real {@link assertRwxConfig}),
   * but over the BATCH's own entries only — delta validation, not a
   * whole-map re-check. `assertRwxConfig` has no cross-key rule (every
   * tools/bash/agents check is a standalone per-entry loop), so this gives
   * the identical per-key accept/reject answer whole-map validation would,
   * at a cost independent of the existing map's size.
   *
   * Tighten-only on both axes against any key already present (a
   * hand-written one included): the letter can only rise (`r` < `w` < `x`),
   * and an entry currently marked `"loose"` can only move to another
   * `"loose"` entry — never to `"tight"`/`"settled"`, and never to a bare
   * letter string either, because a bare letter normalizes to
   * `marker: null` ({@link normalizeEntry}), a state distinct from
   * `"loose"`. `"tight"` <-> `"settled"` moves are unrestricted (neither
   * ever asks). Only the tools map is reachable — `bash`, `agents`, and the
   * agent's own grant are never touched by this method.
   *
   * All-or-nothing: nothing lands unless the WHOLE batch passes shape,
   * tighten-only, and the {@link RWX_TOOLS_CAP} 10,000-key cap (landing
   * exactly at the cap is fine; only crossing it refuses). Hardened like
   * every other agent-reachable entry point: `entries` is read via the same
   * own-props-only, hostile-getter-safe copy `safeAction()` uses gate-wide,
   * so every value is read exactly once (no TOCTOU between validating a
   * value and storing it), and a `__proto__`/`constructor`/`prototype` key
   * is rejected outright rather than silently no-op'd or partially applied.
   *
   * Audited on success — one `rwx.added` line per landed key (key, letter,
   * marker) — and audited loudly on ANY rejection — one `rwx.add_rejected`
   * line (reason, the batch's attempted keys) BEFORE throwing. This is the
   * only behavior; there is no silent-reject mode. A gate with no `rwx`
   * config at all rejects every `add()` (conservative: nothing to tighten
   * against, so nothing is accepted).
   * @param {Object<string, (string|{letter:string, marker?:string})>} entries
   *   1..n tools-map entries, the same shape `rwx.tools` accepts at
   *   construct time (a bare `"r"`/`"w"`/`"x"`, or `{letter, marker?}`).
   * @returns {Promise<void>}
   * @fails Throws (after emitting `rwx.add_rejected`) when: this gate has
   *   been {@link Gate#terminate}d; it has no `rwx` config; `entries` is not
   *   a non-empty plain object, or is unreadable; a key is
   *   `__proto__`/`constructor`/`prototype`; an entry's shape is malformed
   *   (same rule as construct time); an entry would loosen an existing
   *   key's letter or move it off marker `"loose"`; or the batch would push
   *   `rwx.tools` past {@link RWX_TOOLS_CAP} keys. Nothing lands on any
   *   throw. A budget-halt state does NOT block `add()` — it spends no
   *   budget itself and nothing in §23.21 makes growing the tools map
   *   conditional on the cost/token axis.
   *
   * **Serialized**, on the SAME gate-wide ordering lock `check()`'s final
   * commit uses (`_withLock`) — not a separate queue. `add()` reads the live
   * tools map, then AWAITS (the audit-first writes), then mutates — a
   * genuine async window between "validate against current state" and "use
   * that validation." Two concurrent `add()` calls that both entered before
   * either had mutated would both validate against the SAME stale state:
   * found by review, this let an `x`-tagged key concurrently "tighten" to
   * `w` (loosening it, past the tighten-only guard, because the `w` call's
   * tighten-check read the map before the `x` call had landed) and would
   * equally have let two batches that each individually fit the 10,000-key
   * cap jointly cross it. Sharing the lock with `check()`'s final commit
   * (rather than a separate `add()`-only queue) is what makes the audit
   * log's line order the TRUE order across BOTH operations (§23.21).
   */
  async add(entries) {
    if (!this._initialized) await this.init();
    return this._withLock(() => this._addOnce(entries));
  }

  /**
   * The actual `gate.add()` logic, run strictly one call at a time by the
   * `add()` wrapper's queue above — this method itself does no
   * serialization and must never be called directly (module-internal only;
   * kept as a regular method, not a private `#` field, purely to stay
   * consistent with this file's existing style).
   * @param {Object<string, (string|{letter:string, marker?:string})>} entries
   * @returns {Promise<void>}
   */
  async _addOnce(entries) {
    const reject = async (message, keys) => {
      await this.audit.emit({ phase: "rwx.add_rejected", reason: message, keys });
      throw new Error(message);
    };
    // Checked first, same convention as `_haltCheck()` — a terminated gate
    // accepts nothing more. Checked at EXECUTION time (inside `_addOnce`,
    // after the serialization queue, not in the `add()` wrapper before it),
    // so an `add()` that was already WAITING in the queue when `terminate()`
    // ran is rejected too, not just one called after — "terminated" means
    // nothing more lands, full stop, regardless of when it was queued.
    // Deliberately narrow: a budget-halt state (`this.budget.check()`) is
    // NOT checked here — nothing in §23.21 or the halt design says growing
    // the tools map should be blocked by an exhausted cost/token cap, and
    // `add()` spends no budget itself, so it stays allowed unless a clearer
    // reason to deny it shows up.
    if (this.terminated) {
      return reject("gate.add: gate has been terminated — nothing is accepted", attemptedRwxKeys(entries));
    }
    if (this.cfg.rwx == null) {
      return reject("gate.add: this gate has no rwx config — nothing to tighten against, so nothing is accepted", []);
    }

    let entriesUsable;
    try { entriesUsable = isPlainObject(entries) && Object.keys(entries).length > 0; }
    catch { entriesUsable = false; }
    if (!entriesUsable) {
      return reject(
        "gate.add: entries must be a non-empty plain object { key: letter | {letter,marker} }",
        attemptedRwxKeys(entries),
      );
    }

    // Own-props-only snapshot (safeAction's own treatment, gate-wide): reads
    // every value exactly once (no TOCTOU between validating and storing a
    // hostile getter's value) and lands on a null-prototype object, so a
    // JSON-parsed `{"__proto__": "r"}` batch cannot smuggle a prototype
    // write later when a landed key is copied into `rwx.tools`.
    let snapshot;
    try { snapshot = copyOwnSafely(entries); }
    catch { return reject("gate.add: entries could not be read", []); }
    for (const dangerous of ["__proto__", "constructor", "prototype"]) {
      if (Object.prototype.hasOwnProperty.call(snapshot, dangerous)) {
        return reject(`gate.add: "${dangerous}" is not a usable tools-map key`, Object.keys(snapshot));
      }
    }
    const batchEntries = Object.entries(snapshot);

    try {
      // 1) Shape — delta validation only: the real construct-time validator,
      // handed ONLY the batch's own entries (never merged with the
      // possibly-huge current map).
      assertRwxConfig({ rwx: { ...this.cfg.rwx, tools: snapshot } });

      const rwx = this.cfg.rwx;
      const currentTools = isPlainObject(rwx.tools) ? rwx.tools : {};

      // 2) Normalize every batch entry ONCE, before any mutation. Non-null
      // is guaranteed here: `assertRwxConfig` above already rejects any
      // entry `normalizeEntry` can't parse, so every `newNorm` below is
      // real; a defensive guard still throws rather than assume, matching
      // this file's "fail loud, not silent" posture, and does so BEFORE
      // step 4's mutation, so a guard that somehow did fire could never
      // break all-or-nothing.
      const newNorms = new Map();
      for (const [key, rawNew] of batchEntries) {
        const newNorm = normalizeEntry(rawNew);
        if (!newNorm) throw new Error(`gate.add: rwx.tools.${clipKey(key)} could not be normalized`);
        newNorms.set(key, newNorm);
      }

      // 3) Tighten-only, letter AND marker, against any key already present
      // (a genuinely new key has nothing to tighten against).
      for (const [key] of batchEntries) {
        if (!Object.prototype.hasOwnProperty.call(currentTools, key)) continue;
        const oldNorm = normalizeEntry(currentTools[key]);
        if (!oldNorm) throw new Error(`gate.add: rwx.tools.${clipKey(key)} (existing entry) could not be normalized`);
        const newNorm = newNorms.get(key);
        if (RWX_LETTER_RANK[newNorm.letter] < RWX_LETTER_RANK[oldNorm.letter]) {
          throw new Error(
            `gate.add: rwx.tools.${clipKey(key)} would LOOSEN "${oldNorm.letter}" -> "${newNorm.letter}" — add() is tighten-only (r<w<x)`,
          );
        }
        if (oldNorm.marker === "loose" && newNorm.marker !== "loose") {
          throw new Error(
            `gate.add: rwx.tools.${clipKey(key)} would move OFF marker "loose" (to ${newNorm.marker === null ? "a bare letter, which has no marker" : `"${newNorm.marker}"`}) — add() may not un-loosen a loose-marked entry`,
          );
        }
      }

      // 4) Size cap — computed from current-count + genuinely-new-key-count,
      // without ever building the merged map.
      let newKeyCount = 0;
      for (const [key] of batchEntries) {
        if (!Object.prototype.hasOwnProperty.call(currentTools, key)) newKeyCount++;
      }
      const projectedSize = Object.keys(currentTools).length + newKeyCount;
      if (projectedSize > RWX_TOOLS_CAP) {
        throw new Error(
          `gate.add: rwx.tools would grow to ${projectedSize} keys, past the cap of ${RWX_TOOLS_CAP} — nothing added`,
        );
      }

      // 5) Every check above passed for the WHOLE batch. AUDIT FIRST, MUTATE
      // AFTER — an audit write failure must PROPAGATE (repo rule), and the
      // only way to guarantee "every ALLOWED key traces back to a logged
      // add" is to never let a key become live before its own line is
      // durably written. Writing every rwx.added line BEFORE touching
      // `currentTools` means a mid-batch audit-write throw (e.g. the 2nd of
      // 3 lines) leaves NOTHING landed — the mutation loop below never
      // runs — at the cost of a residual in the opposite, SAFE direction:
      // an EARLIER key in the same batch may already have a real
      // `rwx.added` line on disk describing a key that ultimately never
      // landed ("logged but not landed"). This is deliberately preferred
      // over the alternative (mutate first, roll back on audit failure):
      // rolling back after a partial audit write would leave an
      // `rwx.added` line for a key that was subsequently reverted — the
      // exact same residual, PLUS a live rollback path that itself must
      // never partially fail. Logged-but-not-landed is safe because
      // `check()`/`rwxCheck` only ever consult the live tools map, never
      // the audit log — a stray log line can never grant anything; the
      // rejected alternative, landed-but-not-logged, would be a real,
      // usable capability with no audit trail explaining it, which is the
      // one thing "every allowed key traces back to a logged add" forbids.
      for (const [key] of batchEntries) {
        const norm = newNorms.get(key);
        await this.audit.emit({ phase: "rwx.added", key, letter: norm.letter, marker: norm.marker });
      }
      // 6) Every rwx.added line landed durably — NOW mutate. No throw point
      // exists after this line, so all-or-nothing is structural: a batch
      // that fails any check above, OR whose audit write fails, never
      // touches `currentTools`. `_addGeneration` bumps in the same
      // breath as the mutation, so it is always consistent with what
      // actually landed (never bumped when nothing did).
      for (const [key, raw] of batchEntries) currentTools[key] = raw;
      rwx.tools = currentTools;
      this._addGeneration++; // §23.21 decision 5: check()/add() race fix
    } catch (err) {
      await this.audit.emit({
        phase: "rwx.add_rejected", reason: err.message,
        keys: batchEntries.map(([k]) => k),
      });
      throw err;
    }
  }

  /**
   * Terminate the gate: all subsequent checks halt-deny. Idempotent.
   * @param {string} [reason] reason recorded in the terminate audit line
   * @returns {Promise<{ok:true, alreadyTerminated?:boolean}>}
   */
  async terminate(reason) {
    if (!this._initialized) await this.init();
    if (this.terminated) return { ok: true, alreadyTerminated: true };
    this.terminated = true;
    await this.audit.emit({
      phase: "terminate", action: null, reason,
    });
    return { ok: true };
  }

  /**
   * Build the spend/turns/spend-rate context summary attached to ask/halt events.
   * @returns {Promise<import("./types.js").HaltContext>}
   */
  async haltContext() {
    if (!this._initialized) await this.init();
    const lines = await this.audit.readAll();
    const records = lines.filter(l => l.phase === "record");
    const totUsd = records.reduce((a, r) => a + (r.result?.costUsd ?? 0), 0);
    const totTok = records.reduce((a, r) => a + (r.result?.tokens ?? 0), 0);
    const last5 = records.slice(-5).map(r => r.result?.costUsd ?? 0);
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const earliestTs = lines[0]?.ts ? Date.parse(lines[0].ts) : null;
    const latestTs = lines.at(-1)?.ts ? Date.parse(lines.at(-1).ts) : null;
    return {
      spent:    { costUsd: totUsd, tokens: totTok },
      cap:      { costUsd: this.budget.capUsd, tokens: this.budget.capTokens },
      turns:    this.limits.turns,
      maxTurns: this.limits.maxTurns,
      timeElapsedMs: (earliestTs && latestTs) ? (latestTs - earliestTs) : 0,
      spendRate: {
        avgPerTurn: records.length ? totUsd / records.length : 0,
        last5Avg:   avg(last5),
        last5,
      },
    };
  }

  // Generic resource halts carry rule `budget.resource.<name>` (OQ3); map them
  // back to the raiseable dimension <name> for the halt/topup lines.
  _resourceFromRule(rule) {
    return rule?.startsWith("budget.resource.") ? rule.slice("budget.resource.".length) : null;
  }
  _haltDimension(rule) {
    if (rule === "budget.maxCostUsd") return "costUsd";
    if (rule === "budget.maxTokens")  return "tokens";
    return this._resourceFromRule(rule); // generic resource, or null for limits.*
  }
  _haltSpent(rule) {
    if (rule === "budget.maxCostUsd")     return this.budget.spentUsd;
    if (rule === "budget.maxTokens")      return this.budget.spentTokens;
    if (rule === "limits.maxTurns")       return this.limits.turns;
    if (rule === "limits.maxToolRounds")  return this.limits.toolRounds;
    const r = this._resourceFromRule(rule);
    if (r) return this.budget.resourceSpent[r] ?? null;
    return null;
  }
  _haltCap(rule) {
    if (rule === "budget.maxCostUsd")     return this.budget.capUsd;
    if (rule === "budget.maxTokens")      return this.budget.capTokens;
    if (rule === "limits.maxTurns")       return this.limits.maxTurns;
    if (rule === "limits.maxToolRounds")  return this.limits.maxToolRounds;
    const r = this._resourceFromRule(rule);
    if (r) return this.budget.resourceCaps[r] ?? null;
    return null;
  }
}
