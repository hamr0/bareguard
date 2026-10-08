import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRubric, checkStep } from "../src/index.js";

// ---------------------------------------------------------------------------
// checkStep — value rules, cited, complete (docs/product/rubric-prd.md §4.1, §4.4)
// ---------------------------------------------------------------------------

const sha = (s) => createHash("sha256").update(s).digest("hex");
const run = (checks, output, opts, extra = {}) =>
  checkStep(createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks } }, ...extra }), "cp", output, opts);
const gap = (r) => r.gaps[0];

test("in / notIn: strict equality against the signed list; non-string, missing and unreadable are red, never green", async () => {
  const inn = (v) => run([{ id: "k", rule: "in", field: "s", values: ["low", "high"] }], { s: v });
  const notIn = (v) => run([{ id: "k", rule: "notIn", field: "s", values: ["bad", "worse"] }], { s: v });
  assert.equal((await inn("low")).verdict, "green");
  assert.equal(gap(await inn("LOW")).kind, "not-in", "exact, case-sensitive");
  assert.equal(gap(await inn("medium")).kind, "not-in");
  assert.deepEqual(gap(await inn("medium")).items, ["low", "high"]);
  assert.equal((await notIn("fine")).verdict, "green");
  assert.equal(gap(await notIn("bad")).kind, "forbidden");
  for (const f of [inn, notIn]) {
    for (const v of [NaN, Infinity, -Infinity, 5, null, true, ["low"], { a: 1 }]) {
      const r = await f(v);
      assert.equal(r.verdict, "red", `${String(v)} must be red`);
      assert.equal(gap(r).kind, "wrong-type");
    }
    assert.equal(gap(await run([{ id: "k", rule: f === inn ? "in" : "notIn", field: "s", values: ["x"] }], { other: 1 })).kind, "missing");
  }
});

test("atMost: ordered-enum rank <= the signed value's; unknown or wrong type is red; gap has direction", async () => {
  const order = ["low", "medium", "high"];
  const am = (v) => run([{ id: "k", rule: "atMost", field: "risk", value: "medium", order }], { risk: v });
  assert.equal((await am("low")).verdict, "green");
  assert.equal((await am("medium")).verdict, "green", "AT");
  const over = await am("high");
  assert.deepEqual([gap(over).kind, gap(over).measured, gap(over).limit, gap(over).direction], ["over", "high", "medium", "at-most"]);
  assert.equal(gap(await am("catastrophic")).kind, "unknown");
  for (const v of [NaN, Infinity, -Infinity, 1, null, undefined, {}]) {
    const r = await am(v);
    assert.equal(r.verdict, "red", String(v));
    assert.equal(gap(r).direction, "at-most", "ordered rules carry direction even for a wrong-type red");
  }
});

test("max / min: finite number comparisons, AT / UNDER / OVER; NaN, +-Infinity, wrong type, missing = red", async () => {
  const mx = (v) => run([{ id: "k", rule: "max", field: "n", value: 10 }], { n: v });
  const mn = (v) => run([{ id: "k", rule: "min", field: "n", value: 10 }], { n: v });
  assert.deepEqual([(await mx(9)).verdict, (await mx(10)).verdict, (await mx(10.0001)).verdict], ["green", "green", "red"]);
  assert.deepEqual([(await mn(11)).verdict, (await mn(10)).verdict, (await mn(9.9999)).verdict], ["green", "green", "red"]);
  const g = gap(await mx(11));
  assert.deepEqual([g.kind, g.measured, g.limit, g.direction], ["over", 11, 10, "at-most"]);
  const g2 = gap(await mn(9));
  assert.deepEqual([g2.kind, g2.measured, g2.limit, g2.direction], ["under", 9, 10, "at-least"]);
  assert.equal((await mx(-5)).verdict, "green");
  for (const f of [mx, mn]) {
    for (const [v, measured] of [[NaN, "NaN"], [Infinity, "Infinity"], [-Infinity, "-Infinity"], ["5", "type:string"], [null, "type:null"], [[5], "type:array"], [{}, "type:object"], [true, "type:boolean"]]) {
      const r = await f(v);
      assert.equal(r.verdict, "red", `${String(v)}`);
      assert.deepEqual([gap(r).kind, gap(r).measured], ["not-finite-number", measured]);
    }
  }
  assert.equal(gap(await run([{ id: "k", rule: "max", field: "n", value: 10 }], { other: 1 })).kind, "missing");
});

