import test from "node:test";
import assert from "node:assert/strict";
import { quoteIn, numbersInQuote, renderGaps, createRubric, checkStep } from "../src/index.js";

// ---------------------------------------------------------------------------
// quoteIn / numbersInQuote / renderGaps (docs/product/rubric-prd.md §4.2, §7)
// ---------------------------------------------------------------------------

const CAP = 5 * 1024 * 1024;

test("quoteIn: exact substring is ok; a changed word, case change and a paraphrase are not", () => {
  assert.deepEqual(quoteIn("ships in 2 weeks", "It ships in 2 weeks."), { ok: true });
  assert.deepEqual(quoteIn("ships in 3 weeks", "It ships in 2 weeks."), { ok: false, why: "not-found" });
  assert.equal(quoteIn("Ships", "ships").ok, false, "case-sensitive");
  assert.equal(quoteIn("delivers in two weeks", "It ships in 2 weeks.").ok, false);
});

test("quoteIn: '**' and '__' are forgiven on both sides, nothing else is", () => {
  assert.equal(quoteIn("ships in 2 weeks", "It **ships in 2 weeks**.").ok, true);
  assert.equal(quoteIn("**ships** in 2 weeks", "It ships in 2 weeks.").ok, true);
  assert.equal(quoteIn("ships in 2 weeks", "It __ships__ in 2 weeks").ok, true);
  assert.equal(quoteIn("ships in 2 weeks", "It *ships* in 2 weeks").ok, false, "single '*' is not stripped");
  assert.equal(quoteIn("ships in 2 weeks", "It `ships` in 2 weeks").ok, false);
});

test("quoteIn: reflowed whitespace (newlines, tabs, runs of spaces) is forgiven; whole-quote substring, not line-wise", () => {
  assert.equal(quoteIn("ships in 2 weeks", "It ships\n   in\t\t2\r\nweeks.").ok, true);
  assert.equal(quoteIn("  ships   in 2\nweeks ", "It ships in 2 weeks.").ok, true);
  assert.equal(quoteIn("line one line two", "line one\nline two").ok, true, "spans a line break");
  assert.equal(quoteIn("shipsin", "ships in").ok, false, "whitespace is collapsed, not deleted");
  assert.equal(quoteIn("ships in", "ships ** in").ok, true, "markers between words do not leave a double space");
});

test("quoteIn: empty quote (also after normalizing) and non-strings are not ok; never throws", () => {
  for (const q of ["", "   ", "**", "__", " ** __ \n"]) assert.deepEqual(quoteIn(q, "anything"), { ok: false, why: "empty-quote" }, JSON.stringify(q));
  for (const [q, s] of [[1, "a"], ["a", null], [undefined, undefined], [{}, []], [Symbol("x"), "a"]]) assert.deepEqual(quoteIn(q, s), { ok: false, why: "not-a-string" });
});

test("quoteIn: the 5 MB source cap — AT the cap is searched, OVER it is red 'source-too-large' (bytes, not UTF-16 units)", () => {
  const atCap = "a".repeat(CAP);
  assert.equal(Buffer.byteLength(atCap), CAP);
  assert.deepEqual(quoteIn("aaa", atCap), { ok: true });
  assert.deepEqual(quoteIn("aaa", atCap + "a"), { ok: false, why: "source-too-large" });
  // 2-byte characters: 2,621,440 of them is exactly the cap, one more is over — though the string is only ~2.6M UTF-16 units
  assert.deepEqual(quoteIn("é", "é".repeat(CAP / 2)), { ok: true });
  assert.deepEqual(quoteIn("é", "é".repeat(CAP / 2 + 1)), { ok: false, why: "source-too-large" });
  // an oversize source that CONTAINS the quote is still refused
  assert.equal(quoteIn("needle", "needle" + "a".repeat(CAP)).ok, false);
});

test("quoteIn: a long adversarial search stays fast (no regex built from the input, linear handling)", () => {
  const hay = "a".repeat(CAP - 10);
  const t0 = Date.now();
  assert.equal(quoteIn("a".repeat(200000) + "b", hay).ok, false);
  assert.equal(quoteIn(" ".repeat(1_000_000) + "a", hay).ok, true);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
});

test("numbersInQuote: every claim number must be a TOKEN in the quote — '8' is not '2018'", () => {
  assert.deepEqual(numbersInQuote("grew 8%", "grew 8%"), { ok: true, missing: [] });
  assert.deepEqual(numbersInQuote("grew 8%", "grew in 2018"), { ok: false, missing: ["8"] });
  assert.deepEqual(numbersInQuote("8", "x28y"), { ok: false, missing: ["8"] }, "digits inside a longer number do not count");
  assert.equal(numbersInQuote("8", "has 8 items").ok, true);
  assert.equal(numbersInQuote("8", "has 8.5 items").ok, false, "8.5 is the token 8.5, not 8");
});

