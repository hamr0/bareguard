// defer-rate primitive (PRD §14.2). Step-3 deny in the eval order:
// caps how many `defer` actions can pass through the gate per minute,
// counted from the audit log within the trailing 60s window.
//
// Per-family scope is automatic: the audit file is keyed by root_run_id,
// so children spawned by this run write to the same file as the parent
// (inherited via BAREGUARD_AUDIT_PATH).

import { countAuditWindow } from "../audit-window.js";

const DEFAULT_RATE = 15;
const WINDOW_MS = 60_000;

/**
 * Step-3 deny for `defer` actions: deny when allowed defers in the trailing 60s window reach the per-minute cap.
 * @param {object} action action being evaluated
 * @param {string} action.type action type (no-op unless "defer")
 * @param {object} [cfg] defer config
 * @param {number} [cfg.ratePerMinute] cap per trailing 60s (default 15; Infinity disables)
 * @param {object} [ctx] rate context from the gate
 * @param {string} [ctx.auditPath] audit file path (file mode)
 * @param {object[]} [ctx.entries] parsed audit entries (fileless mode)
 * @param {number} [ctx.now] current timestamp in ms
 * @returns {Promise<{outcome:string,severity:string,rule:string,reason:string}|null>} deny decision, or null if under cap/not applicable
 */
export async function deferRateCheck(action, cfg = {}, ctx = {}) {
  if (action.type !== "defer") return null;
  const cap = cfg.ratePerMinute ?? DEFAULT_RATE;
  if (cap === Infinity) return null;
  const count = await countAuditWindow({
    auditPath: ctx.auditPath,
    windowMs:  WINDOW_MS,
    now:       ctx.now ?? Date.now(),
    predicate: rec => rec.phase === "gate" && rec.action?.type === "defer" && rec.decision === "allow",
  });
  if (count >= cap) {
    return {
      outcome:  "deny",
      severity: "action",
      rule:     "defer.ratePerMinute",
      reason:   `defer rate cap exceeded: ${count}/${cap} in trailing 60s`,
    };
  }
  return null;
}
