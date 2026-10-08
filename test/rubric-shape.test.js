import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRubric, checkStep } from "../src/index.js";

// ---------------------------------------------------------------------------
// checkStep — shape rules over the output (docs/product/rubric-prd.md §4.1)
// ---------------------------------------------------------------------------

const run = (checks, output, opts) =>
  checkStep(createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks } } }), "cp", output, opts);
const one = (rule, extra, output) => run([{ id: "k", rule, field: "text", ...extra }], output);
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const gap = (r) => r.gaps[0];

test("maxWords: AT / UNDER / OVER the limit (600 / 599 / 601); gap carries measured, limit, direction, key", async () => {
  for (const [n, verdict] of [[599, "green"], [600, "green"], [601, "red"], [633, "red"]]) {
    const r = await one("maxWords", { value: 600 }, words(n));
    assert.equal(r.verdict, verdict, `${n} words`);
  }
  const r = await one("maxWords", { value: 600 }, words(633));
  assert.deepEqual(gap(r), {
    key: "cp:k", checkpoint: "cp", check: "maxWords", id: "k", field: "text",
    kind: "over", measured: 633, limit: 600, direction: "at-most",
  });
  assert.equal(r.fault, null);
});

test("minWords: AT / UNDER / OVER (600 / 599 / 601); direction at-least", async () => {
  for (const [n, verdict] of [[599, "red"], [600, "green"], [601, "green"]]) {
    assert.equal((await one("minWords", { value: 600 }, words(n))).verdict, verdict, `${n} words`);
  }
  const g = gap(await one("minWords", { value: 600 }, words(599)));
  assert.equal(g.kind, "under");
  assert.equal(g.direction, "at-least");
  assert.equal(g.measured, 599);
});

test("words: forgiving strips a leading '#' run per line ('## Summary' = 1), strict counts markers ('## Summary' = 2)", async () => {
  const text = "## Summary\n### Skills and more";
  // forgiving: Summary(1) + Skills and more(3) = 4;  strict: ##,Summary,###,Skills,and,more = 6
  assert.equal((await one("maxWords", { value: 4 }, text)).verdict, "green");
  assert.equal((await one("maxWords", { value: 3 }, text)).verdict, "red");
  assert.equal((await one("maxWords", { value: 5, strict: true }, text)).verdict, "red");
  assert.equal(gap(await one("maxWords", { value: 5, strict: true }, text)).measured, 6);
  assert.equal((await one("maxWords", { value: 6, strict: true }, text)).verdict, "green");
  assert.equal(gap(await one("maxWords", { value: 1 }, "## Summary two")).measured, 2);
  assert.equal(gap(await one("maxWords", { value: 1, strict: true }, "## Summary two")).measured, 3);
  assert.equal((await one("maxWords", { value: 1 }, "## Summary")).verdict, "green", "'## Summary' counts 1 forgiving");
  assert.equal((await one("minWords", { value: 2, strict: true }, "## Summary")).verdict, "green", "and 2 strict");
});

test("words: '#' run strip is per line and only leading; blank lines and CRLF count 0; '#' alone is 0 forgiving", async () => {
  assert.equal(gap(await one("maxWords", { value: 1 }, "a #tag b\r\n\r\n#\r\n# x y")).measured, 5); // a,#tag,b + x,y
  assert.equal(gap(await one("maxWords", { value: 1 }, "a\n#\nb c")).measured, 3);
  assert.equal(gap(await one("maxWords", { value: 1, strict: true }, "a\n#\nb c")).measured, 4);
});

test("minWords strict can LOOSEN (markers add to the count): documented spec tension, behavior pinned", async () => {
  // PRD §4.1 says strict "can only tighten", but its word rule counts MORE tokens under strict.
  assert.equal((await one("minWords", { value: 2 }, "## Summary")).verdict, "red");
  assert.equal((await one("minWords", { value: 2, strict: true }, "## Summary")).verdict, "green");
});

