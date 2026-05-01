// spawn-rate primitive (PRD §14.3). Step-3 deny in the eval order:
// caps how many `spawn` actions can pass through the gate per minute,
// counted from the audit log within the trailing 60s window.
//
// Composes with `limits.maxChildren` (concurrency cap) and
// `limits.maxDepth` (depth cap). This is rate, not concurrency.
//
// Per-family scope is automatic via the shared audit file
// (one JSONL per root_run_id, inherited across spawned processes).

import { countAuditWindow } from "../audit-window.js";

const DEFAULT_RATE = 10;
const WINDOW_MS = 60_000;

export async function spawnRateCheck(action, cfg = {}, ctx = {}) {
  if (action.type !== "spawn") return null;
  const cap = cfg.ratePerMinute ?? DEFAULT_RATE;
  if (cap === Infinity) return null;
  const count = await countAuditWindow({
    auditPath: ctx.auditPath,
    windowMs:  WINDOW_MS,
    now:       ctx.now ?? Date.now(),
    predicate: rec => rec.phase === "gate" && rec.action?.type === "spawn" && rec.decision === "allow",
  });
  if (count >= cap) {
    return {
      outcome:  "deny",
      severity: "action",
      rule:     "spawn.ratePerMinute",
      reason:   `spawn rate cap exceeded: ${count}/${cap} in trailing 60s`,
    };
  }
  return null;
}
