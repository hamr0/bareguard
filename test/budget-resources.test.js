// OQ3 — generic countable-resource budget dimensions + the soft (warn) tier.
// The cumulative wall (E3) now counts arbitrary resources (writes/rows/…), not
// just money; the soft tier is observability that never halts.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { Gate } from "../src/index.js";
import { Budget } from "../src/primitives/budget.js";
import { makeTmpDir, cleanup, uniquePaths, makeHumanChannel } from "./_helpers.js";

const warnLines = (entries) => entries.filter(e => e.phase === "budget_warn");

test("generic resource cap halts a decomposition (the OQ3 wall)", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { resources: { writes: 2 } } });
  await gate.init();
  // Two small writes commit; the third is denied by the cumulative resource cap —
  // a count-based decomposition (1+1+1) can't walk past it (cf. E3 for money).
  await gate.record({ type: "memory.write" }, { counts: { writes: 1 } });
  await gate.record({ type: "memory.write" }, { counts: { writes: 1 } });
  const dec = await gate.check({ type: "memory.write" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.severity, "halt");
  assert.equal(dec.rule, "budget.resource.writes");
  assert.match(dec.reason, /spent 2 writes >= cap 2/);
});

test("an unconfigured resource is a no-op (only capped dimensions halt)", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { resources: { writes: 2 } } });
  await gate.init();
  for (let i = 0; i < 5; i++) await gate.record({ type: "export" }, { counts: { rows: 1000 } });
  const dec = await gate.check({ type: "export" });
  assert.equal(dec.outcome, "allow", "rows is uncapped → never halts");
});

test("soft tier: a budget_warn fires once at the threshold, edge-triggered, never halts", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { resources: { writes: 4 }, softRatio: 0.5 } });
  await gate.init();
  // threshold = 0.5 * 4 = 2.
  await gate.record({ type: "w" }, { counts: { writes: 1 } }); // 0→1: below
  assert.equal(warnLines(await gate.audit.readAll()).length, 0, "no warn before threshold");
  await gate.record({ type: "w" }, { counts: { writes: 1 } }); // 1→2: CROSS
  await gate.record({ type: "w" }, { counts: { writes: 1 } }); // 2→3: already past (no re-warn)
  const warns = warnLines(await gate.audit.readAll());
  assert.equal(warns.length, 1, "edge-triggered: exactly one warn at the crossing");
  assert.equal(warns[0].dimension, "writes");
  assert.equal(warns[0].cap, 4);
  assert.equal(warns[0].spent, 2);
  // and it never halts: 3 spent < cap 4.
  const dec = await gate.check({ type: "w" });
  assert.equal(dec.outcome, "allow");
});

test("at/over cap is a halt, not a warn (no warn in halt territory)", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { resources: { writes: 2 }, softRatio: 0.8 } });
  await gate.init();
  // threshold = 1.6; write 1 (below), write 2 → after=2 >= cap 2 → halt territory, NOT a warn.
  await gate.record({ type: "w" }, { counts: { writes: 1 } });
  await gate.record({ type: "w" }, { counts: { writes: 1 } });
  assert.equal(warnLines(await gate.audit.readAll()).length, 0, "crossing straight to cap does not warn");
});

test("softRatio applies to money dimensions too", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { maxCostUsd: 10, softRatio: 0.8 } });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 8 }); // 0→8, threshold 8, cap 10 → warn
  const warns = warnLines(await gate.audit.readAll());
  assert.equal(warns.length, 1);
  assert.equal(warns[0].dimension, "costUsd");
});

test("v1 budget file is read forward-compatibly; money survives; resources accrue and upgrade to v2", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath } = uniquePaths(dir);
  // a pre-OQ3 (v1) file on disk
  await fsp.writeFile(budgetPath, JSON.stringify({
    version: 1, cap_usd: 5.0, spent_usd: 1.23, cap_tokens: 100000, spent_tokens: 24500,
    started_at: "t0",
  }));
  const gate = new Gate({
    audit: { path: auditPath },
    budget: { sharedFile: budgetPath, resources: { writes: 2 } },
  });
  await gate.init();
  assert.equal(gate.budget.spentUsd, 1.23, "v1 money total preserved");
  assert.equal(gate.budget.spentTokens, 24500);
  // the generic dimension works against the same file
  await gate.record({ type: "memory.write" }, { counts: { writes: 1 } });
  await gate.record({ type: "memory.write" }, { counts: { writes: 1 } });
  const dec = await gate.check({ type: "memory.write" });
  assert.equal(dec.rule, "budget.resource.writes", "resource cap halts against the upgraded file");
  // the file is now persisted as v2, money intact
  const onDisk = JSON.parse(await fsp.readFile(budgetPath, "utf8"));
  assert.equal(onDisk.version, 2);
  assert.equal(onDisk.spent_usd, 1.23);
  assert.equal(onDisk.resource_spent.writes, 2);
});