test("maxLines: counts NON-EMPTY lines; AT / UNDER / OVER", async () => {
  const t = "a\n\n  \nb\nc\n";
  assert.equal((await one("maxLines", { value: 3 }, t)).verdict, "green");
  assert.equal((await one("maxLines", { value: 2 }, t)).verdict, "red");
  assert.equal((await one("maxLines", { value: 4 }, t)).verdict, "green");
  const g = gap(await one("maxLines", { value: 2 }, t));
  assert.deepEqual([g.measured, g.limit, g.direction], [3, 2, "at-most"]);
});

test("nonEmpty: string / array / object with >=1 own key green; empty or wrong type red", async () => {
  const ne = (v) => run([{ id: "k", rule: "nonEmpty", field: "f" }], { x: 1, f: v });
  for (const v of ["a", [0], { a: 1 }]) assert.equal((await ne(v)).verdict, "green", JSON.stringify(v));
  for (const [v, kind] of [["", "empty"], ["  \n", "empty"], [[], "empty"], [{}, "empty"], [5, "wrong-type"], [null, "wrong-type"], [true, "wrong-type"]]) {
    const r = await ne(v);
    assert.equal(r.verdict, "red", JSON.stringify(v));
    assert.equal(gap(r).kind, kind);
  }
  const miss = await run([{ id: "k", rule: "nonEmpty", field: "f" }], { x: 1 });
  assert.equal(gap(miss).kind, "missing");
});

// --- headings ----------------------------------------------------------------

test("sections (forgiving): '## Summary', '# summary', 'Summary:' and a bare 'Summary' line all match; names compared trimmed+lowercased", async () => {
  for (const text of ["## Summary\nx", "# summary\nx", "Summary:\nx", "x\nSummary\nx", "###   SUMMARY\nx", "Summary:  \nx"]) {
    assert.equal((await one("sections", { names: ["Summary"] }, text)).verdict, "green", JSON.stringify(text));
  }
  assert.equal((await one("sections", { names: ["  SUMMARY "] }, "## summary")).verdict, "green");
});

test("sections (forgiving): heading text is case-insensitive in BOTH directions", async () => {
  assert.equal((await one("sections", { names: ["Summary"] }, "## SUMMARY")).verdict, "green");
  assert.equal((await one("sections", { names: ["SKILLS"] }, "## skills")).verdict, "green");
});

test("sections: absent = red 'missing' with the missing names; a heading must equal the name (no substring); empty heading line never matches", async () => {
  const r = await one("sections", { names: ["Summary", "Skills"] }, "## Summary\ntext about skills here");
  assert.equal(r.verdict, "red");
  assert.deepEqual([gap(r).kind, gap(r).items, gap(r).measured, gap(r).limit], ["missing", ["Skills"], 1, 2]);
  assert.equal((await one("sections", { names: ["Sum"] }, "## Summary")).verdict, "red");
  assert.equal((await one("sections", { names: ["#"] }, "#\n## \n:\n## :")).verdict, "red");
});

test("sectionOrder: in order green; absent = 'missing'; present only earlier = 'out-of-order'", async () => {
  const names = ["Summary", "Skills", "Education"];
  assert.equal((await one("sectionOrder", { names }, "## Summary\n## Skills\n## Education")).verdict, "green");
  const miss = gap(await one("sectionOrder", { names }, "## Summary\n## Education"));
  assert.deepEqual([miss.kind, miss.items], ["missing", ["missing:Skills"]]);
  const ooo = gap(await one("sectionOrder", { names }, "## Skills\n## Summary\n## Education"));
  assert.deepEqual([ooo.kind, ooo.items], ["out-of-order", ["out-of-order:Skills"]]);
});

