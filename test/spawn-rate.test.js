// spawn-rate primitive: trailing-60s window, audit-log-counted, per-family.
// Composes with limits.maxChildren / limits.maxDepth.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

function makeClock(start = Date.parse("2026-05-01T00:00:00Z")) {
  let now = start;
  const fn = () => now;
  fn.advance = ms => { now += ms; };
  return fn;
}

test("spawn-rate: default cap 10 — 11th spawn denies", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({ audit: { path: auditPath }, _clock: clock });
  await gate.init();

  for (let i = 0; i < 10; i++) {
    const dec = await gate.check({ type: "spawn", args: { agent: "child" } });
    assert.equal(dec.outcome, "allow", `spawn ${i + 1}/10 should allow, got ${dec.rule}`);
    clock.advance(1_000);
  }

  const dec = await gate.check({ type: "spawn", args: { agent: "child" } });
  assert.equal(dec.outcome,  "deny");
  assert.equal(dec.rule,     "spawn.ratePerMinute");
  assert.equal(dec.severity, "action");
  assert.match(dec.reason,   /10\/10/);
});

test("spawn-rate: per-family — parent + child share one counter via shared audit file", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  // Parent emits 5 spawns.
  const parent = new Gate({
    audit:  { path: auditPath },
    spawn:  { ratePerMinute: 10 },
    _clock: clock,
  });
  await parent.init();
  for (let i = 0; i < 5; i++) {
    const dec = await parent.check({ type: "spawn", args: { agent: "child" } });
    assert.equal(dec.outcome, "allow");
    clock.advance(100);
  }

  // Child gate inherits the audit path (same family). Emits 5 more.
  const child = new Gate({
    audit:        { path: auditPath },     // same file = same family
    parentRunId:  parent.runId,
    rootRunId:    parent.rootRunId,
    spawnDepth:   1,
    spawn:        { ratePerMinute: 10 },
    _clock:       clock,
  });
  await child.init();
  for (let i = 0; i < 5; i++) {
    const dec = await child.check({ type: "spawn", args: { agent: "grand" } });
    assert.equal(dec.outcome, "allow", `child spawn ${i + 1}/5 should allow`);
    clock.advance(100);
  }

  // 11th spawn (anywhere in the family) denies.
  const dec = await child.check({ type: "spawn", args: { agent: "grand" } });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule,    "spawn.ratePerMinute");
});

test("spawn-rate: composes with limits.maxChildren — concurrency cap denies first", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({
    audit:  { path: auditPath },
    limits: { maxChildren: 3 },
    spawn:  { ratePerMinute: 100 },     // wide-open rate, narrow children
    _clock: clock,
  });
  await gate.init();

  // 3 spawns are recorded so the limits counter actually increments.
  for (let i = 0; i < 3; i++) {
    const action = { type: "spawn", args: { agent: "child" } };
    const dec = await gate.check(action);
    assert.equal(dec.outcome, "allow");
    await gate.record(action, { costUsd: 0, tokens: 0 });
    clock.advance(100);
  }

  // 4th spawn — limits.maxChildren denies before spawn-rate gets a vote.
  const dec = await gate.check({ type: "spawn", args: { agent: "child" } });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule,    "limits.maxChildren");
});

test("spawn-rate: window slide — emit cap, wait 61s, next emit allows", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({
    audit:  { path: auditPath },
    spawn:  { ratePerMinute: 4 },
    _clock: clock,
  });
  await gate.init();

  for (let i = 0; i < 4; i++) {
    const dec = await gate.check({ type: "spawn", args: { agent: "child" } });
    assert.equal(dec.outcome, "allow");
    clock.advance(100);
  }
  let dec = await gate.check({ type: "spawn", args: { agent: "child" } });
  assert.equal(dec.outcome, "deny");

  clock.advance(61_000);

  dec = await gate.check({ type: "spawn", args: { agent: "child" } });
  assert.equal(dec.outcome, "allow");
});

test("spawn-rate: post-cap deny records don't extend the ban window (I4)", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({
    audit: { path: auditPath },
    spawn: { ratePerMinute: 1 },
    _clock: clock,
  });
  await gate.init();

  // t=0: one allow (at cap)
  const d1 = await gate.check({ type: "spawn", args: { agent: "child" } });
  assert.equal(d1.outcome, "allow");

  // t=100: deny — must NOT count toward window
  clock.advance(100);
  const d2 = await gate.check({ type: "spawn", args: { agent: "child" } });
  assert.equal(d2.outcome, "deny");

  // Advance so allow ages out but deny is still in window
  clock.advance(59_950); // total: start + 60050, cutoff = start + 50

  const d3 = await gate.check({ type: "spawn", args: { agent: "child" } });
  assert.equal(d3.outcome, "allow", "deny records must not extend the ban window");
});

test("spawn-rate: defer actions don't count toward spawn cap", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({
    audit:  { path: auditPath },
    spawn:  { ratePerMinute: 2 },
    _clock: clock,
  });
  await gate.init();

  for (let i = 0; i < 5; i++) {
    const dec = await gate.check({ type: "defer", args: { when: "1m" } });
    assert.equal(dec.outcome, "allow");
    clock.advance(100);
  }

  for (let i = 0; i < 2; i++) {
    const dec = await gate.check({ type: "spawn", args: { agent: "child" } });
    assert.equal(dec.outcome, "allow");
    clock.advance(100);
  }
  const dec = await gate.check({ type: "spawn", args: { agent: "child" } });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule,    "spawn.ratePerMinute");
});
