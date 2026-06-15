// Single-file JSONL audit (PRD v0.5 §14). All processes append to one file
// using O_APPEND atomicity (POSIX guarantees atomic writes < PIPE_BUF).
// No lock on emit on Linux/macOS. Windows falls back to proper-lockfile.
// Each line carries run_id / parent_run_id / spawn_depth.

import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import lockfile from "proper-lockfile";

const MAX_LINE_BYTES = 3500; // safety margin under PIPE_BUF (4096 on Linux/macOS)
const NEEDS_LOCK = process.platform === "win32";

/**
 * Resolve the default audit file path: XDG_STATE_HOME, then ~/.local/state, then cwd.
 * @param {string} rootRunId root run id used in the filename
 * @returns {string} absolute path to the per-family JSONL audit file
 */
function defaultAuditPath(rootRunId) {
  const xdgState = process.env.XDG_STATE_HOME;
  const home = os.homedir();
  if (xdgState) return path.join(xdgState, "bareguard", `${rootRunId}.jsonl`);
  if (home)     return path.join(home, ".local", "state", "bareguard", `${rootRunId}.jsonl`);
  return path.join(process.cwd(), `bareguard-${rootRunId}.jsonl`);
}

/**
 * Single-file JSONL audit log (or fileless in-memory mode when filePath is null).
 */
export class Audit {
  /**
   * @param {object} opts
   * @param {string|null} [opts.filePath] audit file path; null = fileless in-memory mode; undefined = XDG/home/cwd default
   * @param {string} opts.runId this run's id
   * @param {string|null} [opts.parentRunId] parent run id, if spawned
   * @param {number} [opts.spawnDepth] spawn depth (default 0)
   * @param {string} [opts.rootRunId] root run id (default runId)
   * @param {() => number} [opts.clock] millisecond clock (default Date.now)
   * @param {((x: *) => *)|null} [opts.redact] optional redactor applied to action/result/reason at emit time
   */
  constructor({ filePath, runId, parentRunId, spawnDepth, rootRunId, clock, redact }) {
    this.runId = runId;
    this.parentRunId = parentRunId ?? null;
    this.spawnDepth = spawnDepth ?? 0;
    this.rootRunId = rootRunId ?? runId;
    // Optional redactor (from gate, when `secrets` is configured). Applied to
    // action/result at emit time so the persisted log is clean — eval runs on
    // the real action upstream, so policy matching is never weakened.
    this._redact = redact ?? null;
    // filePath === null  → fileless in-memory mode (B4, v0.4).
    // filePath undefined → use XDG / home / cwd default.
    this.filePath = filePath === null
      ? null
      : (filePath ?? defaultAuditPath(this.rootRunId));
    this.fileless = this.filePath === null;
    this.entries = [];                 // populated only in fileless mode
    this.seq = 0;
    this._clock = clock ?? (() => Date.now());
  }

  /**
   * Create the audit directory and touch the file (no-op in fileless mode).
   * @returns {Promise<void>}
   */
  async init() {
    const { filePath } = this;
    if (filePath === null) return; // fileless mode
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    // touch the file so subsequent appends always have a target
    const fh = await fsp.open(filePath, "a");
    await fh.close();
  }

  /**
   * Append one audit line: stamps ts/seq/run ids, applies redaction, and writes (atomic append or in-memory push).
   * @param {object} fields caller-supplied line fields (e.g. phase, action, decision, severity, rule, reason, result)
   * @returns {Promise<void>}
   */
  async emit(fields) {
    const line = {
      ts: new Date(this._clock()).toISOString(),
      seq: ++this.seq,
      run_id: this.runId,
      parent_run_id: this.parentRunId,
      spawn_depth: this.spawnDepth,
      ...fields,
    };
    if (this._redact) {
      if (line.action) line.action = this._redact(line.action);
      if (line.result) line.result = this._redact(line.result);
      // reason strings can echo action-derived data (e.g. net.invalidUrl puts
      // the full URL in the reason), so redact them too.
      if (typeof line.reason === "string") line.reason = this._redact(line.reason);
      // Axis-B annotate lines carry reply-derived `where`/`meta` (gate.annotate);
      // redact them too so the persisted log keeps the "no raw secrets" guarantee.
      if (typeof line.where === "string") line.where = this._redact(line.where);
      if (line.meta != null && typeof line.meta === "object") line.meta = this._redact(line.meta);
    }
    const { filePath } = this;
    if (filePath === null) {
      // Fileless mode. No PIPE_BUF concern in-memory; skip truncation. Tests
      // assert on entries verbatim — keep them intact.
      this.entries.push(line);
      return;
    }
    let serialized = JSON.stringify(line) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) {
      // Truncate all large action fields and result strings to keep the line
      // atomic on POSIX FS (PIPE_BUF). Tag root with _truncated:true so
      // downstream consumers can filter without inspecting string contents.
      const truncated = { ...line, _truncated: true };
      if (truncated.action) {
        const newAction = { ...truncated.action };
        for (const k of Object.keys(newAction)) {
          const v = newAction[k];
          if (v !== null && typeof v === "object") {
            const bytes = Buffer.byteLength(JSON.stringify(v), "utf8");
            if (bytes > 200) newAction[k] = `[TRUNCATED:${bytes} bytes]`;
          } else if (typeof v === "string" && Buffer.byteLength(v, "utf8") > 200) {
            newAction[k] = v.slice(0, 200) + "[TRUNCATED]";
          }
        }
        truncated.action = newAction;
      }
      if (truncated.result) {
        truncated.result = { ...truncated.result };
        for (const k of Object.keys(truncated.result)) {
          if (typeof truncated.result[k] === "string" && truncated.result[k].length > 200) {
            truncated.result[k] = truncated.result[k].slice(0, 200) + "[TRUNCATED]";
          }
        }
      }
      serialized = JSON.stringify(truncated) + "\n";
    }
    if (NEEDS_LOCK) {
      // Windows: O_APPEND cross-process atomicity not guaranteed.
      // Acquire a lock on the audit file for the duration of the write.
      const release = await lockfile.lock(filePath, {
        retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
        stale: 10_000,
      });
      try { await fsp.appendFile(filePath, serialized); }
      finally { try { await release(); } catch { /* unlock failure non-fatal */ } }
    } else {
      // Linux/macOS: kernel guarantees atomic appends below PIPE_BUF.
      await fsp.appendFile(filePath, serialized);
    }
  }

  /**
   * Read all audit lines as parsed objects (shallow copy in fileless mode; empty array if the file is missing).
   * @returns {Promise<object[]>}
   */
  async readAll() {
    // Fileless: shallow copy of the entries array (line objects shared
    // by reference). Fileless mode is test-only per PRD §12 — tests
    // should treat entries as read-only; mutating nested fields would
    // corrupt the live in-memory log.
    const { filePath } = this;
    if (filePath === null) return this.entries.slice(); // fileless mode
    try {
      const buf = await fsp.readFile(filePath, "utf8");
      return buf.split("\n").filter(Boolean).map(l => JSON.parse(l));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }
}

export { defaultAuditPath };