test("sectionOrder after a MISSING name keeps checking later names; the search position does NOT move past the missing one", async () => {
  const names = ["A", "B", "C"];
  // A at 0, B missing, C at 1: C is after the position (1) -> only B is reported
  const g1 = gap(await one("sectionOrder", { names }, "A\nC"));
  assert.deepEqual([g1.kind, g1.items], ["missing", ["missing:B"]]);
  // C before A, B missing: A matches at 1 (position 2), B missing (position stays 2), C only at 0 -> out of order
  const g2 = gap(await one("sectionOrder", { names }, "C\nA"));
  assert.deepEqual([g2.kind, g2.items], ["missing,out-of-order", ["missing:B", "out-of-order:C"]]);
  // first name missing: later names are still searched from position 0
  assert.equal((await one("sectionOrder", { names: ["X", "A", "C"] }, "A\nC")).gaps[0].items.join(), "missing:X");
  // repeated heading: the second use of a name needs a later occurrence
  assert.equal((await one("sectionOrder", { names: ["A", "A"] }, "A")).gaps[0].items.join(), "out-of-order:A");
  assert.equal((await one("sectionOrder", { names: ["A", "A"] }, "A\nx\nA")).verdict, "green");
});

test("sections AND sectionOrder on the same names: both fire, union of reds as two gaps in signed order", async () => {
  const r = await run(
    [{ id: "s", rule: "sections", field: "text", names: ["A", "B"] }, { id: "o", rule: "sectionOrder", field: "text", names: ["A", "B"] }],
    "A",
  );
  assert.deepEqual(r.gaps.map((g) => g.key), ["cp:s", "cp:o"]);
});

test("strict headings: ATX only, exact case, closing '#' run allowed; setext / bare line / HTML / bold are not headings", async () => {
  const s = (text, names = ["Summary"]) => one("sections", { names, strict: true }, text);
  assert.equal((await s("## Summary")).verdict, "green");
  assert.equal((await s("# Summary ##")).verdict, "green");
  assert.equal((await s("###### Summary")).verdict, "green");
  assert.equal(gap(await s("## summary")).kind, "missing", "case differs = red");
  assert.equal(gap(await s("Summary\n=======")).kind, "no-headings", "setext is not a heading");
  assert.equal(gap(await s("Summary")).kind, "no-headings", "a bare line is not a heading");
  assert.equal(gap(await s("Summary:\n")).kind, "no-headings");
  assert.equal(gap(await s("<h2>Summary</h2>")).kind, "no-headings");
  assert.equal(gap(await s("**Summary**")).kind, "no-headings");
  assert.equal(gap(await s("#Summary")).kind, "no-headings", "no space after '#'");
  assert.equal(gap(await s("####### Summary")).kind, "no-headings", "7 hashes");
  assert.equal(gap(await s("## Other\nSummary")).kind, "missing", "an ATX heading exists, the name is not one");
  assert.equal(gap(await s("## Summary:")).kind, "missing", "strict keeps the trailing ':'");
});

test("strict never turns a strict-red green: every strict-green output is also forgiving-green (corpus, names without a trailing '#')", async () => {
  const outputs = ["## Summary", "Summary", "## summary", "Summary\n===", "## Skills\n## Summary", "x", "### Summary:", "## Summary\n## Skills"];
  let strictGreen = 0;
  for (const text of outputs) for (const names of [["Summary"], ["Skills"], ["Summary", "Skills"]]) for (const rule of ["sections", "sectionOrder"]) {
    const st = (await one(rule, { names, strict: true }, text)).verdict;
    const fg = (await one(rule, { names }, text)).verdict;
    if (st === "green") { strictGreen++; assert.equal(fg, "green", `${rule} ${JSON.stringify(names)} on ${JSON.stringify(text)}`); }
  }
  assert.ok(strictGreen >= 5, "the corpus has real strict-green cases (positive control)");
});

