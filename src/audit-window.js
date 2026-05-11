// Count audit records matching a predicate within a trailing time window.
// Single source of truth for rate-shaped guards (defer-rate, spawn-rate).
// No separate counter file: the audit log already has every gate record
// with timestamp + run_id, and is per-family by default (one JSONL file
// per root_run_id), so cross-process correctness is automatic.

import { promises as fsp } from "node:fs";

export async function countAuditWindow({ auditPath, entries, windowMs, predicate, now = Date.now() }) {
  // Fileless mode (B4, v0.4): caller passes already-parsed entries.
  // File mode: read + parse the JSONL on demand.
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
