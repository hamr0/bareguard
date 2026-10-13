import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Gate, createRubric, checkStep, rubricSha, rubricVocabulary, renderGaps } from "../src/index.js";
import { describeRule } from "../src/primitives/rubric.js";
import { parseClaimValue } from "../src/primitives/rubric-locate.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

// `cited` with `decides` and the typed claim binding (docs/product/rubric-prd.md §4.6, RULED #48-#55, §10).

const sha = (s) => createHash("sha256").update(s).digest("hex");

// bareloop's REAL Google Flights link line (LAX to SFO), verbatim from §5.2 E4.
const REAL =
  'link "From 59 US dollars. Nonstop flight with American. Operated by SkyWest Airlines as American Eagle. Leaves Los Angeles International Airport at 9:27 AM on Thursday, November 12 and arrives at San Francisco International Airport at 11:07 AM on Thursday, November 12. Total duration 1 hr 40 min. 1 carry-on bag included. 0 checked bags included. Select flight"';
// A fake-friendly line: the digits 7 and 00 occur elsewhere in it, so `numbersInQuote` alone cannot see a fake 7:00 AM.
const UNITED =
  'link "From 59 US dollars. Nonstop flight with United. Leaves Los Angeles International Airport at 9:27 AM on Thursday, November 12 and arrives at San Francisco International Airport at 11:07 AM on Thursday, November 12. Total duration 7 hr 00 min. Select flight"';

const D0 = { valueKind: "money", unit: "US dollars", op: "lt", value: 400, anchor: "From " };
const D1 = { valueKind: "time", op: "between", lo: "06:00", hi: "21:00", anchor: "Leaves Los Angeles International Airport at " };
const D2 = { phrases: ["Nonstop flight"] };
const E4 = [D0, D1, D2];

function mkRubric(source, decides, extra = {}) {
  const check = { id: "c", rule: "cited", claims: "claims", source: "offers", ...(decides ? { decides } : {}) };
  return createRubric({
    schema: 1,
    goal: "g",
    inputs: [{ name: "offers", sha256: sha(source) }],
    checkpoints: { cp: { gating: true, checks: [check] } },
    ...extra,
  });
}
const runWith = (source, decides, claims) => checkStep(mkRubric(source, decides), "cp", { claims }, { inputs: { offers: source } });
const items = (r) => r.gaps[0]?.items;
const claimOf = (quote, values, claim = "American nonstop, departs 9:27 AM, $59") => ({ claim, quote, ...(values ? { values } : {}) });
const TRUE_VALUES = { d0: "59", d1: "9:27 AM" };

// --- the POC set on the real link line ------------------------------------------------------------

test("honest claim over the real link line is a plain green (never soft-green)", async () => {
  const r = await runWith(REAL, E4, [claimOf(REAL, TRUE_VALUES)]);
  assert.equal(r.verdict, "green", JSON.stringify(r.gaps));
  assert.equal(r.softGreen, undefined);
  assert.deepEqual(r.gaps, []);
  assert.equal(r.fault, null);
});

test("fake 7:00 AM with the true price: red claim-value-mismatch on d1, while numbersInQuote ALONE is green", async () => {
  const claim = "United, departs 7:00 AM, $59";
  const r = await runWith(UNITED, E4, [{ claim, quote: UNITED, values: { d0: "59", d1: "7:00 AM" } }]);
  assert.equal(r.verdict, "red");
  assert.deepEqual(items(r), ["#0:d1:claim-value-mismatch:07:00!=09:27"]);
  // numbersInQuote alone (a cited check with no decides) cannot see it
  const alone = await runWith(UNITED, null, [{ claim, quote: UNITED }]);
  assert.equal(alone.verdict, "green", "the digits 7, 00 and 59 all occur in the line: the old check is blind to the fake time");
});

test("fake price with the true time: red mismatch on d0", async () => {
  const r = await runWith(REAL, E4, [claimOf(REAL, { d0: "45", d1: "9:27 AM" }, "American nonstop, departs 9:27 AM")]);
  assert.deepEqual(items(r), ["#0:d0:claim-value-mismatch:45!=59"]);
  assert.equal(r.gaps[0].kind, "unsupported");
  assert.equal(r.gaps[0].check, "cited");
  assert.equal(r.gaps[0].key, "cp:c");
});

test("canonical equality: 09:27 = 9:27 AM, 59.00 = 59 = 0059, 1,200 = 1200; AM != PM; 21:27 red", async () => {
  const t = async (v1, v0 = "59") => (await runWith(REAL, E4, [claimOf(REAL, { d0: v0, d1: v1 }, "x")])).verdict;
  assert.equal(await t("09:27"), "green");
  assert.equal(await t("9:27 AM"), "green");
  assert.equal(await t("9:27"), "green");
  assert.equal(await t("  9:27 AM "), "green", "surrounding whitespace is fine");
  assert.equal(await t("21:27"), "red");
  assert.equal(await t("9:27 PM"), "red", "AM vs PM is no longer invisible");
  const pm = await runWith(REAL, E4, [claimOf(REAL, { d0: "59", d1: "9:27 PM" }, "x")]);
  assert.deepEqual(items(pm), ["#0:d1:claim-value-mismatch:21:27!=09:27"]);
  assert.equal(await t("9:27 AM", "59.00"), "green");
  assert.equal(await t("9:27 AM", "0059"), "green", "leading zeros are digits of the grammar and equal 59");
  assert.equal(await t("9:27 AM", "59.10"), "red");
  const big = 'link "From 1,200 US dollars. Nonstop flight with X. Leaves Los Angeles International Airport at 9:27 AM"';
  const dec = [{ ...D0, value: 5000 }, D1, D2];
  for (const v of ["1,200", "1200", "1200.0"]) {
    assert.equal((await runWith(big, dec, [claimOf(big, { d0: v, d1: "9:27 AM" }, "x")])).verdict, "green", v);
  }
  assert.deepEqual(items(await runWith(big, dec, [claimOf(big, { d0: "1,20", d1: "9:27 AM" }, "x")])), ["#0:d0:claim-value-malformed"]);
  assert.deepEqual(items(await runWith(big, dec, [claimOf(big, { d0: "1201", d1: "9:27 AM" }, "x")])), ["#0:d0:claim-value-mismatch:1201!=1200"]);
});

test("missing, malformed and unknown claim values", async () => {
  const one = async (values, extra = {}) => items(await runWith(REAL, E4, [{ ...claimOf(REAL, undefined, "x"), ...(values === undefined ? {} : { values }), ...extra }]));
  assert.deepEqual(await one(undefined), ["#0:d0:claim-value-missing", "#0:d1:claim-value-missing"]);
  assert.deepEqual(await one({}), ["#0:d0:claim-value-missing", "#0:d1:claim-value-missing"]);
  assert.deepEqual(await one({ d1: "9:27 AM" }), ["#0:d0:claim-value-missing"]);
  for (const bad of [[], null, "59", 5, true]) {
    assert.deepEqual(await one(bad), ["#0:values:claim-value-malformed"], JSON.stringify(bad));
  }
  for (const v of ["$59", "59 US dollars", "about 59", "-59", 59, null, {}, ["59"], "", " ", "59.", "5 9", "1.2k"]) {
    assert.deepEqual(await one({ d0: v, d1: "9:27 AM" }), ["#0:d0:claim-value-malformed"], JSON.stringify(v));
  }
  for (const v of ["about 9:27", "9:27 am", "9:27AM", 927, null, "9:27 AM and 11:07 AM", "9:27 American", "24:00"]) {
    assert.deepEqual(await one({ d0: "59", d1: v }), ["#0:d1:claim-value-malformed"], JSON.stringify(v));
  }
  for (const k of ["d2", "d3", "price", "D0", "d00", "d-1", "d1 ", "__proto__"]) {
    const values = JSON.parse(`{"d0":"59","d1":"9:27 AM","${k}":"1"}`);
    assert.deepEqual(await one(values), [`#0:${k}:claim-value-unknown`], k);
  }
  // keys are reported in the object's own key order, after the binding reds
  assert.deepEqual(await one({ zz: "1", d0: "45", aa: "2", d1: "9:27 AM" }), ["#0:d0:claim-value-mismatch:45!=59", "#0:zz:claim-value-unknown", "#0:aa:claim-value-unknown"]);
});

