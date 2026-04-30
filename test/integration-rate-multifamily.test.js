// Two unrelated agent runs (different rootRunIds → different audit files)
// hammer the defer/spawn rate caps simultaneously. Neither should see the
// other's count: the audit file is per-family, which is the per-family scope.

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

test("multi-family: separate audit files = separate rate counters", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath: pathA } = uniquePaths(dir);
  const { auditPath: pathB } = uniquePaths(dir);
  const clock = makeClock();

  const familyA = new Gate({
    audit:  { path: pathA },
    defer:  { ratePerMinute: 5 },
    spawn:  { ratePerMinute: 5 },
    _clock: clock,
  });
  const familyB = new Gate({
    audit:  { path: pathB },
    defer:  { ratePerMinute: 5 },
    spawn:  { ratePerMinute: 5 },
    _clock: clock,
  });
  await familyA.init();
  await familyB.init();

  // Family A burns its full defer cap.
  for (let i = 0; i < 5; i++) {
    const dec = await familyA.check({ type: "defer", args: { when: "1m" } });
    assert.equal(dec.outcome, "allow");
    clock.advance(50);
  }
  let aNext = await familyA.check({ type: "defer", args: { when: "1m" } });
  assert.equal(aNext.outcome, "deny");
  assert.equal(aNext.rule,    "defer.ratePerMinute");

  // Family B should be untouched — fresh 0/5 counter.
  for (let i = 0; i < 5; i++) {
    const dec = await familyB.check({ type: "defer", args: { when: "1m" } });
    assert.equal(dec.outcome, "allow", `family B defer ${i + 1}/5 should allow despite family A being saturated`);
    clock.advance(50);
  }
  const bNext = await familyB.check({ type: "defer", args: { when: "1m" } });
  assert.equal(bNext.outcome, "deny", "family B at its own cap now");
  assert.equal(bNext.rule,    "defer.ratePerMinute");

  // And family A is still saturated, independent of family B's state.
  aNext = await familyA.check({ type: "defer", args: { when: "1m" } });
  assert.equal(aNext.outcome, "deny");
});

test("multi-family: spawn rate also independent across families", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath: pathA } = uniquePaths(dir);
  const { auditPath: pathB } = uniquePaths(dir);
  const clock = makeClock();

  const a = new Gate({ audit: { path: pathA }, spawn: { ratePerMinute: 3 }, _clock: clock });
  const b = new Gate({ audit: { path: pathB }, spawn: { ratePerMinute: 3 }, _clock: clock });
  await a.init();
  await b.init();

  for (let i = 0; i < 3; i++) {
    const dec = await a.check({ type: "spawn", args: { agent: "x" } });
    assert.equal(dec.outcome, "allow");
    clock.advance(50);
  }
  assert.equal((await a.check({ type: "spawn", args: { agent: "x" } })).outcome, "deny");
  assert.equal((await b.check({ type: "spawn", args: { agent: "x" } })).outcome, "allow");
});
