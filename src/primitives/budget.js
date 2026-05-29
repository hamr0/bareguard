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
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

const FORMAT_VERSION = 1;

/**
 * Thrown when the shared budget file cannot be read, locked, or is an unsupported version.
 */
export class BudgetUnavailableError extends Error {
  /**
   * @param {string} detail human-readable cause appended to the message
   */
  constructor(detail) {
    super(`Budget file unavailable: ${detail}`);
    this.name = "BudgetUnavailableError";
  }
}

const STRICT_BUF_SIZE = 5;
const STRICT_MIN_SAMPLES = 3;

/**
 * Tracks USD/token spend against caps, optionally persisted to a shared cross-process file.
 */
export class Budget {
  /**
   * @param {object} [cfg] budget config
   * @param {number} [cfg.maxCostUsd] USD cap (default Infinity)
   * @param {number} [cfg.maxTokens] token cap (default Infinity)
   * @param {string|null} [cfg.sharedFile] path to the shared budget JSON file (null = local in-memory)
   * @param {boolean} [cfg.strict] enable trailing-average pre-flight halts (default false)
   */
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

  /**
   * Load state from the shared file, or seed it (optionally rebuilding spend/caps from the audit log).
   * @param {object} [opts]
   * @param {() => Promise<{spentUsd?:number,spentTokens?:number,capUsd?:(number|null),capTokens?:(number|null)}>} [opts.rebuildFromAudit] called when the file is missing/corrupt to reconstruct totals
   * @returns {Promise<void>}
   * @throws {BudgetUnavailableError} on unsupported version or unreadable file
   */
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
    // Atomic write: serialize to a unique temp file, then rename over the
    // target. rename(2) is atomic within a filesystem (and libuv maps it to an
    // atomic replace on Windows), so a reader — even one racing the lock — sees
    // a COMPLETE old or new file, never the zero-length window that a plain
    // `writeFile` (open O_TRUNC, then write) exposes. That window is what made
    // record()'s under-lock read intermittently throw "Unexpected end of JSON
    // input" (a real-corruption signal) under concurrent load.
    const tmp = `${this.sharedFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
      await fsp.rename(tmp, this.sharedFile);
    } catch (err) {
      try { await fsp.unlink(tmp); } catch { /* best-effort cleanup */ }
      throw err;
    }
  }

  async _withLock(fn) {
    if (!this.sharedFile) return fn();
    try { await fsp.access(this.sharedFile); }
    catch { await this._write(); }
    let release;
    try {
      release = await lockfile.lock(this.sharedFile, {
        retries: { retries: 10, minTimeout: 30, maxTimeout: 300 }, // ~2.25s total
        // `stale`: how long a held lock may exist before another process treats
        // it as abandoned and STEALS it. record()'s critical section is
        // sub-millisecond, so a steal — which puts two writers in the section
        // and silently loses an update — requires the holder to be frozen this
        // long. Raised 10s → 20s to shrink that window. The retry budget above
        // (~2.25s) stays well under `stale`, so a process merely WAITING on a
        // live holder always throws before it would steal — steal-during-
        // contention is exactly what would re-open the lost-update gap.
        // Tradeoff to know: a holder hard-killed mid-lock is NOT released
        // (SIGKILL doesn't fire proper-lockfile's signal-exit cleanup, and a
        // frozen holder can't run handlers); record() then throws
        // BudgetUnavailableError until the lock ages past `stale` and can be
        // stolen. That's fail-safe (halt, never overspend), so a longer `stale`
        // trades a slightly longer post-hard-kill outage for stronger
        // lost-update protection.
        stale: 20_000,
      });
    } catch (err) {
      throw new BudgetUnavailableError(`lock failed: ${err.message}`);
    }
    try { return await fn(); }
    finally { try { await release(); } catch { /* unlock failure is non-fatal */ } }
  }

  /**
   * Synchronous halt check against the local cache: post-fact over-cap, then (in strict mode) trailing-avg pre-flight.
   * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} halt decision, or null if within budget
   */
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

  /**
   * Re-read spend and caps from the shared file into the local cache (no-op when local-only or file missing).
   * @returns {Promise<void>}
   * @throws on unexpected (non-ENOENT, non-version, non-syntax) read errors
   */
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

  /**
   * Add a result's spend deltas to the budget (atomic read-modify-write under lock when shared).
   * @param {object} [result] execution result
   * @param {number} [result.costUsd] USD spent (default 0)
   * @param {number} [result.tokens] tokens spent (default 0)
   * @returns {Promise<void>}
   * @throws {BudgetUnavailableError} if the shared file can't be read under the held lock
   */
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
    const sharedFile = this.sharedFile; // non-null past the guard above
    await this._withLock(async () => {
      let s;
      try {
        s = JSON.parse(await fsp.readFile(sharedFile, "utf8"));
      } catch (err) {
        // Under a held lock the file is always present and well-formed
        // (init() seeds it; _withLock re-creates it if missing). A read/parse
        // failure here means real corruption or fs trouble — do NOT fall back
        // to `spentUsd += dUsd`, which writes stale local state over the
        // committed total and silently loses spend. Fail loud so the run halts
        // rather than overspends against a budget file it can't read.
        throw new BudgetUnavailableError(`record could not read budget file: ${err.message}`);
      }
      this.spentUsd    = (s.spent_usd ?? 0)    + dUsd;
      this.spentTokens = (s.spent_tokens ?? 0) + dTok;
      this.capUsd      = s.cap_usd      ?? this.capUsd;
      this.capTokens   = s.cap_tokens   ?? this.capTokens;
      this.startedAt   = s.started_at   ?? this.startedAt;
      await this._write();
    });
  }

  /**
   * Set a budget cap to a new value (raise or lower) and persist it atomically.
   * @param {"costUsd"|"tokens"} dimension which cap to set
   * @param {number} newCap new cap (finite, >= 0)
   * @returns {Promise<void>}
   * @throws {Error} on unknown dimension or invalid newCap
   */
  async raiseCap(dimension, newCap) {
    if (!["costUsd", "tokens"].includes(dimension)) {
      throw new Error(`unknown budget dimension: ${dimension}`);
    }
    // A negative or non-finite cap is never meaningful — a negative cap makes
    // `spent >= cap` permanently true, silently wedging the run in halt.
    // Lowering a positive cap is allowed (tightening a budget is safe).
    if (typeof newCap !== "number" || !isFinite(newCap) || newCap < 0) {
      throw new Error(`invalid budget cap: ${newCap} (must be a finite number >= 0)`);
    }
    await this._withLock(async () => {
      const sharedFile = this.sharedFile;
      if (sharedFile) {
        try {
          const buf = await fsp.readFile(sharedFile, "utf8");
          const s = JSON.parse(buf);
          this.spentUsd    = s.spent_usd    ?? this.spentUsd;
          this.spentTokens = s.spent_tokens ?? this.spentTokens;
          this.capUsd      = s.cap_usd      ?? this.capUsd;
          this.capTokens   = s.cap_tokens   ?? this.capTokens;
        } catch { /* keep local */ }
      }
      if (dimension === "costUsd") this.capUsd = newCap;
      else this.capTokens = newCap;
      await this._write();
    });
  }
}