test("values on a cited check with NO decides is red (every key unknown); without values it is green as before", async () => {
  const q = "ships in 2 weeks";
  const src = "It **ships in 2 weeks** for sure.";
  const r = await runWith(src, null, [{ claim: "2 weeks", quote: q, values: { d0: "2", x: "1" } }]);
  assert.equal(r.verdict, "red");
  assert.deepEqual(items(r), ["#0:d0:claim-value-unknown", "#0:x:claim-value-unknown"]);
  assert.equal((await runWith(src, null, [{ claim: "2 weeks", quote: q }])).verdict, "green");
  assert.deepEqual(items(await runWith(src, null, [{ claim: "2 weeks", quote: q, values: [] }])), ["#0:values:claim-value-malformed"]);
  assert.equal((await runWith(src, null, [{ claim: "2 weeks", quote: q, values: undefined }])).verdict, "green");
});

test("presence-only decides take claims without values; a number-free claim is never red; a missing phrase is unclipped", async () => {
  const only = [D2];
  assert.equal((await runWith(REAL, only, [{ claim: "nonstop", quote: REAL }])).verdict, "green");
  const gone = 'link "One stop flight with American. Leaves at 9:27 AM"';
  const r = await runWith(gone, only, [{ claim: "nonstop", quote: gone }]);
  assert.deepEqual(items(r), ["#0:d0:phrase-missing:Nonstop flight"]);
  // a values key against a presence decide's index is unknown
  assert.deepEqual(items(await runWith(REAL, only, [{ claim: "nonstop", quote: REAL, values: { d0: "1" } }])), ["#0:d0:claim-value-unknown"]);
  // a 1000-character signed phrase rides unclipped
  const long = "p".repeat(1000);
  const r2 = await runWith(REAL, [{ phrases: [long] }], [{ claim: "x", quote: REAL }]);
  assert.equal(items(r2)[0], `#0:d0:phrase-missing:${long}`);
});

test("role swap is impossible: values are keyed by decide, not by number", async () => {
  const arrive = { valueKind: "time", op: "lte", value: "12:00", anchor: "arrives at San Francisco International Airport at " };
  const dec = [D0, D1, arrive];
  assert.equal((await runWith(REAL, dec, [claimOf(REAL, { d0: "59", d1: "9:27 AM", d2: "11:07 AM" }, "x")])).verdict, "green");
  const swapped = await runWith(REAL, dec, [claimOf(REAL, { d0: "59", d1: "11:07 AM", d2: "9:27 AM" }, "x")]);
  assert.deepEqual(items(swapped), ["#0:d1:claim-value-mismatch:11:07!=09:27", "#0:d2:claim-value-mismatch:09:27!=11:07"]);
  // a price decide and a duration decide that both read 40 cannot be confused
  const q = 'link "From 40 US dollars. Total duration 40 min."';
  const two = [{ valueKind: "money", unit: "US dollars", op: "lt", value: 99, anchor: "From " }, { valueKind: "number", op: "lt", value: 99, anchor: "Total duration " }];
  assert.equal((await runWith(q, two, [claimOf(q, { d0: "40", d1: "40" }, "x")])).verdict, "green");
  assert.deepEqual(items(await runWith(q, two, [claimOf(q, { d0: "40" }, "x")])), ["#0:d1:claim-value-missing"]);
});

test("quote first: a paraphrased quote is red quote-not-found ONLY (no decide, no binding item); other quote reds keep today's items", async () => {
  const para = REAL.replace("Nonstop flight", "Direct flight");
  const r = await runWith(REAL, E4, [{ claim: "x", quote: para }]); // no values either: nothing downstream may run
  assert.deepEqual(items(r), ["#0:quote-not-found"]);
  assert.deepEqual(items(await runWith(REAL, E4, [{ claim: "x", quote: "   " }])), ["#0:empty-quote"]);
  assert.deepEqual(items(await runWith(REAL, E4, [{ claim: "x" }, { quote: REAL }, null, "s"])), ["#0:malformed", "#1:malformed", "#2:malformed", "#3:malformed"]);
  // a source over the 5 MiB cap
  const huge = "a".repeat(5 * 1024 * 1024 + 1);
  assert.deepEqual(items(await runWith(huge, E4, [{ claim: "x", quote: "aaa" }])), ["#0:source-too-large"]);
});

test("quote-too-long: 4001 normalized chars with decides signed; 4000 AT proceeds; NO decides = not bounded", async () => {
  const mk = (n) => "Total " + "x".repeat(n - 6);
  const dec = [D2];
  const src4001 = mk(4001);
  const over = await runWith(src4001, dec, [{ claim: "x", quote: src4001 }]);
  assert.deepEqual(items(over), ["#0:quote-too-long"], "the claim ends: no decide item for the unproven-length quote");
  const src4000 = mk(4000);
  const at = await runWith(src4000, dec, [{ claim: "x", quote: src4000 }]);
  assert.deepEqual(items(at), ["#0:d0:phrase-missing:Nonstop flight"], "AT 4000 proceeds to the decides");
  assert.equal((await runWith(src4001, null, [{ claim: "x", quote: src4001 }])).verdict, "green", "plain cited keeps no quote bound");
});

test("stray number in the claim text is red via numbersInQuote, alongside the binding reds; 59.00 vs 59 is the documented false red", async () => {
  const r = await runWith(REAL, E4, [claimOf(REAL, { d0: "59", d1: "9:27 AM" }, "United $45")]);
  assert.deepEqual(items(r), ["#0:numbers:45"], "the typed value is right; the free text is wrong");
  const both = await runWith(REAL, E4, [claimOf(REAL, { d0: "59", d1: "7:00 AM" }, "United $45")]);
  assert.deepEqual(items(both), ["#0:d1:claim-value-mismatch:07:00!=09:27", "#0:numbers:45"], "all reds of one claim are listed together");
  const dot = await runWith(REAL, E4, [claimOf(REAL, { d0: "59", d1: "9:27 AM" }, "59.00")]);
  assert.deepEqual(items(dot), ["#0:numbers:59.00"]);
});

test("ruling #52: claim TEXT must spell numbers as the quote does; only values are canonicalized", async () => {
  const ok = await runWith(REAL, E4, [claimOf(REAL, { d0: "59", d1: "09:27" }, "American nonstop, departs 9:27 AM, $59")]);
  assert.equal(ok.verdict, "green", "text spelled like the quote, value spelled differently: green");
  const bad = await runWith(REAL, E4, [claimOf(REAL, { d0: "59", d1: "9:27 AM" }, "American nonstop, departs 09:27, $59")]);
  assert.equal(bad.verdict, "red");
  assert.deepEqual(items(bad), ["#0:numbers:09"], "values canonicalize, the claim text does not: 09 is not in the quote");
});

test("mismatch is evaluated when the decide is red on its op but extracted a value (the worker sees both)", async () => {
  const fixed = [{ ...D0, value: 50 }, D1, D2]; // 59 is not < 50: value-over
  const r = await runWith(REAL, fixed, [claimOf(REAL, { d0: "58", d1: "9:27 AM" }, "x")]);
  assert.deepEqual(items(r), ["#0:d0:value-over", "#0:d0:claim-value-mismatch:58!=59"]);
  const same = await runWith(REAL, fixed, [claimOf(REAL, { d0: "59", d1: "9:27 AM" }, "x")]);
  assert.deepEqual(items(same), ["#0:d0:value-over"], "the binding itself is green where the claim equals the extracted value");
  // extraction failed: no mismatch, the decide's own red says so
  const none = 'link "Nonstop flight. Leaves Los Angeles International Airport at 9:27 AM"';
  const noExt = await runWith(none, E4, [claimOf(none, { d0: "59", d1: "9:27 AM" }, "x")]);
  assert.deepEqual(items(noExt), ["#0:d0:anchor-missing"]);
});

test("decide reds carry d<j> and the kind; all reds over all claims in claim order; measured counts claims with a red", async () => {
  const late = REAL.replace("9:27 AM", "10:15 PM");
  const r = await runWith(REAL + "\n" + late, E4, [claimOf(REAL, TRUE_VALUES), claimOf(late, { d0: "59", d1: "10:15 PM" }, "x"), claimOf(late, { d0: "59", d1: "9:27 AM" }, "x")]);
  assert.deepEqual(items(r), ["#1:d1:value-over", "#2:d1:value-over", "#2:d1:claim-value-mismatch:09:27!=22:15"]);
  assert.equal(r.gaps[0].measured, 2);
  assert.equal(r.gaps[0].limit, 3);
  assert.equal(r.gaps[0].itemsTotal, undefined);
});

test("items are bounded to 20 with itemsTotal when cut; renderGaps renders the default JSON row", async () => {
  const claims = Array.from({ length: 30 }, () => claimOf(REAL, undefined, "x"));
  const r = await runWith(REAL, E4, claims);
  assert.equal(r.gaps[0].items.length, 20);
  assert.equal(r.gaps[0].itemsTotal, 60);
  assert.equal(r.gaps[0].measured, 30);
  const text = renderGaps(r.gaps);
  assert.ok(text.includes("claim-value-missing"), text);
});

