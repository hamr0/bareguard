// budget primitive (PRD §8 row 2, §13). Halt severity. Shared file across
// processes via proper-lockfile. Lazy refresh per amendment §17.
//
// File format (versioned per amendment §16):
//   {
//     "version": 1,
//     "cap_usd": 5.00,  "spent_usd": 1.23,
//     "cap_tokens": 100000, "spent_tokens": 24500,
//     "started_at": "...", "updated_at": "..."
//   }

import { promises as fsp } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

const FORMAT_VERSION = 1;

export class BudgetUnavailableError extends Error {
  constructor(detail) {
    super(`Budget file unavailable: ${detail}`);
    this.name = "BudgetUnavailableError";
  }
}

const STRICT_BUF_SIZE = 5;
const STRICT_MIN_SAMPLES = 3;

export class Budget {
  constructor(cfg = {}) {
    this.capUsd = cfg.maxCostUsd ?? Infinity;
    this.capTokens = cfg.maxTokens ?? Infinity;
    this.sharedFile = cfg.sharedFile ?? null;
    this.spentUsd = 0;
    this.spentTokens = 0;
    this.startedAt = new Date().toISOString();
    // Strict mode (v0.4, PRD §13.1): pre-flight halt when
    // spent + trailing-avg projection would exceed the cap. Opt-in.
    // Rolling buffers are per-instance and local-only — in shared-file
    // multi-process setups each Budget sees only its own deltas.
    this.strict = cfg.strict ?? false;
    this._costBuf = [];
    this._tokenBuf = [];
  }

  async init({ rebuildFromAudit } = {}) {
    if (!this.sharedFile) return;
    await fsp.mkdir(path.dirname(this.sharedFile), { recursive: true });
    let existing = null;
    try {
      const buf = await fsp.readFile(this.sharedFile, "utf8");
      existing = JSON.parse(buf);
      if (existing.version !== FORMAT_VERSION) {
        throw new BudgetUnavailableError(`unsupported file version ${existing.version}; expected ${FORMAT_VERSION}`);
      }
      this.capUsd      = existing.cap_usd      ?? this.capUsd;
      this.capTokens   = existing.cap_tokens   ?? this.capTokens;
      this.spentUsd    = existing.spent_usd    ?? 0;
      this.spentTokens = existing.spent_tokens ?? 0;
      this.startedAt   = existing.started_at   ?? this.startedAt;
    } catch (err) {
      if (err.code === "ENOENT" || err instanceof SyntaxError) {
        if (rebuildFromAudit) {
          const rebuilt = await rebuildFromAudit();
          this.spentUsd    = rebuilt.spentUsd ?? 0;
          this.spentTokens = rebuilt.spentTokens ?? 0;
          if (rebuilt.capUsd != null)    this.capUsd    = rebuilt.capUsd;
          if (rebuilt.capTokens != null) this.capTokens = rebuilt.capTokens;
        }
        await this._write();
      } else if (err instanceof BudgetUnavailableError) {
        throw err;
      } else {
        throw new BudgetUnavailableError(err.message);
      }
    }
  }

  async _write() {
    if (!this.sharedFile) return;
    const state = {
      version:       FORMAT_VERSION,
      cap_usd:       this.capUsd,
      spent_usd:     this.spentUsd,
      cap_tokens:    this.capTokens,
      spent_tokens:  this.spentTokens,
      started_at:    this.startedAt,
      updated_at:    new Date().toISOString(),
    };
    await fsp.writeFile(this.sharedFile, JSON.stringify(state, null, 2));
  }

  async _withLock(fn) {
    if (!this.sharedFile) return fn();
    try { await fsp.access(this.sharedFile); }
    catch { await this._write(); }
    let release;
    try {
      release = await lockfile.lock(this.sharedFile, {
        retries: { retries: 10, minTimeout: 30, maxTimeout: 300 },
        stale: 10_000,
      });
    } catch (err) {
      throw new BudgetUnavailableError(`lock failed: ${err.message}`);
    }
    try { return await fn(); }
    finally { try { await release(); } catch { /* unlock failure is non-fatal */ } }
  }