test("strict heading parse equals the literal regex ^#{1,6} +(.+?) *#*$ on a differential corpus (hand-coded, linear)", async () => {
  const alphabet = ["#", " ", "a", "b", ":", "\t", "\r", "\u2028", "é"];
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const cases = ["", "#", "# ", "#  ", "## a", "## a ##", "## a#", "## ###", "####### a", "#a", " # a", "## a  ", "##  a b  #  #", "# C#"];
  for (let i = 0; i < 4000; i++) {
    const body = Array.from({ length: rnd(11) }, () => alphabet[rnd(alphabet.length)]).join("");
    cases.push(i % 2 ? body : "#".repeat(1 + rnd(7)) + " ".repeat(rnd(3)) + body); // half start like a heading
  }
  let matched = 0;
  for (const line of cases) {
    const m = /^#{1,6} +(.+?) *#*$/.exec(line);
    const r = await run([{ id: "k", rule: "sections", field: "text", names: ["q"], strict: true }], { text: line });
    if (!m) { assert.equal(gap(r).kind, "no-headings", `no heading in ${JSON.stringify(line)}`); continue; }
    matched++;
    assert.equal(gap(r).kind, "missing", `heading exists in ${JSON.stringify(line)}`);
    if (m[1].trim() !== "") {
      const hit = await run([{ id: "k", rule: "sections", field: "text", names: [m[1]], strict: true }], { text: line });
      assert.equal(hit.verdict, "green", `capture ${JSON.stringify(m[1])} of ${JSON.stringify(line)}`);
      const near = await run([{ id: "k", rule: "sections", field: "text", names: [m[1] + "x"], strict: true }], { text: line });
      assert.equal(near.verdict, "red");
    }
  }
  assert.ok(matched > 200, `corpus exercised ${matched} matching headings`);
});

test("strict heading parse is linear: a 200k-char space/hash run does not stall", async () => {
  const t0 = Date.now();
  await one("sections", { names: ["a"], strict: true }, "# a" + " ".repeat(200000) + "x");
  await one("sections", { names: ["a"], strict: true }, "# " + "#".repeat(200000) + " x");
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
});

// --- mustCarry / blockLines ---------------------------------------------------

test("mustCarry: case differs = green by default, red under strict; missing phrase named in the gap", async () => {
  assert.equal((await one("mustCarry", { text: "Hello World" }, "say hello world now")).verdict, "green");
  const strict = await one("mustCarry", { text: "Hello World", strict: true }, "say hello world now");
  assert.equal(strict.verdict, "red");
  assert.deepEqual([gap(strict).kind, gap(strict).items], ["missing", ["Hello World"]]);
  assert.equal((await one("mustCarry", { text: "Hello World", strict: true }, "say Hello World now")).verdict, "green");
  assert.equal((await one("mustCarry", { text: "xyz" }, "abc")).verdict, "red");
});

test("blockLines: groups of N non-empty lines; phrase must be in EACH block", async () => {
  const bl = (extra, text) => one("blockLines", { size: 2, mustCarry: ["Owner"], ...extra }, { text });
  assert.equal((await bl({}, "task 1\nOwner: a\ntask 2\nOwner: b")).verdict, "green");
  // phrase in the joined block, not necessarily on the first line
  assert.equal((await bl({}, "Owner a\nx\nOwner b\ny")).verdict, "green");
  const missing = gap(await bl({}, "task 1\nOwner: a\ntask 2\nnothing"));
  assert.deepEqual([missing.kind, missing.items], ["block-missing", ["block 2:Owner"]]);
  const notMult = gap(await bl({}, "Owner a\nx\nOwner b"));
  assert.deepEqual([notMult.kind, notMult.measured, notMult.limit], ["not-multiple", 3, 2]);
  const both = gap(await bl({}, "Owner a\nx\ny"));
  assert.equal(both.kind, "not-multiple,block-missing");
  assert.deepEqual(both.items, ["block 2:Owner"]);
  // blank lines are ignored when grouping
  assert.equal((await bl({}, "\n\nOwner a\n  \nx\n\n")).verdict, "green");
});

test("blockLines: zero non-empty lines = red 'zero-lines'", async () => {
  const r = await one("blockLines", { size: 2, mustCarry: ["x"] }, { text: " \n\n \t\n" });
  assert.equal(r.verdict, "red");
  assert.deepEqual([gap(r).kind, gap(r).measured, gap(r).limit], ["zero-lines", 0, 2]);
});