test("output-derived parts are clipped to 120; signed parts are not", async () => {
  const k = "k".repeat(500);
  const values = JSON.parse(`{"d0":"59","d1":"9:27 AM","${k}":"1"}`);
  const r = await runWith(REAL, E4, [claimOf(REAL, values, "x")]);
  assert.deepEqual(items(r), [`#0:${"k".repeat(120)}:claim-value-unknown`]);
});

test("the whole page: 44 real-shaped lines as quotes with true values = 39 green, 5 red (the after-21:00 departures), binding green on all 44", async () => {
  const lines = [];
  for (let n = 0; n < 44; n++) {
    const late = n >= 39;
    const hh = late ? 21 + (n - 39) % 3 : 6 + (n % 14); // 06..19 or 21:xx..23:xx
    const mm = (n * 7) % 60;
    const m = String(mm).padStart(2, "0");
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    const time = `${h12}:${m} ${hh < 12 ? "AM" : "PM"}`;
    const price = 40 + n * 3;
    lines.push({ time, price, text: `link "From ${price} US dollars. Nonstop flight with Carrier${n}. Leaves Los Angeles International Airport at ${time} on Thursday, November 12 and arrives at San Francisco International Airport at 11:07 PM on Thursday, November 12. Select flight"`, late: hh > 21 || (hh === 21 && mm > 0) });
  }
  const page = lines.map((l) => l.text).join("\n");
  const claims = lines.map((l) => claimOf(l.text, { d0: String(l.price), d1: l.time }, "x"));
  const r = await runWith(page, E4, claims);
  const reds = lines.map((l, i) => (l.late ? i : -1)).filter((i) => i >= 0);
  assert.ok(reds.length >= 3 && reds.length < 44);
  assert.deepEqual(r.gaps[0].items, reds.map((i) => `#${i}:d1:value-over`), "only the op reds; no binding item on any of the 44");
  assert.equal(r.gaps[0].measured, reds.length);
  assert.equal(reds.length + lines.filter((l) => !l.late).length, 44);
});

// --- verdict ------------------------------------------------------------------------------------

test("verdict: a source sha mismatch / missing source is still stopped; the work cap still applies", async () => {
  const rub = mkRubric(REAL, E4);
  const claims = [claimOf(REAL, TRUE_VALUES)];
  const miss = await checkStep(rub, "cp", { claims }, { inputs: {} });
  assert.equal(miss.verdict, "stopped");
  assert.equal(miss.fault.kind, "missing-measurement");
  const alt = await checkStep(rub, "cp", { claims }, { inputs: { offers: REAL + "!" } });
  assert.equal(alt.verdict, "stopped");
  // work cap: distinct quotes x source length over 128 MiB is red too-many (unchanged)
  const src = "a".repeat(1024 * 1024) + "b";
  const limit = Math.floor((128 * 1024 * 1024) / src.length);
  const many = Array.from({ length: limit + 1 }, (_, i) => ({ claim: "x", quote: "a".repeat(i + 1) }));
  const over = await runWith(src, [{ phrases: ["zz"] }], many);
  assert.equal(over.gaps[0].kind, "too-many");
  assert.equal(over.gaps[0].limit, limit);
});

test("gate: a passing cited-with-decides checkpoint advances with no requiresHuman; a red lands in drainGaps()", async (t) => {
  const dir = await makeTmpDir();
  t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const spec = {
    schema: 1, goal: "g", inputs: [{ name: "offers", sha256: sha(REAL) }],
    checkpoints: { pick: { gating: true, checks: [{ id: "c", rule: "cited", claims: "claims", source: "offers", decides: E4 }] } },
  };
  const gate = new Gate({ audit: { path: auditPath }, rubric: { spec, sha256: rubricSha(spec), advanceOn: ["done"] }, runId });
  await gate.init();
  const mkOpts = (out) => ({ inputs: { offers: REAL }, outputBytes: JSON.stringify(out) });
  const badOut = { claims: [claimOf(REAL, { d0: "59", d1: "7:00 AM" })] };
  const bad = await gate.checkStep("pick", badOut, mkOpts(badOut));
  assert.equal(bad.verdict, "red");
  const gaps = gate.drainGaps();
  assert.deepEqual(gaps[0].items, ["#0:d1:claim-value-mismatch:07:00!=09:27"]);
  assert.equal((await gate.check({ type: "done", checkpoint: "pick", outputSha: bad.outputSha })).rule, "rubric.red");
  const goodOut = { claims: [claimOf(REAL, TRUE_VALUES)] };
  const good = await gate.checkStep("pick", goodOut, mkOpts(goodOut));
  assert.equal(good.verdict, "green");
  assert.equal(good.softGreen, undefined);
  const adv = await gate.check({ type: "done", checkpoint: "pick", outputSha: good.outputSha });
  assert.equal(adv.outcome, "allow", JSON.stringify(adv));
});

// --- hostile claims -------------------------------------------------------------------------------

test("hostile claim values: a throwing getter / Proxy / exotic values never throw out of checkStep", async () => {
  const getter = { claim: "x", quote: REAL };
  Object.defineProperty(getter, "values", { enumerable: true, get() { throw new Error("boom"); } });
  const r1 = await runWith(REAL, E4, [getter]);
  assert.deepEqual(items(r1), ["#0:values:claim-value-malformed"]);
  const prox = new Proxy({}, { ownKeys() { throw new Error("boom"); }, has() { throw new Error("boom"); }, getOwnPropertyDescriptor() { throw new Error("boom"); } });
  const r2 = await runWith(REAL, E4, [{ claim: "x", quote: REAL, values: prox }]);
  assert.equal(r2.verdict, "red");
  assert.notEqual(r2.verdict, "stopped");
  const inner = { claim: "x", quote: REAL, values: {} };
  Object.defineProperty(inner.values, "d0", { enumerable: true, get() { throw new Error("boom"); } });
  const r3 = await runWith(REAL, E4, [inner]);
  assert.ok(items(r3).includes("#0:d0:claim-value-malformed"));
});

// --- unchanged behaviour with no decides -----------------------------------------------------------

test("no decides: items, measured, limit, no-claims, too-many are byte-for-byte today's", async () => {
  const src = "It ships in 2 weeks and costs 5 dollars.";
  const r = await runWith(src, null, [
    { claim: "ships in 3 weeks", quote: "ships in 2 weeks" },
    { claim: "x", quote: "not here" },
    { claim: "x", quote: " " },
    { claim: "x" },
    { claim: "ships", quote: "ships in 2 weeks" },
  ]);
  assert.deepEqual(r.gaps[0], {
    key: "cp:c", checkpoint: "cp", check: "cited", id: "c", field: "claims", kind: "unsupported",
    measured: 4, limit: 5, items: ["#0:numbers:3", "#1:quote-not-found", "#2:empty-quote", "#3:malformed"],
  });
  assert.equal((await runWith(src, null, [])).gaps[0].kind, "no-claims");
});

// --- createRubric: validation, sha, vocabulary -------------------------------------------------------

const refuse = (decides, re, source = REAL) => assert.throws(() => mkRubric(source, decides), re, JSON.stringify(decides).slice(0, 120));

