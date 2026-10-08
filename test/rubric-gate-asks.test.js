import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Gate, createRubric, checkStep, rubricSha } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

// Live-ask races and spec-controlled map keys (docs/product/rubric-prd.md §6 live accept, §7).

const lines = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const mustOk = [{ id: "m", rule: "mustCarry", field: "text", phrases: ["OK"] }];
const SPEC = { schema: 1, goal: "g", maxReds: 2, checkpoints: { a: { gating: true, requiresHuman: true, checks: mustOk } } };
const cfg = { spec: SPEC, sha256: rubricSha(SPEC), advanceOn: ["done"] };
const adv = (r) => ({ type: "done", checkpoint: "a", outputSha: r.outputSha });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function mk(t, extra = {}) {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const boot = async (e = {}) => {
    const g = new Gate({ audit: { path: auditPath }, runId, rubric: cfg, ...extra, ...e });
    await g.init();
    return g;
  };
  return { boot, auditPath };
}

// --- F1: a stale live-ask answer must not lift the signed maxReds wall ----------------------------

test("F1: a live accept that lands after the checkpoint went exhausted is discarded (no accept line, reds not reset)", async (t) => {
  let release;
  const { boot, auditPath } = await mk(t, { humanChannel: () => new Promise((r) => { release = () => r({ decision: "allow" }); }) });
  const g = await boot();
  const A = await g.checkStep("a", "OK fine");
  const pend = g.check(adv(A));
  await tick();
  await g.checkStep("a", "bad1");
  await g.checkStep("a", "bad2"); // reds == maxReds
  assert.equal((await g.check(adv(A))).rule, "rubric.exhausted");
  release();
  const d = await pend;
  assert.deepEqual([d.outcome, d.rule], ["deny", "rubric.exhausted"]);
  assert.equal(lines(auditPath).filter((l) => l.phase === "rubric_accept").length, 0, "no accept line for a stale answer");
  assert.equal((await g.check(adv(A))).rule, "rubric.exhausted", "reds were not reset");
  const r3 = await g.checkStep("a", "bad3");
  assert.equal(r3.verdict, "red");
  assert.equal((await g.check(adv(r3))).rule, "rubric.exhausted", "a further red does not reopen the wall");
});

test("F1 control: a fresh accept with unchanged green state resets reds and allows", async (t) => {
  const { boot, auditPath } = await mk(t, { humanChannel: async () => ({ decision: "allow" }) });
  const g = await boot();
  await g.checkStep("a", "bad1");
  const A = await g.checkStep("a", "OK fine");
  const d = await g.check(adv(A));
  assert.deepEqual([d.outcome, d.rule], ["allow", "humanChannel.allow"]);
  assert.equal(lines(auditPath).filter((l) => l.phase === "rubric_accept").length, 1);
  // reds were reset to 0: two further reds (== maxReds 2 would exhaust from 1 red + 1) still need 2 to exhaust
  await g.checkStep("a", "bad2");
  const B = await g.checkStep("a", "OK again");
  assert.notEqual((await g.check(adv(B))).rule, "rubric.exhausted");
});

// --- L4: concurrent live asks are deduped per (checkpoint, outputSha) -----------------------------

test("L4: 3 concurrent checks for one green raise ONE ask, write ONE rubric_accept line, same outcome", async (t) => {
  let asks = 0, release;
  const { boot, auditPath } = await mk(t, { humanChannel: () => { asks++; return new Promise((r) => { release = () => r({ decision: "allow" }); }); } });
  const g = await boot();
  const A = await g.checkStep("a", "OK fine");
  const all = [g.check(adv(A)), g.check(adv(A)), g.check(adv(A))];
  await tick();
  release();
  const ds = await Promise.all(all);
  assert.equal(asks, 1);
  assert.deepEqual(ds.map((d) => [d.outcome, d.rule]), [["allow", "humanChannel.allow"], ["allow", "humanChannel.allow"], ["allow", "humanChannel.allow"]]);
  assert.equal(lines(auditPath).filter((l) => l.phase === "rubric_accept").length, 1);
  // a late joiner after the accept sees it: no new ask
  assert.equal((await g.check(adv(A))).outcome, "allow");
  assert.equal(asks, 1);
});