// --- cited -----------------------------------------------------------------------

const SOURCE = "Acme grew **revenue** 40% in 2018.\nIt ships in\n2 weeks.";
const withCited = (claims, input = SOURCE, extra = {}) =>
  run(
    [{ id: "c", rule: "cited", claims: "claims", source: "doc" }],
    { claims },
    { inputs: { doc: input } },
    { inputs: [{ name: "doc", sha256: sha(SOURCE) }], ...extra },
  );

test("cited: every claim's quote is in the frozen input AND its numbers are in the quote", async () => {
  const good = [
    { claim: "revenue grew 40%", quote: "grew revenue 40% in 2018".replace("grew revenue", "grew **revenue**") },
    { claim: "ships in 2 weeks", quote: "ships in 2 weeks" },
  ];
  assert.equal((await withCited(good)).verdict, "green");
});

test("cited: red kinds are named per claim index: not found, empty quote, numbers drift, malformed", async () => {
  const r = await withCited([
    { claim: "ok", quote: "ships in 2 weeks" },
    { claim: "a", quote: "ships in 3 weeks" },
    { claim: "a", quote: "   " },
    { claim: "delivers in 4 hours", quote: "ships in 2 weeks" },
    { claim: "no quote field" },
    "not an object",
    { claim: "8x", quote: "in 2018" },
  ]);
  assert.equal(r.verdict, "red");
  assert.deepEqual(gap(r).items, ["#1:quote-not-found", "#2:empty-quote", "#3:numbers:4", "#4:malformed", "#5:malformed", "#6:numbers:8"]);
  assert.deepEqual([gap(r).kind, gap(r).measured, gap(r).limit, gap(r).field], ["unsupported", 6, 7, "claims"]);
});

test("cited: the signed input must match; a missing or altered input is STOPPED, not red", async () => {
  const mk = (inputs) => run([{ id: "c", rule: "cited", claims: "claims", source: "doc" }], { claims: [{ claim: "x", quote: SOURCE.slice(0, 10) }] }, { inputs }, { inputs: [{ name: "doc", sha256: sha(SOURCE) }] });
  for (const inputs of [undefined, {}, { doc: 5 }, { doc: SOURCE + " tampered" }]) {
    const r = await mk(inputs);
    assert.equal(r.verdict, "stopped", JSON.stringify(inputs));
    assert.equal(r.fault.kind, "missing-measurement");
    assert.deepEqual(r.gaps, [], "no gap to the worker");
  }
  assert.equal((await mk({ doc: SOURCE })).verdict, "green");
});

test("cited: claims field missing / not an array = red; an EMPTY list is red 'no-claims', never vacuous green", async () => {
  const mk = (out) => run([{ id: "c", rule: "cited", claims: "claims", source: "doc" }], out, { inputs: { doc: SOURCE } }, { inputs: [{ name: "doc", sha256: sha(SOURCE) }] });
  assert.equal(gap(await mk({ x: 1 })).kind, "missing");
  assert.equal(gap(await mk({ claims: "none" })).kind, "wrong-type");
  const empty = await mk({ claims: [] });
  assert.equal(empty.verdict, "red");
  assert.deepEqual([gap(empty).kind, gap(empty).measured], ["no-claims", 0]);
  // independent of `complete`: no complete check in the rubric, and the output itself is non-empty
  const withText = await mk({ text: "a long, perfectly real output", claims: [] });
  assert.equal(withText.verdict, "red");
  assert.equal(gap(withText).kind, "no-claims");
  // control: one valid claim is still green
  assert.equal((await mk({ claims: [{ claim: "x", quote: SOURCE.slice(0, 10) }] })).verdict, "green");
});