test("createRubric refuses bad decides, naming the path", () => {
  const P = /spec\.checkpoints\.cp\.checks\[0\]\.decides/;
  refuse([], P);
  refuse({}, P);
  refuse("x", P);
  refuse(Array.from({ length: 11 }, () => D2), /at most 10/);
  assert.doesNotThrow(() => mkRubric(REAL, Array.from({ length: 10 }, () => D2)));
  refuse([null], /decides\[0\] must be an object/);
  refuse([[]], /decides\[0\] must be an object/);
  refuse([{}], /decides\[0\]\.valueKind is required/);
  refuse([{ valueKind: "number", op: "lt", value: 1, phrases: ["a"] }], /decides\[0\]\.valueKind is not allowed on a presence decide/);
  refuse([{ phrases: ["a"], anchor: "x" }], /decides\[0\]\.anchor is not allowed on a presence decide/);
  refuse([{ phrases: [] }], /decides\[0\]\.phrases/);
  refuse([{ phrases: [" "] }], /decides\[0\]\.phrases\[0\]/);
  refuse([{ phrases: ["p".repeat(1001)] }], /decides\[0\]\.phrases\[0\]/);
  refuse([D2, { valueKind: "number", op: "lt" }], /decides\[1\]\.value is required/);
  refuse([{ valueKind: "number", op: "lt", value: 1, extra: 1 }], /decides\[0\]\.extra is not a recognised decide field/);
  refuse([{ valueKind: "color", op: "lt", value: 1 }], /decides\[0\]\.valueKind/);
  refuse([{ valueKind: "number", op: "eq", value: 1 }], /decides\[0\]\.op/);
  refuse([{ valueKind: "number", op: "between", value: 1, lo: 1, hi: 2 }], /decides\[0\]\.value is refused with op between/);
  refuse([{ valueKind: "number", op: "between", lo: 1 }], /decides\[0\]\.hi is required with op between/);
  refuse([{ valueKind: "number", op: "between", hi: 1 }], /decides\[0\]\.lo is required with op between/);
  refuse([{ valueKind: "number", op: "lt", value: 1, lo: 0 }], /decides\[0\]\.lo is refused with op lt/);
  refuse([{ valueKind: "number", op: "between", lo: 5, hi: 1 }], /decides\[0\]\.lo must be <= hi/);
  refuse([{ valueKind: "time", op: "between", lo: "22:00", hi: "02:00" }], /decides\[0\]\.lo must be <= hi/);
  assert.doesNotThrow(() => mkRubric(REAL, [{ valueKind: "time", op: "between", lo: "09:00 PM", hi: "22:00" }]));
  refuse([{ valueKind: "number", op: "lt", value: "5" }], /decides\[0\]\.value is not a valid number bound/);
  refuse([{ valueKind: "number", op: "lt", value: 1e21 }], /decides\[0\]\.value is not a valid number bound/);
  refuse([{ valueKind: "number", op: "lt", value: NaN }], /./);
  refuse([{ valueKind: "date", op: "gte", value: "2026-02-30" }], /decides\[0\]\.value is not a valid date bound/);
  refuse([{ valueKind: "date", op: "gte", value: 5 }], /decides\[0\]\.value is not a valid date bound/);
  refuse([{ valueKind: "time", op: "lt", value: "9:27am" }], /decides\[0\]\.value is not a valid time bound/);
  refuse([{ valueKind: "money", op: "lt", value: 5 }], /decides\[0\]\.currency money needs exactly one of currency or unit/);
  refuse([{ valueKind: "money", op: "lt", value: 5, currency: "$", unit: "US dollars" }], /needs exactly one of currency or unit/);
  refuse([{ valueKind: "money", op: "lt", value: 5, currency: "USD" }], /decides\[0\]\.currency/);
  refuse([{ valueKind: "money", op: "lt", value: 5, unit: " " }], /decides\[0\]\.unit/);
  refuse([{ valueKind: "money", op: "lt", value: 5, unit: "u".repeat(101) }], /decides\[0\]\.unit must be at most 100/);
  assert.doesNotThrow(() => mkRubric(REAL, [{ valueKind: "money", op: "lt", value: 5, unit: "u".repeat(100) }]));
  refuse([{ valueKind: "number", op: "lt", value: 5, unit: "x" }], /decides\[0\]\.unit is refused unless valueKind is money/);
  refuse([{ valueKind: "date", op: "gte", value: "2026-01-01", currency: "$" }], /decides\[0\]\.currency is refused unless valueKind is money/);
  refuse([{ valueKind: "number", op: "lt", value: 5, anchor: " " }], /decides\[0\]\.anchor/);
  refuse([{ valueKind: "number", op: "lt", value: 5, anchor: "a".repeat(1001) }], /decides\[0\]\.anchor/);
  // the judged rule is still refused as an unknown check type
  assert.throws(() => createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "j", rule: "judged", kind: "locate" }] } } }), /not a known check type/);
  // decides are cited-only
  assert.throws(() => createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "m", rule: "mustCarry", field: "text", phrases: ["a"], decides: [D2] }] } } }), /decides is not a recognised field/);
});

test("a signed spec with decides verifies; the sha changes with decides, a decide field, or the decide order", () => {
  const spec = (decides) => ({ schema: 1, goal: "g", inputs: [{ name: "offers", sha256: sha(REAL) }], checkpoints: { cp: { gating: true, checks: [{ id: "c", rule: "cited", claims: "claims", source: "offers", ...(decides ? { decides } : {}) }] } } });
  const base = rubricSha(spec(E4));
  assert.notEqual(base, rubricSha(spec(null)));
  assert.notEqual(base, rubricSha(spec([D1, D0, D2])), "order");
  assert.notEqual(base, rubricSha(spec([{ ...D0, value: 401 }, D1, D2])), "a bound");
  assert.notEqual(base, rubricSha(spec([{ ...D0, anchor: "From" }, D1, D2])), "an anchor");
  assert.notEqual(base, rubricSha(spec([D0, D1, { phrases: ["Nonstop flights"] }])), "a phrase");
  assert.equal(base, rubricSha(spec(E4)));
  assert.doesNotThrow(() => createRubric(spec(E4), { sha256: base }));
  assert.throws(() => createRubric(spec([D1, D0, D2]), { sha256: base }), /tampered|does not match/);
});

test("rubricVocabulary lists decides on cited with its shapes and conditions; the generated description matches", () => {
  const f = rubricVocabulary.rules.cited.fields;
  assert.deepEqual(Object.keys(f), ["claims", "source", "decides", "text"]);
  assert.equal(f.decides.type, "decide-list");
  assert.equal(f.decides.required, false);
  assert.equal(f.decides.maxItems, 10);
  assert.deepEqual(f.decides.shapes.value.fields.valueKind.enum, ["number", "money", "date", "time", "text"]);
  assert.equal(f.decides.shapes.value.fields.op.required, false, "op is optional (a bind-only decide)");
  assert.deepEqual(f.decides.shapes.value.fields.op.enum, ["lt", "lte", "gt", "gte", "between"]);
  assert.deepEqual(f.decides.shapes.value.fields.currency.enum, ["$", "€", "£"]);
  assert.equal(f.decides.shapes.value.fields.unit.maxLength, 100);
  assert.equal(f.decides.shapes.presence.fields.phrases.type, "string-list");
  assert.ok(f.decides.shapes.value.conditions.some((c) => c.includes("exactly one of currency or unit")));
  const d = rubricVocabulary.rules.cited.description;
  assert.equal(d, describeRule("cited"));
  for (const w of ["decides?", "valueKind", "op?:", "lo?", "hi?", "currency?", "unit?", "anchor?", "phrases", "between needs lo and hi", "exactly one of currency or unit"]) assert.ok(d.includes(w), w);
  // the vocabulary is the validator's: every enum value it lists is accepted, nothing else is
  assert.ok(Object.isFrozen(f.decides) && Object.isFrozen(f.decides.shapes.value.fields.op));
});

test("rubricVocabulary: every EXISTING rule, the common/bounds/checkpoint blocks and the rest of cited are byte-identical to before", () => {
  const h = (x) => sha(JSON.stringify(x));
  const { cited, ...others } = rubricVocabulary.rules;
  assert.equal(h(others), "1643c3f202e7a6a7cfa06be705536e96194bdd9c2ddb832063ae41b77400909a");
  const { decides: _d, ...citedFields } = cited.fields;
  assert.equal(h(cited.fields.claims), h({ type: "name", required: true, nonBlank: true, maxLength: 128 }));
  assert.deepEqual(citedFields, {
    claims: { type: "name", required: true, nonBlank: true, maxLength: 128 },
    source: { type: "name", required: true, nonBlank: true, maxLength: 128, ref: "input" },
    text: { type: "explanation", required: false },
  });
  const { schema, common, bounds: allBounds, checkpoint, foundational } = rubricVocabulary;
  // quoteMaxChars is the one additive bounds entry (hamr-approved); every earlier bound stays byte-identical
  const { quoteMaxChars, ...bounds } = allBounds;
  assert.equal(quoteMaxChars, 4000, "bounds.quoteMaxChars is the 4000-char quote cap (red quote-too-long with decides: see the quote-too-long test)");
  assert.equal(h({ schema, common, bounds, checkpoint, foundational }), "cd655eb327c6180d593843ca2f309cf950243e66ad0b62c66b2fbd0466576fca");
  assert.ok(cited.description.startsWith("cited({ id, claims: non-blank string, max 128 chars, source: non-blank string, max 128 chars, decides?: "));
  assert.ok(cited.description.endsWith(", text?: string (the signer's explanation; never decides) })"));
  assert.deepEqual(Object.keys(rubricVocabulary.rules), "nonEmpty,maxWords,minWords,maxLines,sections,sectionOrder,sectionWords,allowedKeys,mustCarry,blockLines,in,notIn,atMost,max,min,cited,complete,commandExit,notWorse,patternAbsent,filesChanged".split(","));
});

// --- parseClaimValue (the pure parser) ---------------------------------------------------------------

