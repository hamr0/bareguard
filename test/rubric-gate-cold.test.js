import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Gate, rubricSha } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths, makeHumanChannel } from "./_helpers.js";

// Cold start: gate state that ENFORCES a limit is rebuilt from the audit, like the budget.
// A resume never resets a count (docs/product/rubric-prd.md §7, §12 2026-10-07 #18).

const cap = (n) => [{ id: "cap", rule: "maxWords", field: "text", value: n }];
const SPEC = {
  schema: 1, goal: "g", maxReds: 3,
  checkpoints: {
    resume: { gating: true, checks: cap(5) },
    review: { gating: true, requiresHuman: true, checks: cap(5) },
    parked: { gating: true, requiresHuman: true, accept: "later", checks: cap(5) },
    seeded: { gating: true, checks: [{ id: "n", rule: "notWorse", direction: "lower-is-better", baseline: "seed" }] },
  },
};
const OK = "one two three";
const BAD = "one two three four five six";
const cfgFor = (spec = SPEC) => ({ spec, sha256: rubricSha(spec), advanceOn: ["done"] });
const advance = (r, cp) => ({ type: "done", checkpoint: cp, outputSha: r.outputSha });
const meas = (baseline, value) => ({ value, exit: 0, matchedPreScope: 4, baseline, baselineSource: { anchor: "abc123", route: "count" } });

async function setup(t) {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const boot = async (extra = {}) => {
    const g = new Gate({ audit: { path: auditPath }, runId, rubric: cfgFor(), ...extra });
    await g.init();
    return g;
  };
  return { boot, auditPath, runId };
}

test("COLD START: red counts survive; maxReds still fires at the same count after a restart", async (t) => {
  const { boot } = await setup(t);
  const a = await boot();
  await a.checkStep("resume", BAD);
  await a.checkStep("resume", BAD);
  const before = await a.checkStep("resume", OK);
  assert.equal((await a.check(advance(before, "resume"))).outcome, "allow", "2 reds < 3");
  // restart: a fresh Gate on the same audit file + runId
  const b = await boot();
  const r = await b.checkStep("resume", BAD); // the THIRD red, counting the two before the restart
  assert.equal(r.verdict, "red");
  const g = await b.checkStep("resume", OK);
  const d = await b.check(advance(g, "resume"));
  assert.deepEqual([d.outcome, d.rule], ["deny", "rubric.exhausted"], "the count was not reset by the resume");
  // and a third process sees the same
  const c = await boot();
  assert.equal((await c.check(advance(g, "resume"))).rule, "rubric.exhausted");
});

test("COLD START: minted verdicts survive (advance without re-checking); red/stopped stay denied", async (t) => {
  const { boot } = await setup(t);
  const a = await boot();
  const green = await a.checkStep("resume", OK);
  const red = await a.checkStep("parked", BAD);
  const stopped = await a.checkStep("seeded", "x");
  const b = await boot();
  assert.equal((await b.check(advance(green, "resume"))).outcome, "allow");
  assert.equal((await b.check(advance(red, "parked"))).rule, "rubric.red");
  assert.equal((await b.check(advance(stopped, "seeded"))).rule, "rubric.stopped");
  assert.equal((await b.check({ type: "done", checkpoint: "resume", outputSha: "1".repeat(64) })).rule, "rubric.output-mismatch");
});

test("COLD START: ACCEPTs survive (live and later), bound to their outputSha, and still reset the red count", async (t) => {
  const ch = makeHumanChannel([{ decision: "allow" }]);
  const { boot } = await setup(t);
  const a = await boot({ humanChannel: ch });
  const live = await a.checkStep("review", OK);
  assert.equal((await a.check(advance(live, "review"))).outcome, "allow");
  const parked = await a.checkStep("parked", OK);
  await a.recordAccept({ checkpoint: "parked", outputSha: parked.outputSha, by: "hamr" });

  const ch2 = makeHumanChannel([]);
  const b = await boot({ humanChannel: ch2 });
  assert.equal((await b.check(advance(live, "review"))).outcome, "allow", "live ACCEPT restored: no new ask");
  assert.equal((await b.check(advance(parked, "parked"))).outcome, "allow", "later ACCEPT restored");
  assert.equal(ch2.events.length, 0);
  // a different sha is NOT covered by the restored accept
  const other = await b.checkStep("parked", "four five six");
  assert.equal((await b.check(advance(other, "parked"))).rule, "rubric.needs-accept");
});