// --- complete ---------------------------------------------------------------------

test("complete with a signed list: an omitted item is red; extra claims are fine; item must equal exactly", async () => {
  const c = (claims) => run([{ id: "k", rule: "complete", claims: "claims", items: ["alpha", "beta", "gamma"] }], { claims });
  assert.equal((await c([{ item: "alpha" }, { item: "beta" }, { item: "gamma" }, { item: "extra" }])).verdict, "green");
  const r = await c([{ item: "alpha" }, { item: "Beta" }, { item: "gamma " }, "gamma", null]);
  assert.equal(r.verdict, "red");
  assert.deepEqual([gap(r).kind, gap(r).items, gap(r).measured, gap(r).limit], ["uncovered", ["beta", "gamma"], 2, 3]);
  assert.equal(gap(await run([{ id: "k", rule: "complete", claims: "claims", items: ["a"] }], { x: 1 })).kind, "missing");
  assert.equal(gap(await run([{ id: "k", rule: "complete", claims: "claims", items: ["a"] }], { claims: {} })).kind, "wrong-type");
});

test("complete with itemsFrom caller: the list is recorded (count + sha) for the audit; missing or empty list = STOPPED", async () => {
  const mk = (items, claims = [{ item: "a" }, { item: "b" }]) =>
    run([{ id: "k", rule: "complete", claims: "claims", itemsFrom: "caller" }], { claims }, { items });
  const ok = await mk({ k: ["a", "b"] });
  assert.equal(ok.verdict, "green");
  assert.deepEqual(ok.callerItems, { k: { count: 2, sha256: sha(JSON.stringify(["a", "b"])) } });
  for (const items of [undefined, {}, { k: [] }, { k: "a" }, { k: [""] }, { k: [5] }, { other: ["a"] }]) {
    const r = await mk(items);
    assert.equal(r.verdict, "stopped", JSON.stringify(items));
    assert.equal(r.fault.kind, "missing-measurement");
    assert.deepEqual(r.gaps, []);
    assert.deepEqual(r.callerItems, {}, "nothing recorded for a refused list");
  }
  const red = await mk({ k: ["a", "b", "c"] });
  assert.deepEqual([red.verdict, gap(red).items], ["red", ["c"]]);
});

test("complete: the claims' own list is never the item list (the judge/agent cannot shrink what must be covered)", async () => {
  // Claims cover only 'a'; the caller's list says a,b,c: b and c are reported even though the output never mentions them.
  const r = await run([{ id: "k", rule: "complete", claims: "claims", itemsFrom: "caller" }], { claims: [{ item: "a" }], items: ["a"] }, { items: { k: ["a", "b", "c"] } });
  assert.deepEqual(gap(r).items, ["b", "c"]);
});

test("gap item lists are bounded: 20 shown, the true total reported; SIGNED items unclipped, CALLER items clipped", async () => {
  const items = Array.from({ length: 50 }, (_, i) => `item-${i}-${"x".repeat(300)}`);
  const r = await run([{ id: "k", rule: "complete", claims: "claims", items }], { claims: [] });
  assert.equal(gap(r).items.length, 20);
  assert.equal(gap(r).itemsTotal, 50);
  assert.deepEqual(gap(r).items, items.slice(0, 20), "signed items ride the gap whole (the worker must reproduce them)");
  assert.ok(JSON.stringify(gap(r)).length < 20 * 1100);
  // caller-supplied (measured) items ARE clipped
  const r2 = await run([{ id: "k", rule: "complete", claims: "claims", itemsFrom: "caller" }], { claims: [] }, { items: { k: items } });
  assert.equal(gap(r2).items.length, 20);
  assert.ok(gap(r2).items.every((x) => x.length <= 120));
});