test("parseClaimValue: one token of the kind, nothing else; canonical", () => {
  const ok = (k, raw, canon) => assert.deepEqual(parseClaimValue(k, raw), { ok: true, canon }, `${k} ${JSON.stringify(raw)}`);
  const bad = (k, raw) => assert.deepEqual(parseClaimValue(k, raw), { ok: false }, `${k} ${JSON.stringify(raw)}`);
  ok("money", "59", "59");
  ok("money", "59.00", "59");
  ok("money", "1,200", "1200");
  ok("money", "0.5", "0.5");
  ok("money", " 59 ", "59");
  ok("number", "-5", "-5");
  ok("number", "-0", "0");
  ok("number", "0.5", "0.5");
  ok("date", "2026-10-12", "2026-10-12");
  ok("time", "9:27 AM", 567);
  ok("time", "09:27", 567);
  ok("time", "21:27", 1287);
  ok("time", "9:27 PM", 1287);
  ok("time", "12:05 AM", 5);
  for (const raw of ["-5", "$59", "59 US dollars", "59 ", "5 9", "1,20", ".5", "59.", "1e3", "", "  ", 59, null, undefined, {}, [], "(5)", "−5", "59,"]) {
    if (raw === "59 ") continue; // trailing whitespace is trimmed by normalization: that one is fine (covered above)
    bad("money", raw);
  }
  for (const raw of ["5-", "--5", "- 5", "5 US dollars", "1.2.3", "12,34", "−5", 5]) bad("number", raw);
  for (const raw of ["2026-13-45", "2026-02-30", "26-10-12", "2026-10-12T08:00", "2026-10-12 2026-10-13", "Oct 12", "12026-10-12"]) bad("date", raw);
  for (const raw of ["9:27 am", "9:27AM", "9:27 a.m.", "00:30 AM", "13:05 PM", "24:00", "8:7", "9:27 American", "9:27 AMX", "about 9:27", "9:27 10:27", "9", 927]) bad("time", raw);
  bad("bogus", "1");
});

// --- bind-only decides, membership and the `text` value kind (docs/product/rubric-prd.md §4.6, RULED #56-#59) -----------------

// A one-claim run over `quote` (the source IS the quote, so the quote is always found verbatim).
const bind = (quote, decide, values, claim = "c") => runWith(quote, [decide], [{ claim, quote, ...(values === undefined ? {} : { values }) }]);
const red = async (quote, decide, values, ...want) => {
  const r = await bind(quote, decide, values);
  assert.equal(r.verdict, "red", `${JSON.stringify(values)} on ${quote}`);
  assert.deepEqual(items(r), want, JSON.stringify(values));
};
const green = async (quote, decide, values) => {
  const r = await bind(quote, decide, values);
  assert.equal(r.verdict, "green", `${JSON.stringify(values)} on ${quote}: ${JSON.stringify(r.gaps)}`);
};
const refusePath = (decides, re) => assert.throws(() => mkRubric(REAL, decides), re, JSON.stringify(decides));

const ALASKA = "Alaska 8:15 AM $389 Nonstop";
const DOLLAR = { valueKind: "money", currency: "$" };
const TIME_ROW = "8:15 AM – 9:47 AM";
const TIME = { valueKind: "time" };
const TXT = { valueKind: "text" };
const FLIGHT = "EgyptAir MS791 USD 420";

test("createRubric: a bind-only decide refuses value / lo / hi, naming the path (op WITH value is still fine)", () => {
  for (const k of ["value", "lo", "hi"]) {
    refusePath([{ ...DOLLAR, [k]: 5 }], new RegExp(`checkpoints\\.cp\\.checks\\[0\\]\\.decides\\[0\\]\\.${k} is refused on a bind-only decide \\(sign an op, or drop the bound\\)`));
  }
  refusePath([{ valueKind: "time", lo: "06:00", hi: "09:00" }], /decides\[0\]\.lo is refused on a bind-only decide/);
  assert.doesNotThrow(() => mkRubric(REAL, [{ ...DOLLAR, op: "lt", value: 400 }]));
  for (const d of [{ valueKind: "number" }, DOLLAR, { valueKind: "money", unit: "US dollars" }, { valueKind: "date" }, TIME, { ...TIME, anchor: "Leaves at " }]) {
    assert.doesNotThrow(() => mkRubric(REAL, [d]), JSON.stringify(d));
  }
  refusePath([{ valueKind: "money" }], /decides\[0\]\.currency money needs exactly one of currency or unit/);
  refusePath([{ valueKind: "money", currency: "$", unit: "US dollars" }], /needs exactly one of currency or unit/);
  refusePath([{ valueKind: "number", anchor: " " }], /decides\[0\]\.anchor/);
  refusePath([{ valueKind: "number", currency: "$" }], /decides\[0\]\.currency is refused unless valueKind is money/);
});

test("createRubric: a text decide refuses op, value, lo, hi, currency and unit (each named); anchor is fine; bad anchor refused", () => {
  const bad = { op: "lt", value: 5, lo: 1, hi: 2, currency: "$", unit: "US dollars" };
  for (const [k, v] of Object.entries(bad)) refusePath([{ ...TXT, [k]: v }], new RegExp(`decides\\[0\\]\\.${k} is refused on a text decide`));
  refusePath([{ valueKind: "text", op: "lt" }], /decides\[0\]\.op is refused on a text decide/);
  assert.doesNotThrow(() => mkRubric(REAL, [TXT]));
  assert.doesNotThrow(() => mkRubric(REAL, [{ ...TXT, anchor: "Departure time:" }]));
  refusePath([{ ...TXT, anchor: "  " }], /decides\[0\]\.anchor/);
  refusePath([{ ...TXT, anchor: "a".repeat(1001) }], /decides\[0\]\.anchor/);
  refusePath([{ ...TXT, extra: 1 }], /decides\[0\]\.extra is not a recognised decide field/);
  refusePath([{ valueKind: "color" }], /decides\[0\]\.valueKind/);
});

test("`judged` is still not a check type: op-less and text decides are cited-only (refused on any other rule)", () => {
  const judged = (decides) => createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "j", rule: "judged", kind: "locate", ask: "q", sources: ["a"], decides }] } } });
  assert.throws(() => judged([DOLLAR]), /not a known check type: "judged"/);
  assert.throws(() => judged([TXT]), /not a known check type: "judged"/);
  assert.throws(() => createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "m", rule: "mustCarry", field: "text", phrases: ["a"], decides: [TXT] }] } } }), /decides is not a recognised field/);
});

test("rubricSha changes when op is dropped or added, and when valueKind becomes text", () => {
  const spec = (d) => ({ schema: 1, goal: "g", inputs: [{ name: "offers", sha256: sha(REAL) }], checkpoints: { cp: { gating: true, checks: [{ id: "c", rule: "cited", claims: "claims", source: "offers", decides: [d] }] } } });
  const withOp = rubricSha(spec({ ...DOLLAR, op: "lt", value: 400 }));
  const opless = rubricSha(spec(DOLLAR));
  assert.notEqual(withOp, opless);
  assert.notEqual(opless, rubricSha(spec({ valueKind: "text" })));
  assert.notEqual(rubricSha(spec(TXT)), rubricSha(spec({ ...TXT, anchor: "a" })));
});

test("membership (#56): bareloop's price row; the claim must equal the quote's value", async () => {
  await green(ALASKA, DOLLAR, { d0: "389" });
  await red(ALASKA, DOLLAR, { d0: "199" }, "#0:d0:claim-value-mismatch:199!=389");
  await red(ALASKA, DOLLAR, { d0: "$389" }, "#0:d0:claim-value-malformed");
  await red(ALASKA, DOLLAR, { d0: "389 dollars" }, "#0:d0:claim-value-malformed");
  await red(ALASKA, DOLLAR, { d0: 389 }, "#0:d0:claim-value-malformed");
  await red(ALASKA, DOLLAR, undefined, "#0:d0:claim-value-missing");
});

test("membership: several values, any one passes (the documented limit); value-many NEVER appears", async () => {
  const Q = "Total: $389 (was $420)";
  await green(Q, DOLLAR, { d0: "389" });
  await green(Q, DOLLAR, { d0: "420" });
  await red(Q, DOLLAR, { d0: "400" }, "#0:d0:claim-value-mismatch:400!=389,420");
  // a repeated amount is no longer value-many
  await green("Fare $59. Book: $59", DOLLAR, { d0: "59" });
});

test("membership: the two-time row", async () => {
  await green(TIME_ROW, TIME, { d0: "9:47 AM" });
  await green(TIME_ROW, TIME, { d0: "09:47" });
  await green(TIME_ROW, TIME, { d0: "8:15 AM" });
  await red(TIME_ROW, TIME, { d0: "10:00" }, "#0:d0:claim-value-mismatch:10:00!=08:15,09:47");
  await red(TIME_ROW, TIME, { d0: "9:47 PM" }, "#0:d0:claim-value-mismatch:21:47!=08:15,09:47");
});

