// OQ4 — a per-action correlation id (`aid`) joins each request (the gate decision
// line) to its outcome (the record line) in the audit log, even when two actions
// are byte-identical (the a2a §12.2 ambiguity that content-join cannot resolve).
import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { makeHumanChannel } from "./_helpers.js";

const byPhase = (entries, phase) => entries.filter(e => e.phase === phase);

test("run() stamps the same aid on the gate decision and the record line", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.run({ type: "t" }, () => ({ costUsd: 0 }));
  const entries = await gate.audit.readAll();
  const gateLine = byPhase(entries, "gate")[0];
  const recordLine = byPhase(entries, "record")[0];
  assert.ok(gateLine.aid, "gate line carries an aid");
  assert.equal(recordLine.aid, gateLine.aid, "record joins its decision by aid");
});

test("two IDENTICAL actions get distinct aids, each joining its own pair (a2a §12.2)", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const action = { type: "memory.write", id: "fact:dup", text: "same" };
  await gate.run(action, () => ({ counts: {} }));
  await gate.run(action, () => ({ counts: {} })); // byte-identical request
  const entries = await gate.audit.readAll();
  const gates = byPhase(entries, "gate");
  const records = byPhase(entries, "record");
  assert.equal(gates.length, 2);
  assert.equal(records.length, 2);
  // each record's aid matches exactly one gate's aid, and the two pairs differ.
  const aids = gates.map(g => g.aid);
  assert.equal(new Set(aids).size, 2, "two evals → two distinct aids");
  for (const r of records) {
    assert.ok(aids.includes(r.aid), "every record joins some gate by aid");
  }
  assert.notEqual(records[0].aid, records[1].aid, "identical actions are still disambiguated");
});

test("check() exposes the aid; record({aid}) joins, omitting it does not", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const action = { type: "t" };
  const decision = await gate.check(action);
  assert.ok(decision.aid, "check() returns the correlation id on the decision");

  await gate.record(action, { costUsd: 0 }, { aid: decision.aid });
  await gate.record(action, { costUsd: 0 }); // no aid → fresh id
  const records = byPhase(await gate.audit.readAll(), "record");
  assert.equal(records[0].aid, decision.aid, "threaded aid joins the original decision");
  assert.notEqual(records[1].aid, decision.aid, "un-threaded record gets its own id");
});

test("ask path: the gate and approval lines share the aid (reconstruct request→approval→outcome)", async () => {
  const channel = makeHumanChannel([{ decision: "allow", reason: "ok" }]);
  const gate = new Gate({
    audit: { path: null },
    content: { askPatterns: [/sendEmail/] },
    humanChannel: channel,
  });
  await gate.init();
  const decision = await gate.check({ type: "sendEmail" });
  assert.equal(decision.outcome, "allow");
  const entries = await gate.audit.readAll();
  const approval = byPhase(entries, "approval")[0];
  assert.ok(approval, "an approval line was emitted");
  assert.equal(approval.aid, decision.aid, "approval joins the same eval by aid");
  // every line from this single eval shares one aid
  const aids = new Set(entries.map(e => e.aid));
  assert.equal(aids.size, 1, "one eval → one aid across all its lines");
});
