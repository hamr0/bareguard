// Test worker: a subprocess that uses bareguard's Gate to spend a budget.
// Used by shared-budget.test.js and audit-stitching.test.js.
//
// Inputs (env):
//   BAREGUARD_AUDIT_PATH   path to single shared audit file
//   BAREGUARD_BUDGET_FILE  path to shared budget file
//   BAREGUARD_PARENT_RUN_ID  parent's run id (or empty)
//   BAREGUARD_SPAWN_DEPTH  current depth (or 0)
//   WORKER_TICK_COST       USD per record (number)
//   WORKER_TICKS           how many records to perform
//   WORKER_LABEL           a short label included in stdout JSONL
//
// Stdout: one JSONL per significant event (start/halt/complete).

import { Gate } from "../src/index.js";

const tickCost = +(process.env.WORKER_TICK_COST ?? 0.01);
const ticks    = +(process.env.WORKER_TICKS    ?? 10);
const label    = process.env.WORKER_LABEL ?? "worker";

const gate = new Gate({
  // path/budget/parent picked up from env
  budget: { /* cap inherited from shared file */ },
});
await gate.init();

let spent = 0, lastDecision = null;
for (let i = 0; i < ticks; i++) {
  const dec = await gate.check({ type: "work", iter: i });
  lastDecision = dec;
  if (dec.outcome === "deny") {
    process.stdout.write(JSON.stringify({
      kind: "deny", label, runId: gate.runId,
      rule: dec.rule, severity: dec.severity, reason: dec.reason, spent,
    }) + "\n");
    process.exit(2);
  }
  await gate.record({ type: "work", iter: i }, { costUsd: tickCost, tokens: 100 });
  spent += tickCost;
}

process.stdout.write(JSON.stringify({
  kind: "complete", label, runId: gate.runId, spent, ticks,
}) + "\n");
process.exit(0);
