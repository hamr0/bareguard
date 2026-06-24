// Cost contract (eval-assist PRD §3.7/§3.8): an `unpriced` round carries an
// UNKNOWN cost, not a free one. bareguard must never let "couldn't price" masquerade
// as "cost = 0" (the #3 silent-zero footgun). This suite pins:
//   - an unpriced round accrues NO cost but STILL accrues tokens/counts;
//   - it emits a loud `unpriced` audit phase (default-warn, never silent);
//   - `failClosedOnUnpriced` halts at check() under a finite cost cap (per-round);
//   - back-compat: `pricing` absent ⇒ priced, the `costUsd ?? 0` path is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { Budget } from "../src/primitives/budget.js";

const phaseLines = (entries, phase) => entries.filter(e => e.phase === phase);

test("unpriced round accrues NO cost but STILL accrues tokens (cost unknown ≠ free)", async () => {
  const b = new Budget({ maxCostUsd: 1.0, maxTokens: 1000 });
  const { unpriced } = await b.record({ costUsd: 0.5, tokens: 100, pricing: "unpriced" });
  assert.equal(unpriced, true);
  assert.equal(b.spentUsd, 0, "unpriced cost must NOT accrue — 0.5 is unknown, not spent");
  assert.equal(b.spentTokens, 100, "tokens are provider-exact even when cost can't be priced");
});

test("priced (and pricing-absent) rounds accrue cost normally — back-compat unchanged", async () => {
  const b = new Budget({ maxCostUsd: 10 });
  await b.record({ costUsd: 0.5, tokens: 10 });                    // absent ⇒ priced
  await b.record({ costUsd: 0.5, tokens: 10, pricing: "priced" }); // explicit priced
  assert.equal(b.spentUsd, 1.0);
  assert.equal(b.spentTokens, 20);
});

test("default (failClosedOnUnpriced off): an unpriced round emits a loud `unpriced` phase, never halts", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { maxCostUsd: 1.0 } });
  await gate.init();
  await gate.record({ type: "llm" }, { costUsd: null, tokens: 50, pricing: "unpriced" });
  const unpricedLines = phaseLines(await gate.audit.readAll(), "unpriced");
  assert.equal(unpricedLines.length, 1, "the unpriced round is surfaced as its own audit phase");
  assert.match(unpricedLines[0].reason, /unenforceable/);
  const dec = await gate.check({ type: "llm" });
  assert.equal(dec.outcome, "allow", "default behavior never halts — it only records");
});

test("failClosedOnUnpriced + finite cap: check() halts after an unpriced round (rule budget.unpriced)", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { maxCostUsd: 1.0, failClosedOnUnpriced: true } });
  await gate.init();
  assert.equal((await gate.check({ type: "llm" })).outcome, "allow", "clean before any unpriced round");
  await gate.record({ type: "llm" }, { costUsd: null, tokens: 50, pricing: "unpriced" });
  const dec = await gate.check({ type: "llm" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.severity, "halt");
  assert.equal(dec.rule, "budget.unpriced");
  assert.match(dec.reason, /unenforceable/);
});

test("failClosedOnUnpriced is a no-op with NO finite cost cap (nothing to fail closed on)", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { failClosedOnUnpriced: true } }); // capUsd = Infinity
  await gate.init();
  await gate.record({ type: "llm" }, { tokens: 50, pricing: "unpriced" });
  const dec = await gate.check({ type: "llm" });
  assert.equal(dec.outcome, "allow", "no cost cap ⇒ unpriced is a pure audit signal, not a halt");
});

test("per-round: a subsequent PRICED round clears the fail-closed halt (no run-wide wedge)", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { maxCostUsd: 5.0, failClosedOnUnpriced: true } });
  await gate.init();
  await gate.record({ type: "llm" }, { costUsd: null, tokens: 50, pricing: "unpriced" });
  assert.equal((await gate.check({ type: "llm" })).rule, "budget.unpriced", "halts while unpriced is current");
  await gate.record({ type: "llm" }, { costUsd: 0.1, tokens: 50 }); // pricing resumes
  assert.equal((await gate.check({ type: "llm" })).outcome, "allow", "a priced round clears the halt");
});

test("token cap STILL enforces across unpriced rounds (the wall is unaffected by unpricing)", async () => {
  const gate = new Gate({ audit: { path: null }, budget: { maxTokens: 100 } });
  await gate.init();
  await gate.record({ type: "llm" }, { tokens: 60, pricing: "unpriced" });
  await gate.record({ type: "llm" }, { tokens: 60, pricing: "unpriced" }); // 120 >= 100
  const dec = await gate.check({ type: "llm" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "budget.maxTokens", "tokens halt even when every round was unpriced");
});
