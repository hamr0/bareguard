import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

// Regression: every public method does `if (!this._initialized) await
// this.init()`. Two concurrent first callers both observed `_initialized ===
// false` and each ran the WHOLE init sequence — audit.init() and
// budget.init() (including the cold-start audit-rebuild) — independently.
// That's a lost-update race on the shared budget file, not a safe no-op.
// init() must memoize its in-flight promise so concurrent callers share one
// run.

function countCalls(obj, method) {
  const original = obj[method].bind(obj);
  const state = { count: 0 };
  obj[method] = async (...args) => {
    state.count++;
    return original(...args);
  };
  return state;
}

test("concurrent init() callers share a single audit.init/budget.init run", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath } = uniquePaths(dir);
  const gate = new Gate({
    audit: { path: auditPath },
    budget: { maxCostUsd: 1, sharedFile: budgetPath },
  });
  const auditCalls = countCalls(gate.audit, "init");
  const budgetCalls = countCalls(gate.budget, "init");

  const [a, b, c] = await Promise.all([gate.init(), gate.init(), gate.init()]);
  assert.equal(auditCalls.count, 1, "audit.init ran exactly once");
  assert.equal(budgetCalls.count, 1, "budget.init ran exactly once");
  assert.equal(gate._initialized, true);

  // A later explicit init() stays idempotent (no-op, doesn't re-trigger).
  await gate.init();
  assert.equal(auditCalls.count, 1);
  assert.equal(budgetCalls.count, 1);
});

test("concurrent first calls through public methods (check/record) share one init", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath } = uniquePaths(dir);
  const gate = new Gate({
    audit: { path: auditPath },
    budget: { maxCostUsd: 1, sharedFile: budgetPath },
  });
  const auditCalls = countCalls(gate.audit, "init");
  const budgetCalls = countCalls(gate.budget, "init");

  await Promise.all([
    gate.check({ type: "x" }),
    gate.record({ type: "y" }, { costUsd: 0.01, tokens: 1 }),
    gate.check({ type: "z" }),
  ]);

  assert.equal(auditCalls.count, 1, "audit.init ran exactly once across concurrent entry points");
  assert.equal(budgetCalls.count, 1, "budget.init ran exactly once across concurrent entry points");
});

test("a failed init() rejects all concurrent waiters identically, then a later call retries", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath } = uniquePaths(dir);
  const gate = new Gate({
    audit: { path: auditPath },
    budget: { maxCostUsd: 1, sharedFile: budgetPath },
  });

  const boom = new Error("audit init boom");
  let auditInitCalls = 0;
  const originalAuditInit = gate.audit.init.bind(gate.audit);
  gate.audit.init = async () => {
    auditInitCalls++;
    if (auditInitCalls === 1) throw boom;
    return originalAuditInit();
  };

  const [r1, r2] = await Promise.allSettled([gate.init(), gate.init()]);
  assert.equal(r1.status, "rejected");
  assert.equal(r2.status, "rejected");
  assert.equal(r1.reason, boom, "both waiters see the identical rejection");
  assert.equal(r2.reason, boom, "both waiters see the identical rejection");
  assert.equal(gate._initialized, false);

  // Next call retries fresh and succeeds.
  await gate.init();
  assert.equal(gate._initialized, true);
  assert.equal(auditInitCalls, 2, "retry actually re-ran audit.init");
});
