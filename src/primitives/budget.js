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

export class Budget {
  constructor(cfg = {}) {
    this.capUsd = cfg.maxCostUsd ?? Infinity;
    this.capTokens = cfg.maxTokens ?? Infinity;
    this.sharedFile = cfg.sharedFile ?? null;
    this.spentUsd = 0;
    this.spentTokens = 0;
    this.startedAt = new Date().toISOString();
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
    return null;
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