test("membership: zero values = value-none (no mismatch item); a malformed token = value-malformed; number kind on 0.41.0 is value-malformed", async () => {
  await red("Alaska 8:15 AM Nonstop", DOLLAR, { d0: "389" }, "#0:d0:value-none");
  await red("Fare $5USD", DOLLAR, { d0: "5" }, "#0:d0:value-malformed");
  await red("Release 0.41.0 notes", { valueKind: "number" }, { d0: "0.41" }, "#0:d0:value-malformed");
  // one malformed token among good ones is never counted away
  await red("Fare $59 and $5USD", DOLLAR, { d0: "59" }, "#0:d0:value-malformed");
});

test("membership sees ALL values: over 20 the item lists 20 and ends ,...(21 in all); the 21st value is still green", async () => {
  const Q = Array.from({ length: 21 }, (_, k) => `$${100 + k}`).join(" ");
  const shown = Array.from({ length: 20 }, (_, k) => 100 + k).join(",");
  await red(Q, DOLLAR, { d0: "999" }, `#0:d0:claim-value-mismatch:999!=${shown},...(21 in all)`);
  await green(Q, DOLLAR, { d0: "120" }); // the 21st, not displayed
  // exactly 20 values: no tail
  const Q20 = Array.from({ length: 20 }, (_, k) => `$${100 + k}`).join(" ");
  await red(Q20, DOLLAR, { d0: "999" }, `#0:d0:claim-value-mismatch:999!=${shown}`);
});

test("bind-only ANCHORED keeps the one-value read: an anchor narrows the membership", async () => {
  const Q = "Departure time: 8:15 AM. Arrival time: 9:47 AM.";
  const dep = { valueKind: "time", anchor: "Departure time:" };
  await green(Q, dep, { d0: "8:15 AM" });
  await red(Q, dep, { d0: "9:47 AM" }, "#0:d0:claim-value-mismatch:09:47!=08:15");
  await green(Q, TIME, { d0: "9:47 AM" }); // unanchored membership would have passed it
  await red(Q, { valueKind: "time", anchor: "Boarding:" }, { d0: "8:15 AM" }, "#0:d0:anchor-missing");
  await red(`${Q} Departure time: 10:00`, dep, { d0: "8:15 AM" }, "#0:d0:anchor-ambiguous");
  await red("Departure time: soon", dep, { d0: "8:15 AM" }, "#0:d0:value-none");
});

test("condition decides are unchanged (#57): two values under an op is still value-many, byte for byte; membership never rescues it", async () => {
  const lt = { valueKind: "time", op: "lt", value: "12:00" };
  await red(TIME_ROW, lt, { d0: "9:47 AM" }, "#0:d0:value-many");
  const r = await bind(TIME_ROW, lt, { d0: "9:47 AM" });
  assert.deepEqual(r.gaps[0].items, ["#0:d0:value-many"]);
  await green("Departs 8:15 AM", lt, { d0: "8:15 AM" });
  await green(TIME_ROW, { ...lt, anchor: "8:15 AM –" }, { d0: "9:47 AM" });
  await red("Fare $5 or $6", { ...DOLLAR, op: "lt", value: 10 }, { d0: "5" }, "#0:d0:value-many");
});

test("text, unanchored (#58): whole-token presence over a flight number", async () => {
  for (const v of ["MS791", "ms791", " MS791 ", "EgyptAir MS791", "MS791 USD", "egyptair   ms791"]) await green(FLIGHT, TXT, { d0: v });
  await red(FLIGHT, TXT, { d0: "MS79" }, "#0:d0:claim-value-absent:MS79");
  await red(FLIGHT, TXT, { d0: "S791" }, "#0:d0:claim-value-absent:S791");
  await red(FLIGHT, TXT, { d0: "791" }, "#0:d0:claim-value-absent:791");
  await red(FLIGHT, TXT, { d0: "  MS79  " }, "#0:d0:claim-value-absent:MS79"); // the item shows the normalized value, original case
  await red(FLIGHT, TXT, { d0: "ms79" }, "#0:d0:claim-value-absent:ms79");
});

test("text: a version in a changelog heading, and a carrier with spaces", async () => {
  const CL = "## [0.41.0] - 2026-10-12";
  await green(CL, TXT, { d0: "0.41.0" });
  await green(CL, TXT, { d0: "2026-10-12" });
  await green("Alaska Airlines 8:15 AM", TXT, { d0: "alaska   airlines" });
  await green("Alaska Airlines 8:15 AM", TXT, { d0: "ALASKA" });
  await red(ALASKA, TXT, { d0: "Delta" }, "#0:d0:claim-value-absent:Delta");
});

test("text: the whole-token boundary grid, at and over every edge", async () => {
  const at = async (quote, ok) => (ok ? green : (q, d, v) => red(q, d, v, "#0:d0:claim-value-absent:MS791"))(quote, TXT, { d0: "MS791" });
  await at("MS791 later", true); // quote start
  await at("later MS791", true); // quote end
  await at("MS791", true);
  await at("xMS791", false); // glued before
  await at("MS791x", false); // glued after
  await at("7MS791", false); // digit before
  await at("MS7917", false); // digit after
  await at("éMS791", false); // non-ASCII letter before
  await at("MS791é", false); // non-ASCII letter after
  await at("MS791́", false); // combining mark after
  await at("MS791́ MS791", true); // ... but a later whole one is enough
  await at("_MS791_", true); // _ is a boundary
  await at("(MS791)", true);
  await at("a-MS791-b", false); // digit, then - then a letter: hyphen digit glue (#62)
  await at("a-MS791 b", true);
  await at("a-MS791-", true);
  await at("xMS791 MS791", true); // an earlier glued occurrence does not hide a later whole one
  await at("MS791 MS791 MS791", true);
  await at("𝐀MS791", false); // supplementary-plane letter before (a surrogate pair)
  await at("MS791𝐀", false);
  await at("😀MS791😀", true); // an emoji is no letter
});

test("text: the claim value is a non-empty string of at most 200 characters AFTER normalization", async () => {
  const v200 = "a".repeat(200);
  await green(`x ${v200} y`, TXT, { d0: v200 });
  await red(`x ${v200}a y`, TXT, { d0: "a".repeat(201) }, "#0:d0:claim-value-malformed");
  await green(`x ${v200} y`, TXT, { d0: `   ${v200}   ` }); // trimmed first
  await green("a b", TXT, { d0: `a${" ".repeat(500)}b` }); // collapsed to 3 characters
  for (const bad of ["", "   ", 5, null, {}, [], true]) await red(FLIGHT, TXT, { d0: bad }, "#0:d0:claim-value-malformed");
  await red(FLIGHT, TXT, undefined, "#0:d0:claim-value-missing");
});

test("text: lower-case fold is toLowerCase, not full Unicode folding; ** and __ in the value fail closed", async () => {
  await red("Straße 5", TXT, { d0: "STRASSE" }, "#0:d0:claim-value-absent:STRASSE");
  await green("Straße 5", TXT, { d0: "STRAßE" });
  await green("İstanbul 5", TXT, { d0: "İSTANBUL" }); // İ lowers to two code units on both sides
  await red("bold **MS791** text", TXT, { d0: "**MS791**" }, "#0:d0:claim-value-absent:**MS791**"); // the quote's ** are dropped, the value's are not
  await green("bold **MS791** text", TXT, { d0: "MS791" });
  await red("a __b__ c", TXT, { d0: "__b__" }, "#0:d0:claim-value-absent:__b__");
});

test("text, anchored (#58): the value starts right after the anchor and ends on a boundary", async () => {
  const Q = "Departure time: 8:15 AM. Arrival time: 9:47 AM.";
  const dep = { valueKind: "text", anchor: "Departure time:" };
  await green(Q, dep, { d0: "8:15 AM" });
  await green(Q, dep, { d0: "8:15" }); // the next character is a space: a boundary
  await red(Q, dep, { d0: "8:1" }, "#0:d0:claim-value-absent:8:1"); // a prefix of a token
  await red(Q, dep, { d0: "9:47 AM" }, "#0:d0:claim-value-absent:9:47 AM"); // present in the quote, not after the anchor
  await red("Departure time: about 8:15 AM", dep, { d0: "8:15 AM" }, "#0:d0:claim-value-absent:8:15 AM");
  await green("Code:MS791 USD", { valueKind: "text", anchor: "Code:" }, { d0: "ms791" }); // right after the anchor, no space
  await green("Departure time:    8:15 AM", dep, { d0: "8:15 AM" }); // whitespace between is skipped
  await green(Q, { valueKind: "text", anchor: "Arrival time:" }, { d0: "9:47 AM." }); // the value may end in punctuation; bounded by its OUTER neighbour
  await red(`${Q} Departure time: 10:00`, dep, { d0: "8:15 AM" }, "#0:d0:anchor-ambiguous"); // no absent item
  await red(Q, { valueKind: "text", anchor: "Boarding:" }, { d0: "8:15 AM" }, "#0:d0:anchor-missing");
  // the anchor is case-sensitive
  await red(Q, { valueKind: "text", anchor: "departure time:" }, { d0: "8:15 AM" }, "#0:d0:anchor-missing");
  // an anchor failure and a malformed claim value are both reported; the absent item is not
  await red(Q, { valueKind: "text", anchor: "Boarding:" }, { d0: "" }, "#0:d0:anchor-missing", "#0:d0:claim-value-malformed");
});

