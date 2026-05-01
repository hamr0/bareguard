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
