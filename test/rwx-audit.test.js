// rwx audit line + budget count-cap accrual (PRD §23.5 "the audit line
// carries the letter" / §23.10 "the gate accrues the letter count itself in
// rwx mode instead of relying on the caller's result.counts").

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

function gateFor(overrides = {}) {
  return new Gate({
    audit: { path: null }, // fileless — inspect via gate.audit.readAll()
    rwx: {
      agent: "fixer",
      agents: { researcher: "r--", fixer: "rw-" },
      tools: { read: "r", write: "w", deploy: "x" },
      bash: { "git status": "r", "git commit": "w" },
      ...overrides,
    },
    humanChannel: async () => ({ decision: "deny" }),
  });
}

test("rwx audit: the gate audit line carries rwxLetters and the matched rwxLetter on allow", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.check({ type: "read", args: {} });
  const lines = await gate.audit.readAll();
  const gateLine = lines.find((l) => l.phase === "gate" && l.decision === "allow");
  assert.ok(gateLine, "expected an allow gate line");
  assert.equal(gateLine.rwxLetters, "rw-");
  assert.equal(gateLine.rwxLetter, "r");
});

test("rwx audit: the gate audit line carries rwxLetters (no rwxLetter) on an unlisted deny", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.check({ type: "unknown_tool", args: {} });
  const lines = await gate.audit.readAll();
  const gateLine = lines.find((l) => l.phase === "gate" && l.decision === "deny");
  assert.ok(gateLine);
  assert.equal(gateLine.rule, "rwx.unlisted");
  assert.equal(gateLine.rwxLetters, "rw-");
  assert.equal(gateLine.rwxLetter, undefined);
});

test("rwx audit: the gate audit line carries rwxLetter on a rwx.denied deny (tagged, letter lacking)", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.check({ type: "deploy", args: {} }); // tagged "x", fixer only holds "rw-"
  const lines = await gate.audit.readAll();
  const gateLine = lines.find((l) => l.phase === "gate" && l.decision === "deny");
  assert.ok(gateLine);
  assert.equal(gateLine.rule, "rwx.denied");
  assert.equal(gateLine.rwxLetters, "rw-");
  assert.equal(gateLine.rwxLetter, "x");
});

test("rwx audit: a non-rwx gate's audit line never carries rwxLetters/rwxLetter (byte-identical for existing users)", async () => {
  const gate = new Gate({
    audit: { path: null },
    tools: { allowlist: ["read"] },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  await gate.check({ type: "read", args: {} });
  const lines = await gate.audit.readAll();
  const gateLine = lines.find((l) => l.phase === "gate");
  assert.ok(gateLine);
  assert.equal("rwxLetters" in gateLine, false);
  assert.equal("rwxLetter" in gateLine, false);
});

// ─── §23.10 count caps: the gate accrues the letter count itself ────────────

test("rwx budget: record() accrues a resource cap keyed by the matched letter, without the caller supplying counts", async () => {
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "fixer",
      agents: { fixer: "rw-" },
      tools: { write: "w" },
    },
    budget: { resources: { w: 2 } }, // "rw, but at most 2 writes" (§23.10)
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();

  // Two writes allowed under the cap — caller passes NO counts at all.
  for (let i = 0; i < 2; i++) {
    const d = await gate.check({ type: "write", args: {} });
    assert.equal(d.outcome, "allow");
    await gate.record({ type: "write", args: {} }, { costUsd: 0 }); // no result.counts supplied
  }
  assert.equal(gate.budget.resourceSpent.w, 2);

  // Third write halts the budget axis (post-fact, on the NEXT preEval).
  const d3 = await gate.check({ type: "write", args: {} });
  assert.equal(d3.outcome, "deny");
  assert.equal(d3.severity, "halt");
  assert.equal(d3.rule, "budget.resource.w");
});

test("rwx budget: the letter accrual is ADDITIVE to a caller-supplied counts object (never replaces it)", async () => {
  const gate = new Gate({
    audit: { path: null },
    rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { write: "w" } },
    budget: { resources: { w: 100, rows: 100 } },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  await gate.check({ type: "write", args: {} });
  await gate.record({ type: "write", args: {} }, { costUsd: 0, counts: { rows: 5 } });
  assert.equal(gate.budget.resourceSpent.w, 1); // gate-accrued letter count
  assert.equal(gate.budget.resourceSpent.rows, 5); // caller's own count, untouched
});

test("rwx budget: record() never mutates the caller's original result object", async () => {
  const gate = new Gate({
    audit: { path: null },
    rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { write: "w" } },
    budget: { resources: { w: 100 } },
  });
  await gate.init();
  const result = { costUsd: 0 };
  await gate.record({ type: "write", args: {} }, result);
  assert.equal("counts" in result, false, "the caller's result object must not be mutated");
});

test("rwx budget: a non-rwx gate's record() is unaffected (no letter accrual)", async () => {
  const gate = new Gate({
    audit: { path: null },
    tools: { allowlist: ["write"] },
    budget: { resources: { w: 100 } },
  });
  await gate.init();
  await gate.record({ type: "write", args: {} }, { costUsd: 0 });
  assert.equal(gate.budget.resourceSpent.w ?? 0, 0); // no letter to accrue outside rwx mode
});