test("L4: a rejected ask clears the in-flight entry; a later retry asks again", async (t) => {
  let asks = 0;
  const replies = [{ decision: "deny", reason: "no" }, { decision: "allow" }];
  const { boot, auditPath } = await mk(t, { humanChannel: async () => { asks++; await tick(10); return replies.shift(); } });
  const g = await boot();
  const A = await g.checkStep("a", "OK fine");
  const first = await Promise.all([g.check(adv(A)), g.check(adv(A))]);
  assert.equal(asks, 1);
  assert.deepEqual(first.map((d) => [d.outcome, d.rule]), [["deny", "rubric.needs-accept"], ["deny", "rubric.needs-accept"]]);
  assert.equal(lines(auditPath).filter((l) => l.phase === "rubric_accept").length, 0);
  const again = await g.check(adv(A));
  assert.equal(asks, 2, "retry asks again");
  assert.equal(again.outcome, "allow");
});

test("L4: a thrown ask clears the entry too", async (t) => {
  let asks = 0;
  const { boot } = await mk(t, { humanChannel: async () => { asks++; if (asks === 1) throw new Error("boom"); return { decision: "allow" }; } });
  const g = await boot();
  const A = await g.checkStep("a", "OK fine");
  assert.equal((await g.check(adv(A))).outcome, "deny");
  assert.equal((await g.check(adv(A))).outcome, "allow");
  assert.equal(asks, 2);
});

// --- L5: spec-controlled check ids never collide with Object.prototype keys -----------------------

const IDS = ["__proto__", "constructor", "toString"];
const seedSpec = (id) => ({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [{ id, rule: "notWorse", direction: "lower-is-better", baseline: "seed" }] } } });
const meas = (id, value, baseline) => { const m = Object.create(null); m[id] = { value, exit: 0, matchedPreScope: 4, baseline, baselineSource: { anchor: "x", route: "y" } }; return m; };

test("L5: pure checkStep seeds and conflicts on __proto__ / constructor / toString check ids", async () => {
  for (const id of IDS) {
    const rub = createRubric(seedSpec(id));
    const one = await checkStep(rub, "a", "t", { measurements: meas(id, 5, 5) });
    assert.equal(one.verdict, "green", id);
    assert.deepEqual(Object.keys(one.baselines), [id], id);
    assert.equal(one.baselines[id].baseline, 5, id);
    const two = await checkStep(rub, "a", "t", { measurements: meas(id, 50, 100), priorBaselines: { [id]: 5 } });
    assert.equal(two.verdict, "stopped", id);
    assert.equal(two.fault.kind, "baseline-conflict", id);
  }
});

test("L5: gate.checkStep (and a cold rebuild from the audit) keep first-write-wins for those ids", async (t) => {
  for (const id of IDS) {
    const spec = seedSpec(id);
    const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
    const { auditPath, runId } = uniquePaths(dir);
    const boot = async () => { const g = new Gate({ audit: { path: auditPath }, runId, rubric: { spec, sha256: rubricSha(spec), advanceOn: ["done"] } }); await g.init(); return g; };
    const g = await boot();
    assert.equal((await g.checkStep("a", "t", { measurements: meas(id, 5, 5) })).verdict, "green", id);
    const r = await g.checkStep("a", "t", { measurements: meas(id, 50, 100) });
    assert.deepEqual([r.verdict, r.fault?.kind], ["stopped", "baseline-conflict"], id);
    const g2 = await boot(); // cold: baseline rebuilt from the audit
    const r2 = await g2.checkStep("a", "t", { measurements: meas(id, 50, 100) });
    assert.deepEqual([r2.verdict, r2.fault?.kind], ["stopped", "baseline-conflict"], `${id} after cold rebuild`);
  }
});
