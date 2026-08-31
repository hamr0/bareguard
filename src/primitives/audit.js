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
      // Axis-B annotate lines carry reply-derived `where`/`verdict`/`meta`
      // (gate.annotate); redact them too so the persisted log keeps the "no raw
      // secrets" guarantee. `verdict` is a free-text field the caller's judge
      // writes — it was missed by the 0.7.0 pass that covered `where`/`meta`, so a
      // judge echoing a key into its verdict wrote it to the shared audit file raw.
      if (typeof line.where === "string") line.where = this._redact(line.where);
      if (typeof line.verdict === "string") line.verdict = this._redact(line.verdict);
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
      // Re-bound every field that can carry caller-controlled or redaction-
      // expanded text — action, result, where, verdict, reason, meta — to keep
      // the line atomic on POSIX FS (PIPE_BUF). Tag root with _truncated:true so
      // downstream consumers can filter without inspecting string contents.
      // INVARIANT: any field added to the redactor must ALSO be re-bounded here;
      // omitting one silently reopens the atomicity hole (0.13.0 `verdict`,
      // and `reason`, were each found that way).
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
      // Axis-B annotate lines carry `where`/`meta`. They are size-bounded at the
      // source (gate.annotate), but redaction runs AFTER that bound and can EXPAND
      // a field ([REDACTED:...] per match), so re-bound them here like result —
      // otherwise the atomicity guarantee leaks for secret-heavy reply text.
      if (typeof truncated.where === "string" && Buffer.byteLength(truncated.where, "utf8") > 200) {
        truncated.where = truncated.where.slice(0, 200) + "[TRUNCATED]";
      }
      // `verdict` is redacted too, so it expands too, so it must be re-bounded too.
      // Adding a field to the redactor without adding it here reopens the atomicity
      // hole: redaction runs pattern-by-pattern over ALREADY-redacted text, so a
      // later pattern matching the `[REDACTED:…]` marker an earlier one inserted
      // compounds (measured: an 80-char verdict reached 63 KB across 5 patterns).
      if (typeof truncated.verdict === "string" && Buffer.byteLength(truncated.verdict, "utf8") > 200) {
        truncated.verdict = truncated.verdict.slice(0, 200) + "[TRUNCATED]";
      }
      // `reason` is redacted too, and every rule that echoes caller data into it
      // (tools `action.type`, fs `path`, net `url`/`host`, flags field values,
      // humanChannel `err.message`) is unbounded at the source — there is no
      // per-field cap upstream the way `where`/`meta` have one. So it is both
      // unbounded AND expanded by redaction: measured 4510 bytes at DEFAULT
      // config from a long `action.type` alone, and 60,408 bytes once three
      // broad patterns compound over each other's markers.
      if (typeof truncated.reason === "string" && Buffer.byteLength(truncated.reason, "utf8") > 200) {
        truncated.reason = truncated.reason.slice(0, 200) + "[TRUNCATED]";
      }
      if (truncated.meta != null && typeof truncated.meta === "object") {
        const bytes = Buffer.byteLength(JSON.stringify(truncated.meta), "utf8");
        if (bytes > 200) truncated.meta = { _truncated: true, bytes };
      }
      serialized = JSON.stringify(truncated) + "\n";

      // THE LINE BOUND. Everything above is PER FIELD, and a per-field bound is
      // not a line bound: `action`/`result` cap each VALUE at 200 bytes but
      // never the key COUNT, so 200 keys of 190 bytes passed every check above
      // and still produced a 40,197-byte line stamped `_truncated: true`.
      // `meta` was never vulnerable because it collapses the WHOLE object once
      // its total exceeds 200 — that is the shape the guarantee actually needs.
      // The promise is about the LINE, so it is enforced on the line: collapse
      // the payload wholesale, then, if even that does not fit, keep only the
      // fields a consumer needs to route and correlate the entry.
      if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) {
        for (const k of ["action", "result"]) {
          if (truncated[k] != null && typeof truncated[k] === "object") {
            truncated[k] = { _truncated: true, bytes: Buffer.byteLength(JSON.stringify(truncated[k]), "utf8") };
          }
        }
        serialized = JSON.stringify(truncated) + "\n";
      }
      if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) {
        // Last resort: keep every SCALAR field and drop the object payloads.
        // NOT REACHABLE by any input I could construct — every field that can
        // carry caller data is bounded above, so collapsing action/result has
        // always sufficed. It is kept as an unconditional backstop so the
        // invariant "the persisted line is <= MAX_LINE_BYTES" holds by
        // construction rather than by enumerating today's fields, which is the
        // enumeration that failed twice (`verdict` in 0.13.0, `reason` here).
        // No test kills this branch; that is a known gap, not a claim of cover.
        // Deliberately generic rather than an allowlist of field names — a
        // hardcoded list silently drops any field added later, and the line's
        // routing/correlation fields (ts, seq, run_id, parent_run_id, aid,
        // phase, decision, severity, rule) are all scalars by construction.
        const minimal = {};
        for (const [k, v] of Object.entries(truncated)) {
          if (v === null || typeof v !== "object") {
            minimal[k] = typeof v === "string" && Buffer.byteLength(v, "utf8") > 120
              ? v.slice(0, 120) + "[TRUNCATED]"
              : v;
          }
        }
        minimal._truncated = true;
        minimal._dropped = "line exceeded MAX_LINE_BYTES after field truncation";
        serialized = JSON.stringify(minimal) + "\n";
      }
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
