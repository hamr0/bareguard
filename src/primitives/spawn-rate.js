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

/**
 * Step-3 deny for `spawn` actions: deny when allowed spawns in the trailing 60s window reach the per-minute cap.
 * @param {object} action action being evaluated
 * @param {string} action.type action type (no-op unless "spawn")
 * @param {object} [cfg] spawn config
 * @param {number} [cfg.ratePerMinute] cap per trailing 60s (default 10; Infinity disables)
 * @param {object} [ctx] rate context from the gate
 * @param {string|null} [ctx.auditPath] audit file path (file mode); null in fileless mode
 * @param {object[]|null} [ctx.entries] parsed audit entries (fileless mode)
 * @param {number} [ctx.now] current timestamp in ms
 * @returns {Promise<{outcome:string,severity:string,rule:string,reason:string}|null>} deny decision, or null if under cap/not applicable
 */
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
