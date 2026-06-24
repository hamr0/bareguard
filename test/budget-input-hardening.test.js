// Input hardening for the cumulative cap (the floor must not trust the meter's
// numbers). Three cap-bypass classes via malformed `record()` cost/token input:
//   1. null cost WITHOUT the pricing flag → silent 0 (the residual #3-shape).
//   2. non-finite cost (NaN/±Inf) → poisons spentUsd to NaN; `NaN >= cap` is false,
//      which doesn't under-count — it DISABLES the cap entirely.
//   3. negative cost/tokens → "refund" that lowers cumulative spend below a cap
//      (the counts axis already guards this; cost/tokens didn't).
// The floor derives "unpriced" from the value (not just the flag) and clamps
// negatives — monotonic spend, fail-safe.
import test from "node:test";
import assert from "node:assert/strict";
import { Budget } from "../src/primitives/budget.js";

test("null costUsd without the pricing flag is treated as unpriced (not silent 0)", async () => {
  const b = new Budget({ maxCostUsd: 1, failClosedOnUnpriced: true });
  const { unpriced } = await b.record({ costUsd: null, tokens: 10 });
  assert.equal(unpriced, true, "null cost = couldn't price, derived even without pricing:'unpriced'");
  assert.equal(b.spentUsd, 0, "unknown cost accrues nothing, not a silent 0-that-looks-priced");
  assert.equal(b.spentTokens, 10, "tokens still accrue");
  assert.equal(b.check()?.rule, "budget.unpriced", "arms fail-closed under a finite cap");
});

test("non-finite costUsd (NaN / ±Infinity) is unpriced and does not poison the cap", async () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const b = new Budget({ maxCostUsd: 0.5 });
    const { unpriced } = await b.record({ costUsd: bad });
    assert.equal(unpriced, true, `${bad} → unpriced`);
    assert.ok(Number.isFinite(b.spentUsd), `spentUsd stays finite after costUsd=${bad} (cap not disabled)`);
    await b.record({ costUsd: 0.5 }); // a later real spend
    assert.equal(b.check()?.rule, "budget.maxCostUsd", `cap still enforces after costUsd=${bad}`);
  }
});

test("negative costUsd is clamped — cannot un-spend past the cap (refund evasion)", async () => {
  const b = new Budget({ maxCostUsd: 1 });
  await b.record({ costUsd: 0.8 });
  await b.record({ costUsd: -0.5 }); // a "refund" must not lower cumulative spend
  assert.equal(b.spentUsd, 0.8, "negative delta rejected — spend is monotonic");
});

test("negative tokens are clamped — the token wall is monotonic too", async () => {
  const b = new Budget({ maxTokens: 100 });
  await b.record({ tokens: 80 });
  await b.record({ tokens: -40 });
  assert.equal(b.spentTokens, 80, "negative token delta rejected");
});

test("regression: absent costUsd (a non-cost action) is NOT treated as unpriced", async () => {
  const b = new Budget({ maxCostUsd: 1, failClosedOnUnpriced: true, resources: { writes: 5 } });
  const { unpriced } = await b.record({ counts: { writes: 1 } });
  assert.equal(unpriced, false, "undefined costUsd = non-cost action, not an unpriced round");
  assert.equal(b.check(), null, "must not arm fail-closed for ordinary non-cost actions");
});
