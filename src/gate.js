// Gate — the orchestrator. Single decision path through PRE-EVAL halt checks
// then the 6-step eval order (PRD v0.5 §3). Calls humanChannel for ask/halt
// events; applies the human decision atomically; returns terminal allow/deny.

import { randomUUID } from "node:crypto";
import { Audit, defaultAuditPath } from "./primitives/audit.js";
import { Budget } from "./primitives/budget.js";
import { Limits } from "./primitives/limits.js";
import { redact } from "./primitives/secrets.js";
import { bashCheck } from "./primitives/bash.js";
import { fsCheck } from "./primitives/fs.js";
import { netCheck } from "./primitives/net.js";
import {
  toolsDenylistCheck, toolsDenyArgsCheck, toolsAllowlistCheck,
} from "./primitives/tools.js";
import { contentDenyCheck, contentAskCheck } from "./primitives/content.js";
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

export class Gate {
  constructor(config = {}) {
    this.cfg = config;
    this.runId = config.runId ?? randomUUID();
    this.parentRunId = config.parentRunId ?? process.env.BAREGUARD_PARENT_RUN_ID ?? null;
    this.spawnDepth = config.spawnDepth ?? +(process.env.BAREGUARD_SPAWN_DEPTH ?? 0);
    this.rootRunId = config.rootRunId ?? this.parentRunId ?? this.runId;

    const auditPath = config.audit?.path ?? process.env.BAREGUARD_AUDIT_PATH ?? defaultAuditPath(this.rootRunId);
    this._clock = config._clock ?? (() => Date.now());
    this.audit = new Audit({
      filePath: auditPath, runId: this.runId,
      parentRunId: this.parentRunId, spawnDepth: this.spawnDepth,
      rootRunId: this.rootRunId, clock: this._clock,
    });

    const sharedFile = config.budget?.sharedFile ?? process.env.BAREGUARD_BUDGET_FILE ?? null;
    this.budget = new Budget({ ...config.budget, sharedFile });
    this.limits = new Limits({ ...config.limits, startingDepth: this.spawnDepth });

    this.humanChannel = config.humanChannel ?? null;
    this.humanChannelTimeoutMs = config.humanChannelTimeoutMs ?? null;
    this.terminated = false;
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;
    await this.audit.init();
    await this.budget.init({
      rebuildFromAudit: async () => this._rebuildBudgetFromAudit(),
    });
    this._initialized = true;
  }

  async _rebuildBudgetFromAudit() {
    const lines = await this.audit.readAll();
    let spentUsd = 0, spentTokens = 0, capUsd = null, capTokens = null;
    for (const l of lines) {
      if (l.phase === "record" && l.result) {
        spentUsd    += l.result.costUsd ?? 0;
        spentTokens += l.result.tokens  ?? 0;
      }
      if (l.phase === "topup") {
        if (l.dimension === "costUsd") capUsd    = l.newCap;
        if (l.dimension === "tokens")  capTokens = l.newCap;
      }
    }
    return { spentUsd, spentTokens, capUsd, capTokens };
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

    // 4. content.askPatterns → askHuman
    const d4 = contentAskCheck(action, c);
    if (d4) return d4;

    // 5. tools.allowlist enforcement (scope: set+match allow, set+miss deny)
    const d5 = toolsAllowlistCheck(action, t);
    if (d5) return d5;

    // 6. default → allow
    return { outcome: "allow", severity: "action", rule: "default", reason: null };
  }

  _rateCtx() {
    return { auditPath: this.audit.filePath, now: this._clock() };
  }

  redact(action) {
    return redact(action, this.cfg.secrets);
  }

  // Pure query: would this action be allowed? Used for catalog pre-filter.
  // No audit, no budget delta, no humanChannel call. (PRD v0.5 §11.)
  // Accepts either a full action object or a tool-name string (shorthand for { type: name }).
  async allows(actionOrName) {
    if (!this._initialized) await this.init();
    const action = typeof actionOrName === "string" ? { type: actionOrName } : actionOrName;
    const halt = this._haltCheck();
    if (halt) return halt.outcome !== "deny" ? halt.outcome === "askHuman" : false;
    const decision = await this._stepEval(action);
    return decision.outcome !== "deny";
  }

