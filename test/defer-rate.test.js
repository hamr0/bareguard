// defer-rate primitive: trailing-60s window, audit-log-counted, per-family.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

function makeClock(start = Date.parse("2026-05-01T00:00:00Z")) {
  let now = start;
  const fn = () => now;
  fn.advance = ms => { now += ms; };
  fn.set     = ms => { now  = ms; };
  return fn;
}

test("defer-rate: default cap 15 — 16th defer denies", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({ audit: { path: auditPath }, _clock: clock });
  await gate.init();

  for (let i = 0; i < 15; i++) {
    const dec = await gate.check({ type: "defer", args: { action: { type: "bash", cmd: "ls" }, when: "1m" } });
    assert.equal(dec.outcome, "allow", `defer ${i + 1}/15 should allow, got ${dec.rule}`);
    clock.advance(1_000); // 1s between attempts; all within 60s window
  }

  const dec = await gate.check({ type: "defer", args: { action: { type: "bash", cmd: "ls" }, when: "1m" } });
  assert.equal(dec.outcome,  "deny");
  assert.equal(dec.rule,     "defer.ratePerMinute");
  assert.equal(dec.severity, "action");
  assert.match(dec.reason,   /15\/15/);
});

test("defer-rate: configured cap is honored", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({
    audit:  { path: auditPath },
    defer:  { ratePerMinute: 3 },
    _clock: clock,
  });
  await gate.init();

  for (let i = 0; i < 3; i++) {
    const dec = await gate.check({ type: "defer", args: { when: "1m" } });
    assert.equal(dec.outcome, "allow");
    clock.advance(100);
  }
  const dec = await gate.check({ type: "defer", args: { when: "1m" } });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule,    "defer.ratePerMinute");
  assert.match(dec.reason,  /3\/3/);
});

test("defer-rate: window slide — emit cap, wait 61s, next emit allows", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({
    audit:  { path: auditPath },
    defer:  { ratePerMinute: 5 },
    _clock: clock,
  });
  await gate.init();

  for (let i = 0; i < 5; i++) {
    const dec = await gate.check({ type: "defer", args: { when: "1m" } });
    assert.equal(dec.outcome, "allow");
    clock.advance(100);
  }

  // 6th immediately → deny
  let dec = await gate.check({ type: "defer", args: { when: "1m" } });
  assert.equal(dec.outcome, "deny");

  // Slide past the window — all five (and the deny) age out
  clock.advance(61_000);

  dec = await gate.check({ type: "defer", args: { when: "1m" } });
  assert.equal(dec.outcome, "allow", "after window slide, defer should be allowed again");
});

test("defer-rate: spawn actions don't count toward defer cap", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({
    audit:  { path: auditPath },
    defer:  { ratePerMinute: 2 },
    _clock: clock,
  });
  await gate.init();

  // 5 spawns first — should NOT touch the defer counter
  for (let i = 0; i < 5; i++) {
    const dec = await gate.check({ type: "spawn", args: { agent: "child" } });
    assert.equal(dec.outcome, "allow");
    clock.advance(100);
  }

  // Now 2 defers should still pass under the cap of 2
  for (let i = 0; i < 2; i++) {
    const dec = await gate.check({ type: "defer", args: { when: "1m" } });
    assert.equal(dec.outcome, "allow", `defer ${i + 1}/2 should allow`);
    clock.advance(100);
  }

  // 3rd defer denies
  const dec = await gate.check({ type: "defer", args: { when: "1m" } });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule,    "defer.ratePerMinute");
});

test("defer-rate: two-phase — fired action is a separate gate.check, doesn't count toward defer rate", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({
    audit:  { path: auditPath },
    defer:  { ratePerMinute: 3 },
    _clock: clock,
  });
  await gate.init();

  // Emit 3 defers — at cap.
  for (let i = 0; i < 3; i++) {
    const dec = await gate.check({ type: "defer", args: { action: { type: "bash", cmd: "ls" }, when: "1m" } });
    assert.equal(dec.outcome, "allow");
    clock.advance(100);
  }

  // Fire one of them (the wake script's job): the inner action goes through
  // gate.check independently. action.type is "bash", not "defer" — does not
  // bump the defer counter.
  const fireDec = await gate.check({ type: "bash", cmd: "ls" });
  assert.equal(fireDec.outcome, "allow");

  // Defer rate is still at 3/3, so a 4th emit denies. The fire above did NOT
  // re-evaluate defer rate.
  const dec = await gate.check({ type: "defer", args: { action: { type: "bash", cmd: "ls" }, when: "1m" } });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule,    "defer.ratePerMinute");
});

test("defer-rate: post-cap deny records don't extend the ban window (I4)", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({
    audit: { path: auditPath },
    defer: { ratePerMinute: 1 },
    _clock: clock,
  });
  await gate.init();

  // t=0: one allow (at cap)
  const d1 = await gate.check({ type: "defer", args: { when: "1m" } });
  assert.equal(d1.outcome, "allow");

  // t=100: deny (cap exceeded) — this record must NOT count toward the window
  clock.advance(100);
  const d2 = await gate.check({ type: "defer", args: { when: "1m" } });
  assert.equal(d2.outcome, "deny");

  // Advance clock so the allow at t=0 ages out but the deny at t=100 is still in window.
  // cutoff = now - 60000. With now = start+60050: cutoff = start+50.
  // allow(t=0) < cutoff → excluded. deny(t=100) >= cutoff → in window but not counted.
  clock.advance(59_950); // total: start + 60050

  const d3 = await gate.check({ type: "defer", args: { when: "1m" } });
  assert.equal(d3.outcome, "allow", "deny records must not extend the ban window");
});

test("defer-rate: cap of Infinity disables the guard", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const clock = makeClock();

  const gate = new Gate({
    audit:  { path: auditPath },
    defer:  { ratePerMinute: Infinity },
    _clock: clock,
  });
  await gate.init();

  for (let i = 0; i < 100; i++) {
    const dec = await gate.check({ type: "defer", args: { when: "1m" } });
    assert.equal(dec.outcome, "allow");
    clock.advance(50);
  }
});
