import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRubric, checkStep, rubricSha, rubricVocabulary } from "../src/index.js";

// presence decide `any` / `edges` (docs/product/rubric-prd.md RULED #79, bareloop BG-4).

const sha = (s) => createHash("sha256").update(s).digest("hex");

// bareloop's frozen consumer lines, verbatim (fixture source; the page itself is not copied).
const L_FIXED = "### Fixed";
const L_CHANGED = "### Changed";
const L_PATCH = "feature lands, **patch** = docs, fixes, scaffolding.";
const L_TRAP = '- **Plain panel words for a stuck refused-argument loop**: the Ended block names what the model did instead of "(code: interpreter-red)"; the terminal outcome is unchanged (the escalation record gains `badCall`).';
const SOURCE = ["# Changelog", L_FIXED, "- a", L_CHANGED, "- b", L_PATCH, L_TRAP, "- Fixed  bug", "- Fixedup the thing", "- (Fixed) and Fixed: done", "- Readded it"].join("\n");

const mk = (source, decides) =>
  createRubric({
    schema: 1,
    goal: "g",
    inputs: [{ name: "offers", sha256: sha(source) }],
    checkpoints: { cp: { gating: true, checks: [{ id: "c", rule: "cited", claims: "claims", source: "offers", decides }] } },
  });
const run = (decides, quote, source = SOURCE) => checkStep(mk(source, decides), "cp", { claims: [{ claim: "x", quote }] }, { inputs: { offers: source } });
const items = (r) => r.gaps[0]?.items;
const WORDS = ["Added", "Changed", "Fixed"];
const ANY_EDGES = [{ phrases: WORDS, any: true, edges: true }];
const ANY_SUB = [{ phrases: WORDS, any: true }];

test("E1 / E2: a heading quote is GREEN any-of with edges", async () => {
  assert.equal((await run(ANY_EDGES, L_FIXED)).verdict, "green");
  assert.equal((await run(ANY_EDGES, L_CHANGED)).verdict, "green");
});

test("E3: a quote with none of the words is RED none-found (no phrase in the item)", async () => {
  const r = await run(ANY_EDGES, L_PATCH);
  assert.equal(r.verdict, "red");
  assert.deepEqual(items(r), ["#0:d0:none-found"]);
});

test("E4 / E5: the 'unchanged' trap: substring (edges off) is green, edges on is RED none-found", async () => {
  assert.equal((await run(ANY_SUB, L_TRAP)).verdict, "green");
  const r = await run(ANY_EDGES, L_TRAP);
  assert.equal(r.verdict, "red");
  assert.deepEqual(items(r), ["#0:d0:none-found"]);
});

// rubricSha of this exact spec on main (v0.32.0, 4de0d48), taken before the feature
const E6_MAIN_SHA = "fbfddf75b3fed88276ba8efede4706aeb35214e7790ec45c4f73d116d052d534";
test("E6: all-of (no any, no edges) on E1's quote is RED phrase-missing 'Added', and its rubricSha is main's", async () => {
  const decides = [{ phrases: WORDS }];
  const r = await run(decides, L_FIXED);
  assert.equal(r.verdict, "red");
  assert.deepEqual(items(r), ["#0:d0:phrase-missing:Added"]);
  assert.equal(rubricSha(mk(SOURCE, decides)), E6_MAIN_SHA);
  // an explicit false is a different signed spec but the same behaviour
  assert.deepEqual(items(await run([{ phrases: WORDS, any: false, edges: false }], L_FIXED)), ["#0:d0:phrase-missing:Added"]);
  assert.notEqual(rubricSha(mk(SOURCE, [{ phrases: WORDS, any: true }])), E6_MAIN_SHA, "signing any changes the sha");
});

test("any-of with edges: glued is not found; punctuation edges are found", async () => {
  const one = [{ phrases: ["Fixed"], any: true, edges: true }];
  assert.deepEqual(items(await run(one, "- Fixedup the thing")), ["#0:d0:none-found"]);
  assert.equal((await run(one, "- (Fixed) and Fixed: done")).verdict, "green");
  assert.equal((await run(one, "- (Fixed) and Fixed: done")).verdict, "green");
});

test("any-of without edges: substring 'Readded' is found", async () => {
  assert.equal((await run(ANY_SUB, "- Readded it")).verdict, "green");
  assert.equal((await run([{ phrases: ["Added"], any: true, edges: false }], "- Readded it")).verdict, "green");
});

test("all-of + edges: 'unchanged' no longer satisfies 'Changed'; the edge match is case-insensitive", async () => {
  assert.equal((await run([{ phrases: ["Changed"] }], L_TRAP)).verdict, "green", "substring all-of: today's behaviour");
  assert.deepEqual(items(await run([{ phrases: ["Changed"], edges: true }], L_TRAP)), ["#0:d0:phrase-missing:Changed"]);
  assert.equal((await run([{ phrases: ["changed", "fixed"], edges: true }], "### Changed and FIXED", "### Changed and FIXED")).verdict, "green");
});

const marks = (r) => r.full.evidence[0].spans.map((s) => `${s.role}:${s.decide}:${r.full.evidence[0].text.slice(s.start, s.end)}`);

test("evidence: any-of green gives one phrase span per FOUND phrase (first occurrence), none for the absent", async () => {
  const q = "Added x. Fixed y. Fixed again. Added z";
  const r = await run([{ phrases: ["Fixed", "Nope", "Added"], any: true, edges: true }], q, q);
  assert.equal(r.verdict, "green");
  // spans come sorted by position (decide, start), not in signed phrase order
  assert.deepEqual(marks(r), ["phrase:0:Added", "phrase:0:Fixed"]);
  assert.deepEqual(r.full.evidence[0].spans.map((s) => s.start), [q.indexOf("Added"), q.indexOf("Fixed")]);
  const sub = await run([{ phrases: ["fixed", "Nope", "added"], any: true }], q, q);
  assert.deepEqual(marks(sub), ["phrase:0:Added", "phrase:0:Fixed"]);
  // a red any-of has no phrase spans
  const red = await run(ANY_EDGES, L_PATCH);
  assert.deepEqual(red.full.evidence[0].spans, []);
});

