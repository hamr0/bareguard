// Float-accrual correctness: a money cap must not under-count. Raw IEEE-754
// addition grows a tail (0.7 + 0.1 = 0.7999999999999999) that can land accrued
// spend just under the cap, so `spent >= cap` is false and the run NEVER halts —
// a cap bypass via numeric error (same class as the reverted rate-window opt:
// "faster under-counted under reordered timestamps"; correctness beats it). The
// fix quantizes accrued USD so the boundary decision is exact at money precision.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Budget } from "../src/primitives/budget.js";
import { makeTmpDir, cleanup } from "./_helpers.js";

test("float drift must not let accrued spend slip under a cap (0.7 + 0.1 vs 0.8)", async () => {
  const b = new Budget({ maxCostUsd: 0.8 });
  await b.record({ costUsd: 0.7 });
  await b.record({ costUsd: 0.1 });
  // Raw float: 0.7 + 0.1 = 0.7999999999999999 < 0.8 → would silently NOT halt.
  assert.equal(b.spentUsd, 0.8, "accrued spend is quantized, not a drifting float tail");
  const dec = b.check();
  assert.ok(dec, "cap must halt at the boundary despite float math (no bypass)");
  assert.equal(dec.rule, "budget.maxCostUsd");
});

test("quantization preserves small real per-round costs (no under-count to zero)", async () => {
  const b = new Budget({ maxCostUsd: 1 });
  // A tiny but real cache-read-scale cost (~$1e-7) must still accrue, not round away.
  await b.record({ costUsd: 0.0000001 });
  assert.equal(b.spentUsd, 0.0000001, "nanodollar precision keeps sub-micro costs");
});

test("many small accruals stay exact at the cap boundary", async () => {
  const b = new Budget({ maxCostUsd: 0.3 });
  await b.record({ costUsd: 0.1 });
  await b.record({ costUsd: 0.1 });
  await b.record({ costUsd: 0.1 }); // raw float → 0.30000000000000004
  assert.equal(b.spentUsd, 0.3, "no accumulated 1e-16 tail");
  assert.equal(b.check()?.rule, "budget.maxCostUsd", "halts exactly at cap");
});

test("cold-start rebuild must not re-introduce the drift bypass", async () => {
  const dir = await makeTmpDir();
  try {
    // Missing budget file → init() reconstructs spend from the audit. The rebuild
    // sums per-record costs with the same raw `+` (0.7 + 0.1), so it must be
    // quantized at the choke point or the bypass re-enters on a cold start.
    const b = new Budget({ maxCostUsd: 0.8, sharedFile: path.join(dir, "budget.json") });
    await b.init({ rebuildFromAudit: async () => ({ spentUsd: 0.7 + 0.1, spentTokens: 0 }) });
    assert.equal(b.spentUsd, 0.8, "rebuilt total is quantized, not 0.7999999999999999");
    assert.equal(b.check()?.rule, "budget.maxCostUsd", "halts at cap after a cold-start rebuild");
  } finally {
    await cleanup(dir);
  }
});
