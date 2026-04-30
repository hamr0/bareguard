// Count audit records matching a predicate within a trailing time window.
// Single source of truth for rate-shaped guards (defer-rate, spawn-rate).
// No separate counter file: the audit log already has every gate record
// with timestamp + run_id, and is per-family by default (one JSONL file
// per root_run_id), so cross-process correctness is automatic.

import { promises as fsp } from "node:fs";

export async function countAuditWindow({ auditPath, windowMs, predicate, now = Date.now() }) {
  let buf;
  try { buf = await fsp.readFile(auditPath, "utf8"); }
  catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  const cutoff = now - windowMs;
  let count = 0;
  for (const line of buf.split("\n")) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const ts = rec.ts ? Date.parse(rec.ts) : NaN;
    if (!isFinite(ts) || ts < cutoff) continue;
    if (predicate(rec)) count++;
  }
  return count;
}