test("raiseCap raises a generic resource cap (direct call)", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { resources: { writes: 1 } } });
  await gate.init();
  await gate.record({ type: "w" }, { counts: { writes: 1 } });
  assert.equal((await gate.check({ type: "w" })).rule, "budget.resource.writes", "halted at cap 1");
  await gate.raiseCap("writes", 5);
  assert.equal((await gate.check({ type: "w" })).outcome, "allow", "raised cap clears the halt");
});

test("a resource halt routes through humanChannel topup end-to-end (the real operator flow)", async () => {
  // Exercises the shipped resource-topup path that no test covered: the halt
  // event, the halt audit-line fields (_haltDimension/_haltSpent/_haltCap for
  // budget.resource.*), and the in-check topup raising the resource cap.
  const channel = makeHumanChannel([{ decision: "topup", newCap: 3, reason: "operator approved more writes" }]);
  const gate = new Gate({ audit: { path: null }, budget: { resources: { writes: 1 } }, humanChannel: channel });
  await gate.init();
  await gate.record({ type: "w" }, { counts: { writes: 1 } }); // spent 1 == cap 1
  const dec = await gate.check({ type: "w" });
  assert.equal(dec.outcome, "allow", "after topup the resource halt clears");
  // the human saw a real halt event for THIS resource
  assert.equal(channel.events.length, 1);
  assert.equal(channel.events[0].kind, "halt");
  assert.equal(channel.events[0].rule, "budget.resource.writes");
  // the halt audit line carries the resource dimension/spent/cap (the _halt* mappers)
  const entries = await gate.audit.readAll();
  const haltLine = entries.find(e => e.phase === "halt");
  assert.ok(haltLine, "a halt audit line was emitted");
  assert.equal(haltLine.dimension, "writes");
  assert.equal(haltLine.spent, 1);
  assert.equal(haltLine.cap, 1);
  // and the topup line records the raise
  const topup = entries.find(e => e.phase === "topup");
  assert.equal(topup.dimension, "writes");
  assert.equal(topup.oldCap, 1);
  assert.equal(topup.newCap, 3);
  assert.equal(gate.budget.resourceCaps.writes, 3, "the resource cap was actually raised");
});

test("shared-file resource counts accumulate across instances (no lost updates)", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { budgetPath } = uniquePaths(dir);
  const a = new Budget({ sharedFile: budgetPath, resources: { writes: 100 } });
  const b = new Budget({ sharedFile: budgetPath, resources: { writes: 100 } });
  await a.init(); await b.init();
  // interleave records from two instances against the same file — each record
  // re-reads the committed total under lock, so the sum is exact.
  await a.record({ counts: { writes: 1 } });
  await b.record({ counts: { writes: 1 } });
  await a.record({ counts: { writes: 1 } });
  const onDisk = JSON.parse(await fsp.readFile(budgetPath, "utf8"));
  assert.equal(onDisk.resource_spent.writes, 3, "all three writes accrued, none lost to a stale-cache overwrite");
});

test("refresh() syncs resource spend from the shared file", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { budgetPath } = uniquePaths(dir);
  const writer = new Budget({ sharedFile: budgetPath, resources: { writes: 100 } });
  await writer.init();
  await writer.record({ counts: { writes: 5 } });
  const reader = new Budget({ sharedFile: budgetPath });
  await reader.init();                         // sees writes: 5
  await writer.record({ counts: { writes: 2 } }); // file now 7
  await reader.refresh();
  assert.equal(reader.resourceSpent.writes, 7, "refresh pulled the latest resource spend");
});

test("counts are monotonic: a negative delta cannot refund the cumulative cap (hardening)", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { resources: { writes: 2 } } });
  await gate.init();
  await gate.record({ type: "w" }, { counts: { writes: 1 } });
  await gate.record({ type: "w" }, { counts: { writes: -100 } }); // refund attempt — ignored
  await gate.record({ type: "w" }, { counts: { writes: 1 } });
  const dec = await gate.check({ type: "w" });
  assert.equal(dec.rule, "budget.resource.writes", "negative delta did not decrement; cap still halts");
});

test("invalid resource config and softRatio are rejected at construction (fail-closed)", () => {
  assert.throws(() => new Budget({ resources: { writes: -1 } }), /invalid budget resource cap/);
  assert.throws(() => new Budget({ resources: { writes: Infinity } }), /invalid budget resource cap/);
  assert.throws(() => new Budget({ softRatio: 0 }), /invalid budget softRatio/);
  assert.throws(() => new Budget({ softRatio: 1 }), /invalid budget softRatio/);
  assert.throws(() => new Budget({ softRatio: 1.5 }), /invalid budget softRatio/);
});