  // synchronous decision check using the local cache (no file I/O).
  // Refresh policy is the gate's job — it calls refresh() on lock acquisition / post-record.
  check() {
    // 1. Post-fact halt: already at or over cap.
    if (this.spentUsd >= this.capUsd) {
      return {
        outcome: "askHuman", severity: "halt", rule: "budget.maxCostUsd",
        reason: `spent $${this.spentUsd.toFixed(4)} >= cap $${this.capUsd.toFixed(2)}`,
      };
    }
    if (this.spentTokens >= this.capTokens) {
      return {
        outcome: "askHuman", severity: "halt", rule: "budget.maxTokens",
        reason: `spent ${this.spentTokens} tokens >= cap ${this.capTokens}`,
      };
    }
    // 2. Strict pre-flight: project next action via trailing avg; halt if
    // projection would exceed cap. Requires ≥3 samples to avoid cold-start
    // false halts. Per-dimension; runs after post-fact so reason strings
    // stay distinct.
    if (this.strict) {
      if (this._costBuf.length >= STRICT_MIN_SAMPLES) {
        const avg = this._costBuf.reduce((a, b) => a + b, 0) / this._costBuf.length;
        if (this.spentUsd + avg > this.capUsd) {
          return {
            outcome: "askHuman", severity: "halt", rule: "budget.maxCostUsd",
            reason: `strict: spent $${this.spentUsd.toFixed(4)} + est $${avg.toFixed(4)} > cap $${this.capUsd.toFixed(2)}`,
          };
        }
      }
      if (this._tokenBuf.length >= STRICT_MIN_SAMPLES) {
        const avg = this._tokenBuf.reduce((a, b) => a + b, 0) / this._tokenBuf.length;
        if (this.spentTokens + avg > this.capTokens) {
          return {
            outcome: "askHuman", severity: "halt", rule: "budget.maxTokens",
            reason: `strict: spent ${this.spentTokens} + est ${avg.toFixed(0)} > cap ${this.capTokens}`,
          };
        }
      }
    }
    return null;
  }

  _pushBuf(dUsd, dTok) {
    if (!this.strict) return;
    // Per-dimension: only push real spend so the projection reflects actual
    // cost behaviour. Zero-delta records (e.g. free tools, defer emits)
    // would otherwise drag the trailing avg below the agent's real cost
    // profile and delay strict halts past the documented semantics.
    if (dUsd > 0) { this._costBuf.push(dUsd);  if (this._costBuf.length  > STRICT_BUF_SIZE) this._costBuf.shift(); }
    if (dTok > 0) { this._tokenBuf.push(dTok); if (this._tokenBuf.length > STRICT_BUF_SIZE) this._tokenBuf.shift(); }
  }

  async refresh() {
    if (!this.sharedFile) return;
    try {
      const buf = await fsp.readFile(this.sharedFile, "utf8");
      const s = JSON.parse(buf);
      if (s.version !== FORMAT_VERSION) throw new BudgetUnavailableError(`version ${s.version}`);
      this.spentUsd    = s.spent_usd    ?? this.spentUsd;
      this.spentTokens = s.spent_tokens ?? this.spentTokens;
      this.capUsd      = s.cap_usd      ?? this.capUsd;
      this.capTokens   = s.cap_tokens   ?? this.capTokens;
    } catch (err) {
      if (err.code !== "ENOENT") {
        // surface unexpected errors; keep local cache on missing file
        if (!(err instanceof BudgetUnavailableError) && !(err instanceof SyntaxError)) throw err;
      }
    }
  }

  async record(result) {
    const dUsd = result?.costUsd ?? 0;
    const dTok = result?.tokens ?? 0;
    this._pushBuf(dUsd, dTok);
    if (dUsd === 0 && dTok === 0 && !this.sharedFile) {
      return; // nothing to do
    }
    if (!this.sharedFile) {
      this.spentUsd += dUsd;
      this.spentTokens += dTok;
      return;
    }
    await this._withLock(async () => {
      try {
        const buf = await fsp.readFile(this.sharedFile, "utf8");
        const s = JSON.parse(buf);
        this.spentUsd    = (s.spent_usd ?? 0)    + dUsd;
        this.spentTokens = (s.spent_tokens ?? 0) + dTok;
        this.capUsd      = s.cap_usd      ?? this.capUsd;
        this.capTokens   = s.cap_tokens   ?? this.capTokens;
        this.startedAt   = s.started_at   ?? this.startedAt;
      } catch {
        this.spentUsd += dUsd;
        this.spentTokens += dTok;
      }
      await this._write();
    });
  }

  async raiseCap(dimension, newCap) {
    if (!["costUsd", "tokens"].includes(dimension)) {
      throw new Error(`unknown budget dimension: ${dimension}`);
    }
    await this._withLock(async () => {
      try {
        const buf = await fsp.readFile(this.sharedFile, "utf8");
        const s = JSON.parse(buf);
        this.spentUsd    = s.spent_usd    ?? this.spentUsd;
        this.spentTokens = s.spent_tokens ?? this.spentTokens;
        this.capUsd      = s.cap_usd      ?? this.capUsd;
        this.capTokens   = s.cap_tokens   ?? this.capTokens;
      } catch { /* keep local */ }
      if (dimension === "costUsd") this.capUsd = newCap;
      else this.capTokens = newCap;
      await this._write();
    });
  }
}