test("text unanchored cannot tell which field the value is in (the documented limit); an anchor can", async () => {
  const block = "Flight LAX to SFO. Departure time: 8:15 AM. Arrival time: 9:47 AM.";
  await green(block, TXT, { d0: "SFO" }); // "from SFO" passes on a wrong-way page
  await green(block, TXT, { d0: "LAX" });
  await green(block, { valueKind: "text", anchor: "Departure time:" }, { d0: "8:15 AM" });
  await red(block, { valueKind: "text", anchor: "Departure time:" }, { d0: "9:47 AM" }, "#0:d0:claim-value-absent:9:47 AM");
  await red(block, { valueKind: "text", anchor: "Arrival time:" }, { d0: "8:15 AM" }, "#0:d0:claim-value-absent:8:15 AM");
});

test("d<j> indexes the WHOLE decides list: a presence decide in the middle keeps its slot (#59)", async () => {
  const Q = "Alaska Nonstop 8:15 AM $389 MS791";
  const decides = [DOLLAR, { phrases: ["Nonstop"] }, TXT, TIME];
  const ok = { d0: "389", d2: "MS791", d3: "8:15 AM" };
  const run = (values) => runWith(Q, decides, [{ claim: "c", quote: Q, values }]);
  assert.equal((await run(ok)).verdict, "green");
  let r = await run({ d0: "389", d1: "Nonstop", d2: "MS791", d3: "8:15 AM" });
  assert.deepEqual(items(r), ["#0:d1:claim-value-unknown"], "d1 is the presence decide's slot");
  r = await run({ d0: "389", d2: "MS791" });
  assert.deepEqual(items(r), ["#0:d3:claim-value-missing"]);
  r = await run({ d0: "389", d3: "8:15 AM" });
  assert.deepEqual(items(r), ["#0:d2:claim-value-missing"]);
  r = await run({ d0: "1", d2: "Delta", d3: "9:00 AM" });
  assert.deepEqual(items(r), ["#0:d0:claim-value-mismatch:1!=389", "#0:d2:claim-value-absent:Delta", "#0:d3:claim-value-mismatch:09:00!=08:15"]);
});

test("a mixed check reports decide reds, then binding reds in decide order, then unknown keys, then numbers; decideQuote runs once per distinct quote", async () => {
  const Q = "Alaska Nonstop $389 MS791 8:15 AM";
  const decides = [{ valueKind: "money", currency: "$", op: "lt", value: 100 }, DOLLAR, TXT, { phrases: ["Direct"] }];
  const r = await runWith(Q, decides, [
    { claim: "x 77", quote: Q, values: { d0: "389", d1: "1", d2: "Delta", extra: "1" } },
    { claim: "y", quote: Q, values: { d0: "389", d1: "389", d2: "ms791" } },
  ]);
  assert.deepEqual(items(r), [
    "#0:d0:value-over", "#0:d3:phrase-missing:Direct", "#0:d1:claim-value-mismatch:1!=389", "#0:d2:claim-value-absent:Delta", "#0:extra:claim-value-unknown", "#0:numbers:77",
    "#1:d0:value-over", "#1:d3:phrase-missing:Direct",
  ]);
});

test("hostile values stay red, never a throw (throwing getter, Proxy, __proto__ key) on bind-only and text decides", async () => {
  const getter = {};
  Object.defineProperty(getter, "d0", { enumerable: true, get() { throw new Error("boom"); } });
  const proxy = new Proxy({}, { has() { throw new Error("boom"); }, get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); }, getOwnPropertyDescriptor() { throw new Error("boom"); } });
  const proto = JSON.parse('{"d0":"MS791","__proto__":{"d0":"x"}}');
  for (const d of [DOLLAR, TXT]) {
    for (const values of [getter, proxy, proto]) {
      const r = await runWith(ALASKA + " MS791", [d], [{ claim: "c", quote: ALASKA + " MS791", values }]);
      assert.equal(typeof r.verdict, "string");
    }
  }
  assert.equal((await runWith(FLIGHT, [TXT], [{ claim: "c", quote: FLIGHT, values: proxy }])).verdict, "red");
  assert.equal((await runWith(FLIGHT, [TXT], [{ claim: "c", quote: FLIGHT, values: getter }])).verdict, "red");
});

test("vocabulary and validator agree, both directions, for the decide value shape", () => {
  const shape = rubricVocabulary.rules.cited.fields.decides.shapes.value;
  const ok = { valueKind: "number" };
  // vocab -> validator: every listed valueKind is accepted bare-or-minimal; every listed op is accepted with its bound
  const minimal = { number: {}, money: { currency: "$" }, date: {}, time: {}, text: {} };
  for (const k of shape.fields.valueKind.enum) assert.doesNotThrow(() => mkRubric(REAL, [{ valueKind: k, ...minimal[k] }]), `valueKind ${k}`);
  for (const op of shape.fields.op.enum) {
    const d = op === "between" ? { valueKind: "number", op, lo: 1, hi: 2 } : { valueKind: "number", op, value: 1 };
    assert.doesNotThrow(() => mkRubric(REAL, [d]), `op ${op}`);
  }
  // validator -> vocab: nothing outside the listed enums is accepted
  refusePath([{ ...ok, valueKind: "string" }], /decides\[0\]\.valueKind/);
  refusePath([{ ...ok, op: "eq", value: 1 }], /decides\[0\]\.op/);
  // the vocab's `required` flags are the validator's: valueKind is required, op is not
  assert.equal(shape.fields.valueKind.required, true);
  assert.equal(shape.fields.op.required, false);
  refusePath([{ op: "lt", value: 1 }], /decides\[0\]\.valueKind is required/);
  assert.doesNotThrow(() => mkRubric(REAL, [{ valueKind: "date" }]));
  // every field the vocab lists is a field the validator takes, and an unlisted one is refused
  for (const f of Object.keys(shape.fields)) assert.ok(["valueKind", "op", "value", "lo", "hi", "currency", "unit", "anchor", "until"].includes(f), f);
  refusePath([{ ...ok, color: "red" }], /decides\[0\]\.color is not a recognised decide field/);
  // the text shape's listed fields are exactly what text accepts
  for (const f of shape.textFields) assert.doesNotThrow(() => mkRubric(REAL, [{ valueKind: "text", ...(f === "anchor" || f === "until" ? { anchor: "a" } : {}), ...(f === "until" ? { until: "b" } : {}) }]), f);
  for (const f of Object.keys(shape.fields).filter((x) => !shape.textFields.includes(x))) {
    const sample = { op: "lt", value: 1, lo: 1, hi: 2, currency: "$", unit: "u" }[f];
    refusePath([{ valueKind: "text", [f]: sample }], new RegExp(`decides\\[0\\]\\.${f} is refused on a text decide`));
  }
  // the conditions say it, and the generated description carries it
  const joined = shape.conditions.join(" | ");
  for (const w of ["op may be omitted", "bind-only", "valueKind text is bind-only", "at most 200 characters", "exactly one of currency or unit"]) assert.ok(joined.includes(w), w);
  assert.ok(rubricVocabulary.rules.cited.fields.decides.conditions[0].includes("j indexes the whole decides list"));
  const d = describeRule("cited");
  assert.equal(d, rubricVocabulary.rules.cited.description);
  for (const w of ["op?:", '"text"', "op may be omitted", "valueKind text is bind-only", "j indexes the whole decides list"]) assert.ok(d.includes(w), w);
});