test("COLD START: ACCEPT-reset red counts: reds before an ACCEPT do not count after a restart", async (t) => {
  const ch = makeHumanChannel([{ decision: "allow" }]);
  const { boot } = await setup(t);
  const a = await boot({ humanChannel: ch });
  await a.checkStep("review", BAD); await a.checkStep("review", BAD);
  const g = await a.checkStep("review", OK);
  assert.equal((await a.check(advance(g, "review"))).outcome, "allow"); // ACCEPT resets 2 -> 0
  const b = await boot();
  await b.checkStep("review", BAD); // count 1, NOT 3
  const g2 = await b.checkStep("review", OK);
  assert.notEqual((await b.check(advance(g2, "review"))).rule, "rubric.exhausted");
});

test("COLD START: seed baselines are restored and fed back as priorBaselines; a different one is baseline-conflict", async (t) => {
  const { boot, auditPath } = await setup(t);
  const a = await boot();
  const first = await a.checkStep("seeded", "x", { measurements: { n: meas(3, 3) } });
  assert.equal(first.verdict, "green");
  assert.equal(lines(auditPath).filter((l) => l.phase === "rubric_baseline").length, 1);
  // same process: a different baseline is refused
  const same = await a.checkStep("seeded", "x", { measurements: { n: meas(10, 3) } });
  assert.equal(same.verdict, "stopped");
  assert.equal(same.fault.kind, "baseline-conflict");
  // restart: still refused (the baseline was rebuilt, not forgotten)
  const b = await boot();
  const conflict = await b.checkStep("seeded", "x", { measurements: { n: meas(10, 3) } });
  assert.equal(conflict.verdict, "stopped");
  assert.equal(conflict.fault.kind, "baseline-conflict");
  const ok = await b.checkStep("seeded", "x", { measurements: { n: meas(3, 3) } });
  assert.equal(ok.verdict, "green");
  assert.equal(lines(auditPath).filter((l) => l.phase === "rubric_baseline").length, 1, "recorded once");
});

test("a re-sign (new rubricSha) on the same run starts with clean state; a different runId starts fresh too", async (t) => {
  const { boot, auditPath } = await setup(t);
  const a = await boot();
  const g = await a.checkStep("resume", OK);
  const resigned = { ...SPEC, goal: "g v2" };
  const b = await boot({ rubric: cfgFor(resigned) });
  assert.equal((await b.check(advance(g, "resume"))).rule, "rubric.unminted", "old sha's verdicts are not the new rubric's");
  const fresh = new Gate({ audit: { path: auditPath }, rubric: cfgFor() }); // random runId: documented fresh start
  await fresh.init();
  assert.equal((await fresh.check(advance(g, "resume"))).rule, "rubric.unminted");
});

test("COLD START survives a line the audit bound cut down (state carriers are must-keep)", async (t) => {
  const spec = { schema: 1, goal: "g", maxReds: 2, checkpoints: { big: { gating: true, checks: [
    ...Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, rule: "in", field: "f" + i, values: ["ok"] })),
  ] } } };
  const out = {};
  for (let i = 0; i < 60; i++) out["f" + i] = "x".repeat(300);
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const boot = async () => { const g = new Gate({ audit: { path: auditPath }, runId, rubric: cfgFor(spec) }); await g.init(); return g; };
  const a = await boot();
  await a.checkStep("big", out);
  await a.checkStep("big", out);
  const b = await boot();
  const ok = Object.fromEntries(Array.from({ length: 60 }, (_, i) => ["f" + i, "ok"]));
  const g = await b.checkStep("big", ok);
  assert.equal(g.verdict, "green");
  assert.equal((await b.check(advance(g, "big"))).rule, "rubric.exhausted", "two oversize red lines were still counted");
});

function lines(p) { return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