test("evidence with edges: a multi-space match and an İ before it map back into the quote", async () => {
  // the quote is normalized (whitespace collapsed) before the decides run, so offsets index e.text, as everywhere in full.evidence
  const q = "- Fixed  bug";
  const r = await run([{ phrases: ["fixed BUG"], any: true, edges: true }], q, q);
  assert.equal(r.verdict, "green");
  assert.equal(r.full.evidence[0].text, "- Fixed bug");
  assert.deepEqual(marks(r), ["phrase:0:Fixed bug"]);
  const q2 = "İ Fixed bug, Added";
  const r2 = await run([{ phrases: ["fixed bug", "added"], any: true, edges: true }], q2, q2);
  assert.equal(r2.verdict, "green");
  assert.deepEqual(marks(r2), ["phrase:0:Fixed bug", "phrase:0:Added"]); // already in position order
  const q3 = "İİİ Added";
  assert.deepEqual(marks(await run([{ phrases: ["added"], edges: true }], q3, q3)), ["phrase:0:Added"]);
  // the edge check reads the lowered text: 'İ' lowers to i + a combining mark, so a letter phrase glued after it is not on an edge
  const q4 = "İfixed";
  assert.equal((await run([{ phrases: ["fixed"], any: true, edges: true }], q4, q4)).verdict, "red");
  // a multi-space source phrase: whitespace runs of every kind collapse to the phrase's single space
  const q5 = "x\tFixed \n  bug";
  assert.equal((await run([{ phrases: ["Fixed bug"], edges: true }], q5, q5)).verdict, "green");
});

test("mixed decides keep their slots; any-of beside a value decide", async () => {
  const q = "From 59 US dollars. Fixed it";
  const decides = [{ valueKind: "money", unit: "US dollars", op: "lt", value: 99, anchor: "From " }, { phrases: ["Fixed", "Added"], any: true, edges: true }];
  const r = await checkStep(mk(q, decides), "cp", { claims: [{ claim: "x", quote: q, values: { d0: "59" } }] }, { inputs: { offers: q } });
  assert.equal(r.verdict, "green", JSON.stringify(r.gaps));
});

test("createRubric refusals name the exact path", () => {
  const refuse = (decides, path, re) => {
    try {
      mk("s", decides);
      assert.fail("no throw");
    } catch (e) {
      assert.equal(e.path, path);
      if (re) assert.match(e.message, re);
    }
  };
  const base = "spec.checkpoints.cp.checks[0].decides";
  refuse([{ phrases: ["a"] }, { phrases: ["a"], any: "yes" }], `${base}[1].any`, /must be a boolean/);
  refuse([{ phrases: ["a"], edges: 1 }], `${base}[0].edges`, /must be a boolean/);
  refuse([{ phrases: ["a"], any: null }], `${base}[0].any`);
  refuse([{ phrases: ["Fixed."], edges: true }], `${base}[0].phrases[0]`, /start and end with a letter or digit/);
  refuse([{ phrases: ["Fixed", "a  b"], edges: true }], `${base}[0].phrases[1]`, /single ASCII spaces/);
  refuse([{ phrases: ["a b\tc"], edges: true }], `${base}[0].phrases[0]`);
  refuse([{ valueKind: "number", any: true }], `${base}[0].any`, /not allowed on a value decide/);
  refuse([{ valueKind: "number", edges: true }], `${base}[0].edges`, /not allowed on a value decide/);
  refuse([{ phrases: ["a"], anchor: "x" }], `${base}[0].anchor`, /holds phrases, any and edges/);
  // without edges the phrase rules are unchanged: punctuation ends and spaces runs stay legal
  assert.doesNotThrow(() => mk("s", [{ phrases: ["Fixed.", "a  b", "Fixed."], any: true }]));
  assert.doesNotThrow(() => mk("s", [{ phrases: ["Fixed."], any: false, edges: false }]));
});

test("vocabulary: presence lists any and edges, and its worked example runs GREEN", async () => {
  const f = rubricVocabulary.rules.cited.fields.decides.shapes.presence;
  assert.deepEqual(Object.keys(f.fields), ["phrases", "any", "edges"]);
  assert.equal(f.fields.any.type, "boolean");
  assert.equal(f.fields.edges.type, "boolean");
  assert.ok(f.conditions.some((c) => c.includes("none-found")) && f.conditions.some((c) => c.includes("word edges")));
  assert.ok(rubricVocabulary.rules.cited.description.includes("any?: boolean") && rubricVocabulary.rules.cited.description.includes("edges?: boolean"));
  const { input, check, output } = f.example;
  const spec = createRubric({ schema: 1, goal: "g", inputs: [{ name: input.name, sha256: sha(input.text) }], checkpoints: { cp: { gating: true, checks: [{ ...check }] } } });
  const ok = await checkStep(spec, "cp", output, { inputs: { [input.name]: input.text } });
  assert.equal(ok.verdict, "green", JSON.stringify(ok.gaps));
  // mutation-sensitive: a quote with none of the words is red
  const bad = await checkStep(spec, "cp", { claims: [{ claim: "x", quote: "the terminal outcome is unchanged." }] }, { inputs: { [input.name]: input.text } });
  assert.equal(bad.verdict, "red");
});