test("hostile text and membership input: never throws and stays linear 16 KiB -> 64 KiB", async () => {
  const { evalDecide, textPresent, textAfter } = await import("../src/primitives/rubric-locate.js");
  const v = "a".repeat(199) + "b";
  const cases = (n) => ({
    as: "a".repeat(n),
    glued: "xMS791 ".repeat(Math.floor(n / 7)),
    marks: "á".repeat(n / 2),
    pairs: "\u{1D400}".repeat(n / 2),
    money: "$1,234.50 ".repeat(Math.floor(n / 10)),
    times: "12:05 AM ".repeat(Math.floor(n / 9)),
  });
  const run = (n) => {
    const t = process.hrtime.bigint();
    for (const [name, q] of Object.entries(cases(n))) {
      const f = q.toLowerCase();
      for (const val of [v, "a", "ms791", "\u{1D400}", "á"]) {
        assert.equal(typeof textPresent(f, val), "boolean", name);
        assert.equal(typeof textAfter(q, 0, val), "boolean", name);
      }
      for (const d of [DOLLAR, TIME, { valueKind: "number" }, { valueKind: "date" }, { valueKind: "money", unit: "US dollars" }, TXT, { ...TXT, anchor: "xMS791" }]) assert.equal(typeof evalDecide(d, q).ok, "boolean", name);
    }
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  run(4096); // warm up
  const small = run(16 * 1024);
  const large = run(64 * 1024);
  // loose catastrophic-blow-up guard only (see the decide-core guard); the 5 MiB scaling check is `npm run bench:rubric`
  assert.ok(large < small * 40 + 100, `not linear: ${small} ms -> ${large} ms`);
});

test("text digit glue (#60): . or , between digits is not a boundary; elsewhere punctuation still is", async () => {
  const CL = "## [0.41.0] - 2026-10-12";
  await red(CL, TXT, { d0: "0.41" }, "#0:d0:claim-value-absent:0.41");
  await red(CL, TXT, { d0: "41.0" }, "#0:d0:claim-value-absent:41.0");
  await green(CL, TXT, { d0: "0.41.0" });
  await green(CL, TXT, { d0: "2026-10-12" });
  await red("Price 3.5 now", TXT, { d0: "3" }, "#0:d0:claim-value-absent:3");
  await green("Price 3.5 now", TXT, { d0: "3.5" });
  await red("1,234 seats", TXT, { d0: "1" }, "#0:d0:claim-value-absent:1");
  await green("1,234 seats", TXT, { d0: "1,234" });
  await green("costs 5.", TXT, { d0: "5" });
  await green("costs 5, then", TXT, { d0: "5" });
  await green("MS791.", TXT, { d0: "MS791" });
  await red("v1.2", TXT, { d0: "v1" }, "#0:d0:claim-value-absent:v1");
  // the start side: "234" inside "1,234" and "5" inside "3.5"
  await red("1,234 seats", TXT, { d0: "234" }, "#0:d0:claim-value-absent:234");
  await red("Price 3.5 now", TXT, { d0: "5" }, "#0:d0:claim-value-absent:5");
  // anchored (end boundary)
  const A = { valueKind: "text", anchor: "Version:" };
  await red("Version: 0.41.0", A, { d0: "0.41" }, "#0:d0:claim-value-absent:0.41");
  await green("Version: 0.41.0", A, { d0: "0.41.0" });
});

test("text hyphen digit glue (#62): a - after a digit and before a letter/digit is not a boundary", async () => {
  await red("## [0.41.0-rc1]", TXT, { d0: "0.41.0" }, "#0:d0:claim-value-absent:0.41.0");
  await green("## [0.41.0-rc1]", TXT, { d0: "0.41.0-rc1" });
  await red("0.41.0-rc1", TXT, { d0: "rc1" }, "#0:d0:claim-value-absent:rc1");
  await red("date 2026-10-12", TXT, { d0: "2026" }, "#0:d0:claim-value-absent:2026");
  await green("date 2026-10-12", TXT, { d0: "2026-10-12" });
  await green("LAX-SFO", TXT, { d0: "LAX" }); // a letter before the hyphen is unaffected
  await green("LAX-SFO", TXT, { d0: "SFO" });
  await green("8:15 AM – 9:47 AM", TXT, { d0: "9:47 AM" }); // en dash with spaces
  await green("costs 5-", TXT, { d0: "5" }); // nothing after the hyphen
  await green("costs 5 - 6", TXT, { d0: "5" }); // a space after the hyphen
  // anchored end boundary
  const A = { valueKind: "text", anchor: "Version:" };
  await red("Version: 0.41.0-rc1", A, { d0: "0.41.0" }, "#0:d0:claim-value-absent:0.41.0");
  await green("Version: 0.41.0-rc1", A, { d0: "0.41.0-rc1" });
});

test("text until (#61): the claim must EQUAL the field between the anchor and the first until", async () => {
  const Q = "Leaves San Francisco International Airport at 9:27 AM";
  const U = { valueKind: "text", anchor: "Leaves", until: " at" };
  await green(Q, U, { d0: "San Francisco International Airport" });
  await green(Q, U, { d0: "san francisco international airport" });
  await green(Q, U, { d0: "  San   Francisco International Airport " }); // the claim is normalized
  await red(Q, U, { d0: "San Francisco" }, "#0:d0:claim-value-mismatch:San Francisco!=San Francisco International Airport");
  await red(Q, U, { d0: "San Francisco International Airport at" }, "#0:d0:claim-value-mismatch:San Francisco International Airport at!=San Francisco International Airport");
  // without until the whole-token prefix still passes (the documented limit)
  await green(Q, { valueKind: "text", anchor: "Leaves" }, { d0: "San Francisco" });
  // an anchor with trailing space is trimmed like today; the leading space of until is kept (so " at" is not "Intern-at-ional")
  await green(Q, { ...U, anchor: "Leaves " }, { d0: "San Francisco International Airport" });
  // until-missing is a decide red (the binding is not evaluated); anchor reds are unchanged
  await red(Q, { ...U, until: " by" }, { d0: "x" }, "#0:d0:until-missing");
  await red(Q, { ...U, anchor: "Boards" }, { d0: "x" }, "#0:d0:anchor-missing");
  await red(`${Q} Leaves`, U, { d0: "x" }, "#0:d0:anchor-ambiguous");
  // until before the anchor does not count; the FIRST until after the anchor wins
  await red("at Leaves Paris", { valueKind: "text", anchor: "Leaves", until: " at" }, { d0: "Paris" }, "#0:d0:until-missing");
  await green("Leaves Paris at Rome at Oslo", U, { d0: "Paris" });
  // empty field
  await red("Leaves at 9", U, { d0: "x" }, "#0:d0:value-none");
  // until is case-sensitive; a malformed claim is still reported
  await red(Q, { ...U, until: " AT" }, { d0: "x" }, "#0:d0:until-missing");
  await red(Q, U, { d0: "" }, "#0:d0:claim-value-malformed");
  const long = "z".repeat(200);
  const r = await bind(`Leaves ${long} at 9`, U, { d0: long.slice(1) });
  assert.equal(r.verdict, "red");
  assert.ok(items(r)[0].startsWith("#0:d0:claim-value-mismatch:zzz") && items(r)[0].length < 300, "both sides clipped");
});

test("text until (#61): refusals", () => {
  refusePath([{ valueKind: "text", until: " at" }], /decides\[0\]\.until is refused without an anchor/);
  refusePath([{ valueKind: "text", anchor: "a", until: "" }], /decides\[0\]\.until/);
  refusePath([{ valueKind: "text", anchor: "a", until: "  " }], /decides\[0\]\.until/);
  refusePath([{ valueKind: "text", anchor: "a", until: "u".repeat(1001) }], /decides\[0\]\.until/);
  refusePath([{ valueKind: "text", anchor: "a", until: 5 }], /decides\[0\]\.until/);
  refusePath([{ valueKind: "money", currency: "$", anchor: "a", until: "b" }], /decides\[0\]\.until is refused on a non-text decide/);
  refusePath([{ valueKind: "time", op: "lt", value: "12:00", anchor: "a", until: "b" }], /decides\[0\]\.until is refused on a non-text decide/);
  refusePath([{ valueKind: "number", until: "b" }], /decides\[0\]\.until/);
  refusePath([{ phrases: ["a"], until: "b" }], /decides\[0\]\.until/);
  assert.doesNotThrow(() => mkRubric(REAL, [{ valueKind: "text", anchor: "a", until: " at" }]));
});

test("membership mismatch lists DISTINCT values, and counts them (#63)", async () => {
  const Q = "09:27 AM 11:07 AM 9:27 AM 11:07 AM 9:27 AM 11:07 AM";
  await red(Q, TIME, { d0: "12:34" }, "#0:d0:claim-value-mismatch:12:34!=09:27,11:07");
  const many = [...Array(25).keys()].map((n) => n + 1).join(" ");
  const want = `#0:d0:claim-value-mismatch:99!=${[...Array(20).keys()].map((n) => n + 1).join(",")},...(25 in all)`;
  await red(`${many} ${many}`, { valueKind: "number" }, { d0: "99" }, want);
});