test("numbersInQuote: '8x' is 8, '1.2k' is 1.2, '50%' is 50, '2 weeks' is 2; the 8x vs '2 weeks -> 4 hours' case is red", () => {
  assert.equal(numbersInQuote("8x", "got 8 times").ok, true);
  assert.equal(numbersInQuote("1.2k users", "1.2 thousand users").ok, true);
  assert.equal(numbersInQuote("50% off", "half: 50 percent").ok, true);
  assert.equal(numbersInQuote("2 weeks", "in 2 weeks").ok, true);
  assert.deepEqual(numbersInQuote("delivers in 4 hours", "delivers in 2 weeks"), { ok: false, missing: ["4"] });
  assert.deepEqual(numbersInQuote("a 8x gain over 2 weeks", "a 2 week trial"), { ok: false, missing: ["8"] });
  assert.equal(numbersInQuote("no numbers here", "none either").ok, true);
});

test("numbersInQuote: number words are unchecked and '1,200' vs '1200' is a false red (documented gaps, pinned)", () => {
  assert.equal(numbersInQuote("grew by two", "grew by 7").ok, true, "number words are not checked");
  assert.deepEqual(numbersInQuote("1,200 users", "1200 users"), { ok: false, missing: ["1", "200"] });
  assert.equal(numbersInQuote("1200 users", "1200 users").ok, true);
});

test("numbersInQuote: tokens are exact strings ('1.50' is not '1.5'), missing is de-duplicated and capped, non-strings are not ok", () => {
  assert.equal(numbersInQuote("1.50", "1.5").ok, false);
  assert.deepEqual(numbersInQuote("7 7 7", "x").missing, ["7"]);
  assert.equal(numbersInQuote(Array.from({ length: 100 }, (_, i) => i + 100).join(" "), "x").missing.length, 20);
  assert.deepEqual(numbersInQuote(1, "a"), { ok: false, missing: [], why: "not-a-string" });
  assert.deepEqual(numbersInQuote("a", null), { ok: false, missing: [], why: "not-a-string" });
});

// --- renderGaps -----------------------------------------------------------------

const G = (over = {}) => ({ key: "cp:a", checkpoint: "cp", check: "maxWords", id: "a", field: "text", kind: "over", measured: 633, limit: 600, direction: "at-most", ...over });

test("renderGaps: byte-identical on the same failing state; different states render differently; order is the given (signed) order", () => {
  const a = [G(), G({ key: "cp:b", id: "b", check: "mustCarry", kind: "missing", measured: undefined, limit: undefined, direction: undefined, items: ["x"] })];
  assert.equal(renderGaps(a), renderGaps(structuredClone(a)));
  assert.equal(renderGaps(a), renderGaps(a));
  assert.notEqual(renderGaps(a), renderGaps([G({ measured: 634 }), a[1]]), "a different measured value");
  assert.notEqual(renderGaps(a), renderGaps([G({ limit: 599 }), a[1]]));
  assert.notEqual(renderGaps(a), renderGaps([a[1], a[0]]), "order is part of the render");
  assert.notEqual(renderGaps(a), renderGaps([a[0]]));
  assert.notEqual(renderGaps([G({ measured: 5 })]), renderGaps([G({ measured: "5" })]), "number vs string");
});

test("renderGaps: entries joined by '; ', each rendered from its gap fields in a fixed order", () => {
  const out = renderGaps([G(), G({ key: "cp:b" })]);
  assert.equal(out, '["cp:a","maxWords","over","text",633,600,"at-most",null,null]; ["cp:b","maxWords","over","text",633,600,"at-most",null,null]');
  assert.equal(out.split("; ").length, 2);
  assert.equal(renderGaps([]), "");
});

test("renderGaps is injective even when a gap field contains the separator or JSON metacharacters", () => {
  const a = renderGaps([G({ items: ['x"], ["y'] })]);
  const b = renderGaps([G({ items: ["x"] }), G({ items: ["y"] })]);
  assert.notEqual(a, b);
  assert.notEqual(renderGaps([G({ items: ["a; b"] })]), renderGaps([G({ items: ["a", "b"] })]));
});

test("renderGaps: gaps from real runs render stably across retries; a changed measurement changes the render; never throws on junk", async () => {
  const rub = createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "w", rule: "maxWords", field: "text", value: 3 }] } } });
  const a = await checkStep(rub, "cp", "one two three four five");
  const b = await checkStep(rub, "cp", "one two three four five");
  const c = await checkStep(rub, "cp", "one two three four five six");
  assert.equal(renderGaps(a.gaps), renderGaps(b.gaps));
  assert.notEqual(renderGaps(a.gaps), renderGaps(c.gaps));
  for (const junk of [null, undefined, "x", 5, {}, [null, 3, "x", undefined], [{ get key() { throw new Error("no"); } }]]) {
    assert.doesNotThrow(() => renderGaps(junk));
  }
  assert.equal(renderGaps("not an array"), "");
});