  // Main eval entry. Returns terminal { outcome, severity, rule, reason } —
  // never askHuman; bareguard resolves that internally via humanChannel.
  async check(action) {
    if (!this._initialized) await this.init();

    let iterations = 0;
    while (true) {
      // PRE-EVAL: halt
      let decision = this._haltCheck();
      if (!decision) decision = await this._stepEval(action);

      // Terminal allow/deny → audit and return.
      if (decision.outcome === "allow" || decision.outcome === "deny") {
        await this.audit.emit({
          phase: "gate", action,
          decision: decision.outcome, severity: decision.severity,
          rule: decision.rule, reason: decision.reason,
        });
        return decision;
      }

      // askHuman path: emit gate audit, dispatch to humanChannel, apply.
      await this.audit.emit({
        phase: "gate", action,
        decision: "askHuman", severity: decision.severity,
        rule: decision.rule, reason: decision.reason,
      });

      // Halt: also emit dedicated halt line for operator grep.
      if (decision.severity === "halt") {
        await this.audit.emit({
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
        const denial = {
          outcome: "deny", severity: "halt",
          rule: decision.rule,
          reason: `${decision.reason} (no humanChannel registered)`,
        };
        await this.audit.emit({
          phase: "gate", action,
          decision: "deny", severity: "halt",
          rule: denial.rule, reason: denial.reason,
        });
        return denial;
      }

      const event = {
        kind: decision.severity === "halt" ? "halt" : "ask",
        action: decision.severity === "halt" ? null : action,
        severity: decision.severity,
        rule: decision.rule,
        reason: decision.reason,
        context: await this.haltContext(),
      };

      let response;
      try {
        const channelPromise = this.humanChannel(event);
        if (this.humanChannelTimeoutMs != null && this.humanChannelTimeoutMs > 0) {
          const TIMEOUT = Symbol("humanChannelTimeout");
          let timer;
          const timeoutPromise = new Promise((resolve) => {
            timer = setTimeout(() => resolve(TIMEOUT), this.humanChannelTimeoutMs);
            if (typeof timer.unref === "function") timer.unref();
          });
          const raced = await Promise.race([channelPromise, timeoutPromise]);
          clearTimeout(timer);
          if (raced === TIMEOUT) {
            const reason = `humanChannel timeout after ${this.humanChannelTimeoutMs}ms`;
            await this.audit.emit({
              phase: "approval", action,
              decision: "deny", reason,
            });
            return { outcome: "deny", severity: "halt", rule: decision.rule, reason };
          }
          response = raced;
        } else {
          response = await channelPromise;
        }
      }
      catch (err) {
        await this.audit.emit({
          phase: "approval", action,
          decision: "deny", reason: `humanChannel threw: ${err.message}`,
        });
        return { outcome: "deny", severity: "halt", rule: decision.rule,
                 reason: `humanChannel threw: ${err.message}` };
      }

      const human = response ?? { decision: "deny", reason: "humanChannel returned nothing" };
      await this.audit.emit({
        phase: "approval", action,
        decision: human.decision, reason: human.reason ?? null,
        newCap: human.newCap ?? null,
      });

      if (human.decision === "allow") {
        const decided = { outcome: "allow", severity: "action", rule: "humanChannel.allow", reason: human.reason ?? null };
        await this.audit.emit({
          phase: "gate", action,
          decision: "allow", severity: "action",
          rule: decided.rule, reason: decided.reason,
        });
        return decided;
      }
      if (human.decision === "deny") {
        const decided = {
          outcome: "deny",
          severity: decision.severity, // preserve halt vs action source
          rule: decision.rule,
          reason: human.reason ?? "human denied",
        };
        await this.audit.emit({
          phase: "gate", action,
          decision: "deny", severity: decided.severity,
          rule: decided.rule, reason: decided.reason,
        });
        return decided;
      }
      if (human.decision === "topup") {
        if (decision.severity !== "halt") {
          // topup only meaningful for halt; for ask events, treat as allow.
          const decided = { outcome: "allow", severity: "action", rule: "humanChannel.allow", reason: "topup-on-ask treated as allow" };
          return decided;
        }
        if (typeof human.newCap !== "number" || !isFinite(human.newCap)) {
          return { outcome: "deny", severity: "halt", rule: decision.rule, reason: "topup with invalid newCap" };
        }
        const dimension = this._haltDimension(decision.rule);
        if (!dimension) {
          return { outcome: "deny", severity: "halt", rule: decision.rule, reason: "topup not applicable to this rule" };
        }
        const oldCap = this._haltCap(decision.rule);
        await this.budget.raiseCap(dimension, human.newCap);
        await this.audit.emit({
          phase: "topup", action: null,
          dimension, oldCap, newCap: human.newCap,
        });
        if (++iterations > MAX_TOPUP_ITERATIONS) {
          return { outcome: "deny", severity: "halt", rule: decision.rule,
                   reason: `topup loop exceeded ${MAX_TOPUP_ITERATIONS} iterations` };
        }
        // re-evaluate gate.check in the next loop iteration
        continue;
      }
      if (human.decision === "terminate") {
        await this.terminate(human.reason ?? "human chose terminate");
        return { outcome: "deny", severity: "halt", rule: "gate.terminated",
                 reason: human.reason ?? "human chose terminate" };
      }

      // Unknown decision: defensive deny.
      return {
        outcome: "deny", severity: "halt", rule: decision.rule,
        reason: `humanChannel returned unknown decision: ${human.decision}`,
      };
    }
  }

  async record(action, result) {
    if (!this._initialized) await this.init();
    this.limits.tick();
    if (action?.type === "spawn") this.limits.noteSpawn();
    await this.budget.record(result);
    await this.audit.emit({
      phase: "record", action,
      decision: null, severity: null, rule: null, reason: null, result,
    });
  }

  // Convenience: gate.check + execute + gate.record. Caller supplies executor.
  async run(action, executor) {
    const decision = await this.check(action);
    if (decision.outcome !== "allow") {
      return structuredError(decision, action);
    }
    const result = await executor(action);
    await this.record(action, result);
    return result;
  }

  async raiseCap(dimension, newCap) {
    if (!this._initialized) await this.init();
    const oldCap = dimension === "costUsd" ? this.budget.capUsd : this.budget.capTokens;
    await this.budget.raiseCap(dimension, newCap);
    await this.audit.emit({
      phase: "topup", action: null,
      dimension, oldCap, newCap,
    });
  }

  async terminate(reason) {
    if (!this._initialized) await this.init();
    if (this.terminated) return { ok: true, alreadyTerminated: true };
    this.terminated = true;
    await this.audit.emit({
      phase: "terminate", action: null, reason,
    });
    return { ok: true };
  }

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

  _haltDimension(rule) {
    if (rule === "budget.maxCostUsd") return "costUsd";
    if (rule === "budget.maxTokens")  return "tokens";
    if (rule === "limits.maxTurns")   return "turns";
    return null;
  }
  _haltSpent(rule) {
    if (rule === "budget.maxCostUsd") return this.budget.spentUsd;
    if (rule === "budget.maxTokens")  return this.budget.spentTokens;
    if (rule === "limits.maxTurns")   return this.limits.turns;
    return null;
  }
  _haltCap(rule) {
    if (rule === "budget.maxCostUsd") return this.budget.capUsd;
    if (rule === "budget.maxTokens")  return this.budget.capTokens;
    if (rule === "limits.maxTurns")   return this.limits.maxTurns;
    return null;
  }
}