test("blockLines: case follows strict; several phrases must ALL be in each block", async () => {
  const text = "owner a\nDUE b";
  assert.equal((await one("blockLines", { size: 2, mustCarry: ["Owner", "due"] }, { text })).verdict, "green");
  const s = await one("blockLines", { size: 2, mustCarry: ["Owner", "due"], strict: true }, { text });
  assert.equal(s.verdict, "red");
  assert.deepEqual(gap(s).items, ["block 1:Owner", "block 1:due"]);
});

test("blockLines: size 1 and a size larger than the line count", async () => {
  assert.equal((await one("blockLines", { size: 1, mustCarry: ["a"] }, { text: "a\nab" })).verdict, "green");
  assert.equal(gap(await one("blockLines", { size: 5, mustCarry: ["a"] }, { text: "a\na" })).kind, "not-multiple");
});

// --- the output's shape ---------------------------------------------------------

test("a string output is the single field 'text'; any other field name is missing (red, loud) rather than silently bound", async () => {
  const r = await run([{ id: "k", rule: "maxWords", field: "body", value: 5 }], "a b c");
  assert.equal(gap(r).kind, "missing");
  assert.equal(gap(r).direction, "at-most");
  assert.equal(gap(r).limit, 5);
});

test("a text rule on a non-string field is red 'wrong-type' naming the type", async () => {
  const r = await run([{ id: "k", rule: "mustCarry", field: "f", text: "x" }], { f: 12 });
  assert.deepEqual([gap(r).kind, gap(r).measured], ["wrong-type", "type:number"]);
});

test("gaps are minted in signed check order, each with a stable key, across repeated runs", async () => {
  const checks = [
    { id: "z-last-alpha", rule: "maxWords", field: "text", value: 1 },
    { id: "a-first-alpha", rule: "mustCarry", field: "text", text: "nope" },
  ];
  const a = await run(checks, "two words here");
  const b = await run(checks, "other words entirely here too");
  assert.deepEqual(a.gaps.map((g) => g.key), ["cp:z-last-alpha", "cp:a-first-alpha"]);
  assert.deepEqual(a.gaps.map((g) => g.key), b.gaps.map((g) => g.key));
});

test("green verdict: no gaps, no fault, outputSha is sha256 of the UTF-8 bytes of the checked string", async () => {
  const out = "héllo wörld ✓";
  const r = await one("maxWords", { value: 10 }, out);
  assert.equal(r.verdict, "green");
  assert.deepEqual([r.gaps, r.fault], [[], null]);
  assert.equal(r.outputSha, createHash("sha256").update(Buffer.from(out, "utf8")).digest("hex"));
  assert.notEqual(r.outputSha, createHash("sha256").update(Buffer.from(out, "latin1")).digest("hex"));
});

test("an object output has outputSha null (bareguard never serializes an object to hash it)", async () => {
  assert.equal((await one("nonEmpty", {}, { text: "x" })).outputSha, null);
});

test("the result is deep-frozen and carries the rubric sha and checkpoint", async () => {
  const r = await one("maxWords", { value: 1 }, "a b");
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.gaps) && Object.isFrozen(r.gaps[0]) && Object.isFrozen(r.full));
  assert.match(r.rubricSha, /^[0-9a-f]{64}$/);
  assert.equal(r.checkpoint, "cp");
  assert.deepEqual(r.full.gaps, r.gaps);
});

test("a checkpoint with no opt-in checks still runs the foundational 'happened'", async () => {
  assert.equal((await run([], "x")).verdict, "green");
  const r = await run([], "");
  assert.equal(r.verdict, "red");
  assert.deepEqual([gap(r).key, gap(r).check, gap(r).kind], ["cp:happened", "happened", "empty"]);
  assert.equal((await run([], "  \n ")).verdict, "red");
  assert.equal((await run([], {})).verdict, "red");
  assert.equal((await run([], { a: [] })).verdict, "green");
});

test("happened red short-circuits: no field checks pile on top of an empty output", async () => {
  const r = await run([{ id: "k", rule: "maxWords", field: "text", value: 1 }], "");
  assert.deepEqual(r.gaps.map((g) => g.check), ["happened"]);
});
