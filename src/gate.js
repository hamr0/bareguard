// Gate — the orchestrator. Single decision path through PRE-EVAL halt checks
// then the 6-step eval order (PRD v0.5 §3). Calls humanChannel for ask/halt
// events; applies the human decision atomically; returns terminal allow/deny.

import { randomUUID } from "node:crypto";
import { Audit, defaultAuditPath } from "./primitives/audit.js";
import { Budget, sanitizeSpend } from "./primitives/budget.js";
import { Limits } from "./primitives/limits.js";
import { redact } from "./primitives/secrets.js";
import { bashCheck } from "./primitives/bash.js";
import { bashClassifyCheck } from "./primitives/classify.js";
import { fsCheck } from "./primitives/fs.js";
import { netCheck } from "./primitives/net.js";
import {
  toolsDenylistCheck, toolsDenyArgsCheck, toolsAllowlistCheck,
} from "./primitives/tools.js";
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
function safeAction(action) {
  if (action == null || typeof action !== "object") return action;
  const safe = Object.assign(Object.create(null), action);
  if (action.args != null && typeof action.args === "object") {
    safe.args = Object.assign(Object.create(null), action.args);
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
 */
export function routeAnnotation(surface, reversible, knob = "strict") {
  if (!surface) return reversible ? "pass" : "annotate-floor-ask"; // honored
  if (!reversible) return "annotate-floor-ask";        // irreversible broke: rides A's stop
  return knob === "strict" ? "HITL" : "log";           // reversible broke: strict rides, relaxed logs
}

/**
 * Bound an annotation `meta` object so an annotate audit line can't exceed the
 * audit's atomic-append cap. Non-objects → null; oversized / unserializable →
 * a small marker that replaces it everywhere downstream (buffer / event / drain).
 * The caller still holds their own original object reference.
 * @param {*} meta
 * @returns {object|null}
 */
function boundMeta(meta) {
  if (meta == null || typeof meta !== "object") return null;
  try {
    const bytes = Buffer.byteLength(JSON.stringify(meta), "utf8");
    return bytes > 1000 ? { _truncated: true, bytes } : meta;
  } catch {
    return { _unserializable: true };
  }
}

/**
 * The single chokepoint every agent action passes through. Construct once per
 * run, `await gate.init()`, then call {@link Gate#check} / {@link Gate#record}
 * (or {@link Gate#run}) for each action. Runs PRE-EVAL halt checks then the
 * 6-step eval order, resolves ask/halt events via `humanChannel`, and returns
 * terminal allow/deny decisions. See README.md and bareguard.context.md for
 * wiring recipes.
 */
export class Gate {
  /**
   * @param {import("./types.js").GateConfig & { _clock?: () => number }} [config]
   *   Gate configuration. `_clock` is a millisecond clock override for tests.
   */
  constructor(config = {}) {
    this.cfg = config;
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
      // Auto-redact persisted action/result when secrets are configured, so
      // the audit log never carries raw secrets — without the caller having
      // to remember to pre-redact (which would also weaken policy matching).
      redact: config.secrets ? (x) => redact(x, config.secrets) : null,
    });

    const sharedFile = config.budget?.sharedFile ?? process.env.BAREGUARD_BUDGET_FILE ?? null;
    this.budget = new Budget({ ...config.budget, sharedFile });
    this.limits = new Limits({ ...config.limits, startingDepth: this.spawnDepth });

    this.humanChannel = config.humanChannel ?? null;
    this.humanChannelTimeoutMs = config.humanChannelTimeoutMs ?? null;
    this.terminated = false;
    this._initialized = false;
    // Axis B (§6.6/§8.2): buffered return-time-judge facts awaiting a human ask
    // to ride / an agent-feedback drain. Empty unless the caller calls annotate().
    this._annotations = [];
  }

  /**
   * Initialize audit and budget subsystems (idempotent; auto-called by check/allows/record/etc.).
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) return;
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
  async _stepEval(action) {
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

    // 5. tools.allowlist enforcement (scope: set+match allow, set+miss deny)
    const d5 = toolsAllowlistCheck(action, t);
    if (d5) return d5;

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
  async check(action) {
    if (!this._initialized) await this.init();
    action = safeAction(action); // own-props only — no inherited field can flip a decision

    // OQ4: one correlation id per eval. Stamped on every audit line this call
    // emits and returned on the decision, so a later record() (or the compose
    // seam) can join request → outcome even when two actions are identical.
    const aid = randomUUID().slice(0, 8);
    const emit = (fields) => this.audit.emit({ aid, ...fields });

    let iterations = 0;
    while (true) {
      // PRE-EVAL: halt, else the 6-step eval. `_stepEval` always returns a
      // terminal decision, so `??` makes `decision` provably non-null.
      const decision = this._haltCheck() ?? await this._stepEval(action);
      // bash.classify (harness §7.1) may attach a severity tier; read it via a
      // widened view since not every decision shape carries these optionals.
      const cls = /** @type {{classification?: ("destructive"|"super_destructive"), tier?: (2|3)}} */ (decision);

      // Terminal allow/deny → audit and return.
      if (decision.outcome === "allow" || decision.outcome === "deny") {
        await emit({
          phase: "gate", action,
          decision: decision.outcome, severity: decision.severity,
          rule: decision.rule, reason: decision.reason,
        });
        // Control flow above guarantees outcome is "allow" | "deny"; the cast
        // pins the internal eval result to the public Decision shape.
        return /** @type {import("./types.js").Decision} */ ({ ...decision, aid });
      }

      // askHuman path: emit gate audit, dispatch to humanChannel, apply.
      await emit({
        phase: "gate", action,
        decision: "askHuman", severity: decision.severity,
        rule: decision.rule, reason: decision.reason,
        ...(cls.classification
          ? { classification: cls.classification, tier: cls.tier }
          : {}),
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
        /** @type {import("./types.js").Decision} */
        const denial = {
          outcome: "deny", severity: "halt",
          rule: decision.rule,
          reason: `${decision.reason} (no humanChannel registered)`,
          aid,
        };
        await emit({
          phase: "gate", action,
          decision: "deny", severity: "halt",
          rule: denial.rule, reason: denial.reason,
        });
        return denial;
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
          let timer;
          const timeoutPromise = new Promise((resolve) => {
            timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
            if (typeof timer.unref === "function") timer.unref();
          });
          const raced = await Promise.race([channelPromise, timeoutPromise]);
          clearTimeout(timer);
          if (raced === TIMEOUT) {
            const reason = `humanChannel timeout after ${this.humanChannelTimeoutMs}ms`;
            await emit({
              phase: "approval", action,
              decision: "deny", reason,
            });
            return { outcome: "deny", severity: "halt", rule: decision.rule, reason, aid };
          }
          response = raced;
        } else {
          response = await channelPromise;
        }
      }
      catch (err) {
        await emit({
          phase: "approval", action,
          decision: "deny", reason: `humanChannel threw: ${err.message}`,
        });
        return { outcome: "deny", severity: "halt", rule: decision.rule,
                 reason: `humanChannel threw: ${err.message}`, aid };
      }

      const human = response ?? { decision: "deny", reason: "humanChannel returned nothing" };
      await emit({
        phase: "approval", action,
        decision: human.decision, reason: human.reason ?? null,
        newCap: human.newCap ?? null,
      });

      if (human.decision === "allow") {
        /** @type {import("./types.js").Decision} */
        const decided = { outcome: "allow", severity: "action", rule: "humanChannel.allow", reason: human.reason ?? null, aid };
        await emit({
          phase: "gate", action,
          decision: "allow", severity: "action",
          rule: decided.rule, reason: decided.reason,
        });
        return decided;
      }
      if (human.decision === "deny") {
        /** @type {import("./types.js").Decision} */
        const decided = {
          outcome: "deny",
          severity: decision.severity, // preserve halt vs action source
          rule: decision.rule,
          reason: human.reason ?? "human denied",
          aid,
        };
        await emit({
          phase: "gate", action,
          decision: "deny", severity: decided.severity,
          rule: decided.rule, reason: decided.reason,
        });
        return decided;
      }
      if (human.decision === "topup") {
        if (decision.severity !== "halt") {
          // topup only meaningful for halt; for ask events, treat as allow.
          /** @type {import("./types.js").Decision} */
          const decided = { outcome: "allow", severity: "action", rule: "humanChannel.allow", reason: "topup-on-ask treated as allow", aid };
          await emit({
            phase: "gate", action,
            decision: "allow", severity: "action",
            rule: decided.rule, reason: decided.reason,
          });
          return decided;
        }
        if (typeof human.newCap !== "number" || !isFinite(human.newCap) || human.newCap < 0) {
          return { outcome: "deny", severity: "halt", rule: decision.rule, reason: "topup with invalid newCap", aid };
        }
        const dimension = this._haltDimension(decision.rule);
        if (!dimension) {
          return { outcome: "deny", severity: "halt", rule: decision.rule, reason: "topup not applicable to this rule", aid };
        }
        const oldCap = this._haltCap(decision.rule);
        await this.budget.raiseCap(dimension, human.newCap);
        await emit({
          phase: "topup", action: null,
          dimension, oldCap, newCap: human.newCap,
        });
        if (++iterations >= MAX_TOPUP_ITERATIONS) {
          return { outcome: "deny", severity: "halt", rule: decision.rule,
                   reason: `topup loop exceeded ${MAX_TOPUP_ITERATIONS} iterations`, aid };
        }
        // re-evaluate gate.check in the next loop iteration
        continue;
      }
      if (human.decision === "terminate") {
        await this.terminate(human.reason ?? "human chose terminate");
        return { outcome: "deny", severity: "halt", rule: "gate.terminated",
                 reason: human.reason ?? "human chose terminate", aid };
      }

      // Unknown decision: defensive deny.
      return {
        outcome: "deny", severity: "halt", rule: decision.rule,
        reason: `humanChannel returned unknown decision: ${human.decision}`, aid,
      };
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
    const { warnings, unpriced } = await this.budget.record(result);
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
   * @param {import("./types.js").Annotation} fact  caller-computed fact; only
   *   `surface` is load-bearing (e.g. set it to `verdict !== "honored"`). Junk
   *   (non-object) is ignored — annotate can never throw into the agent loop.
   * @returns {Promise<void>}
   */
  async annotate(fact) {
    if (!this._initialized) await this.init();
    if (fact == null || typeof fact !== "object") return; // fail-safe: ignore junk
    // Bound each field at the source so an annotate audit line stays well under
    // the audit's PIPE_BUF line cap (atomic shared-file appends): `where`/`meta`
    // are reply-derived and otherwise unbounded. This also bounds what reaches
    // the human/agent — `where` is a one-line summary by design.
    const norm = {
      surface: fact.surface === true,
      verdict: typeof fact.verdict === "string" ? fact.verdict.slice(0, 80) : null,
      where:   typeof fact.where   === "string" ? fact.where.slice(0, 300)   : null,
      meta:    boundMeta(fact.meta),
    };
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
