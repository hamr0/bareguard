// Single-file JSONL audit (PRD v0.5 §14). All processes append to one file
// using O_APPEND atomicity (POSIX guarantees atomic writes < PIPE_BUF).
// No lock on emit on Linux/macOS. Windows falls back to proper-lockfile.
// Each line carries run_id / parent_run_id / spawn_depth.

import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import lockfile from "proper-lockfile";

const MAX_LINE_BYTES = 3500; // safety margin under PIPE_BUF (4096 on Linux/macOS)
const FIELD_BYTE_CAP = 200;  // per-field bound inside an oversize line

/**
 * The audit line's caller-controlled fields, declared ONCE. Both passes that
 * touch them — redaction and the oversize re-bound — are driven from this table.
 *
 * Keeping two hand-written enumerations in sync is the bug this file has now
 * shipped four times: `where`/`meta` re-bound but `verdict` missed (0.13.0, an
 * 80-char verdict reached 63,669 bytes), then `verdict` covered but `reason`
 * missed (60,408 bytes), then every VALUE bounded but the key COUNT unbounded
 * (40,197 bytes), then every bound taken in UTF-16 units instead of bytes (611
 * against a claimed 211). Four recurrences, one cause: a field could be added to
 * one list and forgotten in the other. It cannot now — a field is one row, and
 * redaction and bounding both read it.
 *
 * This coupling is not stylistic. Redaction EXPANDS text (`[REDACTED:…]` per
 * match, compounding when a later pattern matches an earlier marker), so a field
 * that is redacted but NOT re-bounded is precisely how the atomic-append
 * guarantee breaks.
 *
 * `redactIf` is the field's existing presence test, kept per-row rather than
 * generalized, so this table changes no behavior on the fields it replaces.
 * `bound`: `perKey` walks the object's own values; `wholesale` replaces the
 * whole object once it exceeds the cap; `clip` byte-truncates a string.
 * @type {ReadonlyArray<{key:string,redactIf:(v:any)=>boolean,bound:"perKey"|"wholesale"|"clip"}>}
 */
const LINE_FIELDS = Object.freeze([
  // `action`/`result` carry arbitrary caller payloads.
  Object.freeze({ key: "action",  redactIf: (v) => Boolean(v),                         bound: "perKey" }),
  Object.freeze({ key: "result",  redactIf: (v) => Boolean(v),                         bound: "perKey" }),
  // `reason` echoes caller data from every rule that names what it denied
  // (tools `action.type`, fs `path`, net `url`/`host`, flags field values,
  // humanChannel `err.message`) and is unbounded at the source.
  Object.freeze({ key: "reason",  redactIf: (v) => typeof v === "string",              bound: "clip" }),
  // Axis-B annotate lines carry reply-derived `where`/`verdict`/`meta`. These are
  // capped at the source by gate.annotate, but redaction runs AFTER that cap.
  Object.freeze({ key: "where",   redactIf: (v) => typeof v === "string",              bound: "clip" }),
  Object.freeze({ key: "verdict", redactIf: (v) => typeof v === "string",              bound: "clip" }),
  Object.freeze({ key: "meta",    redactIf: (v) => v != null && typeof v === "object", bound: "wholesale" }),
]);

/** Keys whose object payload collapses wholesale when the LINE is still oversize. */
const PAYLOAD_KEYS = Object.freeze(LINE_FIELDS.filter((f) => f.bound === "perKey").map((f) => f.key));

/**
 * Bound one object's own values in place on a copy: a nested object over the cap
 * becomes a size marker, a string is byte-clipped. Shared by `action` and
 * `result` — they were two near-identical loops that had drifted (`result` never
 * bounded its nested objects), which is the same divergence-by-hand this table
 * exists to remove.
 * @param {object} obj object to bound
 * @returns {object} a bounded copy
 */
function boundOwnValues(obj) {
  const out = { ...obj };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v !== null && typeof v === "object") {
      const bytes = Buffer.byteLength(JSON.stringify(v), "utf8");
      if (bytes > FIELD_BYTE_CAP) out[k] = `[TRUNCATED:${bytes} bytes]`;
    } else if (typeof v === "string") {
      out[k] = clipBytes(v, FIELD_BYTE_CAP);
    }
  }
  return out;
}
const NEEDS_LOCK = process.platform === "win32";

/**
 * Truncate a string to at most `max` UTF-8 BYTES, appending a marker if it was
 * cut. Every bound in the oversize-truncation block is a BYTE bound — the line
 * cap it feeds is measured in bytes because POSIX `PIPE_BUF` is — but the block
 * used `String.prototype.slice`, which counts UTF-16 code units. A 200-unit
 * slice of CJK is 600 bytes and of astral emoji 400: measured, a `reason` of
 * 5000 CJK characters persisted at 611 bytes against a claimed 211-byte bound,
 * 2.9x over. `result` was worse still — its guard read `.length > 200`, a code-
 * unit COUNT, so a 200-character CJK value (600 bytes) was not truncated at all.
 * Neither breached `MAX_LINE_BYTES` on its own, because the wholesale-collapse
 * stage below re-bounds the line regardless; but the per-field guarantee the
 * code and CHANGELOG stated was false, and the margin it was silently eating is
 * the margin the next forgotten field will need.
 * @param {string} s value to bound
 * @param {number} max maximum UTF-8 bytes to keep before the marker
 * @returns {string} `s` unchanged if it already fits, else a byte-clipped prefix + `[TRUNCATED]`
 */
