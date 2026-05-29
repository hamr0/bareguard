// Count audit records matching a predicate within a trailing time window.
// Single source of truth for rate-shaped guards (defer-rate, spawn-rate).
// No separate counter file: the audit log already has every gate record
// with timestamp + run_id, and is per-family by default (one JSONL file
// per root_run_id), so cross-process correctness is automatic.

import { promises as fsp } from "node:fs";

/**
 * Count audit records matching `predicate` within a trailing time window.
 * @param {object} opts
 * @param {string} [opts.auditPath] path to the JSONL audit file (file mode)
 * @param {object[]} [opts.entries] already-parsed audit entries (fileless mode); takes precedence over auditPath
 * @param {number} opts.windowMs trailing window size in milliseconds
 * @param {(rec: object) => boolean} opts.predicate per-record match test
 * @param {number} [opts.now] window-end timestamp in ms (defaults to Date.now())
 * @returns {Promise<number>} count of matching records in the window
 */
export async function countAuditWindow({ auditPath, entries, windowMs, predicate, now = Date.now() }) {
  // Fileless mode (B4, v0.4): caller passes already-parsed entries.
  // File mode: read + parse the JSONL on demand.
  //
  // NOTE on cost: this is a FULL scan of every record, by design. A backward
  // scan with early-stop was tried (to make it sub-linear) but rejected — the
  // audit log is only *approximately* time-ordered (cross-process appends carry
  // each process's own clock), so any position-based early-stop can under-count
  // in-window records, and for a rate limiter an under-count is a cap BYPASS. A
  // full timestamp scan is the only provably-correct option. The cost is O(n)
  // per check (O(n²) over a long run); bound it by keeping runs / audit files
  // reasonably sized rather than by skipping records here. See SECURITY notes.
  let records;
  // `[]` is truthy — an empty fileless audit correctly yields 0 here
  // instead of falling through to a file read.
  if (entries) {
    records = entries;
  } else {
    let buf;
    try { buf = await fsp.readFile(auditPath, "utf8"); }
    catch (err) {
      if (err.code === "ENOENT") return 0;
      throw err;
    }
    records = [];
    for (const line of buf.split("\n")) {
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  const cutoff = now - windowMs;
  let count = 0;
  for (const rec of records) {
    const ts = rec.ts ? Date.parse(rec.ts) : NaN;
    if (!isFinite(ts) || ts < cutoff) continue;
    if (predicate(rec)) count++;
  }
  return count;
}