function clipBytes(s, max) {
  // A non-positive cap is nonsense, and silently wrong rather than loudly wrong:
  // `s.slice(0, -5)` means "drop the last 5 characters", not "keep none", so a
  // negative cap would return nearly the whole string while claiming a bound.
  // Unreachable today (every caller passes a fixed positive constant), kept so
  // making the cap configurable later cannot turn into a bypass.
  if (max <= 0) return "[TRUNCATED]";
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  // Slice to `max` CODE UNITS first: every code unit costs at least one byte, so
  // the first `max` bytes always live inside the first `max` units. That keeps
  // the copy bounded by `max` instead of by the length of a hostile input
  // (measured over a 150 KB value: 0.201 ms/call before, 0.040 ms after).
  let out = Buffer.from(s.slice(0, max), "utf8").subarray(0, max).toString("utf8");
  // subarray can land mid-sequence; the decoder turns the partial tail into a
  // single U+FFFD, which costs 3 bytes and can push `out` back over `max`.
  // Only the tail can split, so dropping one code unit is always enough.
  if (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1);
  return out + "[TRUNCATED]";
}

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
      for (const { key, redactIf } of LINE_FIELDS) {
        if (redactIf(line[key])) line[key] = this._redact(line[key]);
      }
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
      for (const { key, bound } of LINE_FIELDS) {
        const v = truncated[key];
        if (bound === "clip") {
          if (typeof v === "string") truncated[key] = clipBytes(v, FIELD_BYTE_CAP);
        } else if (bound === "perKey") {
          // `boundOwnValues` spreads its argument's own keys; a truthy STRING
          // spreads into a char-indexed object (`{0:'o',1:'k'}`), corrupting a
          // scalar `action`/`result` into an object — the same class the
          // `wholesale` arm already guards against two lines below.
          if (v != null && typeof v === "object") truncated[key] = boundOwnValues(v);
        } else if (v != null && typeof v === "object") { // wholesale
          const bytes = Buffer.byteLength(JSON.stringify(v), "utf8");
          if (bytes > FIELD_BYTE_CAP) truncated[key] = { _truncated: true, bytes };
        }
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
        // Largest-first, stop-when-it-fits: collapsing is destructive (it is the
        // step that drops `result.costUsd`/`.tokens`/`.pricing`/`.counts`, the
        // exact fields the cold-start budget rebuild needs), so it must not fire
        // on a field that was never the reason the line is oversize. A 29-byte
        // `result` collapsed alongside an oversize `action` used to zero a live
        // $0.50 round to $0.00 on restart for no reason — the cap-under-count is
        // a bypass, not a rounding error.
        const candidates = PAYLOAD_KEYS
          .filter((k) => truncated[k] != null && typeof truncated[k] === "object")
          .map((k) => ({ k, bytes: Buffer.byteLength(JSON.stringify(truncated[k]), "utf8") }))
          .sort((a, b) => b.bytes - a.bytes);
        for (const { k, bytes } of candidates) {
          const src = truncated[k];
          const collapsed = { _truncated: true, bytes };
          // `type` survives the collapse. It is not cosmetic: the cold-start
          // budget rebuild classifies a historical round with
          // `l.action.type !== "llm"`, so dropping it turns a collapsed llm
          // round into `undefined !== "llm"` — a TOOL round. That is the live-
          // vs-rebuilt divergence 0.9.0 closed by construction (sanitizeSpend),
          // reopened on the toolRounds dimension by this very backstop. It
          // over-counts, so it fails safe, but the two paths must not disagree.
          // Bounded by BYTES, not UTF-16 units, because it is caller-controlled
          // and the whole point of this branch is a byte budget.
          if (typeof src.type === "string") {
            collapsed.type = clipBytes(src.type, 120);
          }
          // Budget-critical scalars survive the collapse too, for the same
          // reason `type` does: `sanitizeSpend` (shared by live `record()` and
          // `_rebuildBudgetFromAudit`) reads exactly these off `result`. Losing
          // them here means a cold-start rebuild silently under-counts a round
          // that genuinely cost money — a cap bypass that fails OPEN.
          if (Number.isFinite(src.costUsd)) collapsed.costUsd = src.costUsd;
          if (Number.isFinite(src.tokens)) collapsed.tokens = src.tokens;
          if (typeof src.pricing === "string") collapsed.pricing = clipBytes(src.pricing, 32);
          if (src.counts && typeof src.counts === "object") {
            collapsed.counts = boundOwnValues(src.counts);
          }
          truncated[k] = collapsed;
          serialized = JSON.stringify(truncated) + "\n";
          if (Buffer.byteLength(serialized, "utf8") <= MAX_LINE_BYTES) break;
        }
      }
      if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) {
        // Last resort: keep every SCALAR field, drop the object payloads, but
        // re-derive a scalars-only `result`/`action.type` (below) so budget
        // accounting still sees this round.
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
            minimal[k] = typeof v === "string" ? clipBytes(v, 120) : v;
          }
        }
        // Even the scalar-only backstop must not zero out a round's spend: the
        // cold-start rebuild gates on `phase === "record" && result` and reads
        // `action.type` for the toolRounds count, so dropping both objects
        // outright silently under-counts a round that genuinely cost money — a
        // cap bypass that fails OPEN on restart. These re-derived carriers are
        // scalars-only by construction, so they can never be the reason a line
        // is still oversize.
        if (truncated.result && typeof truncated.result === "object") {
          const r = truncated.result;
          const rr = {};
          if (Number.isFinite(r.costUsd)) rr.costUsd = r.costUsd;
          if (Number.isFinite(r.tokens)) rr.tokens = r.tokens;
          if (typeof r.pricing === "string") rr.pricing = clipBytes(r.pricing, 32);
          if (Object.keys(rr).length) minimal.result = rr;
        }
        if (truncated.action && typeof truncated.action === "object" && typeof truncated.action.type === "string") {
          minimal.action = { type: clipBytes(truncated.action.type, 120) };
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
