import test from "node:test";
import assert from "node:assert/strict";
import { createRubric, checkStep, renderGaps, rubricVocabulary, rubricSha } from "../src/index.js";

// ---------------------------------------------------------------------------
// sectionWords + allowedKeys — ported from fwdloop's closers.js
// (m4e-am15.test.js "run time" tests; closers.test.js extra-key test). Fixtures are copied
// (synthetic, no PII); expected strings are fwdloop's own, with only "softgreen " dropped
// from the extra-key sentence.
// ---------------------------------------------------------------------------

const mk = (checks) => createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks } } });
const run = (checks, output) => checkStep(mk(checks), "cp", output);
const words = (n, w = "w") => Array.from({ length: n }, () => w).join(" ");
const SECTIONS = ["summary", "professional skills", "soft skills"];
const doc = (a, b, c, pre = "") => `${pre}${pre ? "\n" : ""}## Summary\n${words(a)}\n## Professional Skills\n${words(b)}\n## Soft Skills\n${words(c)}\n`;
const sw = (text, wps = 180, names = SECTIONS) => run([{ id: "sw", rule: "sectionWords", field: "text", names, wordsPerSection: wps }], text);

// ---- sectionWords ----

for (const n of [144, 180, 216]) {
  test(`sectionWords: a section of ${n} words passes (180 asked, 144..216)`, async () => {
    assert.equal((await sw(doc(180, n, 180))).verdict, "green");
  });
}

for (const n of [143, 217]) {
  test(`sectionWords: ${n} words is red; gap fields + rendered text equal fwdloop's`, async () => {
    const r = await sw(doc(180, 180, n));
    assert.equal(r.verdict, "red");
    assert.equal(r.gaps.length, 1);
    const g = r.gaps[0];
    assert.deepEqual(
      { kind: g.kind, section: g.section, words: g.words, asked: g.asked, lo: g.lo, hi: g.hi },
      { kind: "section-words", section: "soft skills", words: n, asked: 180, lo: 144, hi: 216 },
    );
    assert.equal(g.key, "cp:sw");
    assert.equal(g.check, "sectionWords");
    assert.equal(renderGaps(r.gaps), `soft skills: ${n} words, about 180 asked (144-216)`);
  });
}

test("sectionWords: boundary grid lo-1 / lo / hi / hi+1 for several N (ceil/floor)", async () => {
  for (const N of [1, 5, 7, 10, 180, 250]) {
    const lo = Math.ceil((N * 8) / 10);
    const hi = Math.floor((N * 12) / 10);
    for (const [n, want] of [[lo - 1, "red"], [lo, "green"], [hi, "green"], [hi + 1, "red"]]) {
      const r = await sw(`## A\n${n > 0 ? words(n) : ""}\n`, N, ["a"]);
      assert.equal(r.verdict, want, `N=${N} n=${n} band ${lo}-${hi}`);
      if (want === "red") assert.equal(renderGaps(r.gaps), `a: ${n} words, about ${N} asked (${lo}-${hi})`);
    }
  }
});

test("sectionWords: text before the first heading belongs to no section", async () => {
  assert.equal((await sw(doc(180, 180, 180, words(500, "preamble")))).verdict, "green");
});

test("sectionWords: a section ends at the next LISTED heading; an unlisted heading stays inside it", async () => {
  const t = `## Summary\n${words(100)}\n## Not Listed\n${words(80)}\n## Professional Skills\n${words(180)}\n## Soft Skills\n${words(180)}\n`;
  assert.equal((await sw(t)).verdict, "green"); // 100 + 80 + 3 heading words = 183 in Summary
  assert.equal((await sw(t, 100)).verdict, "red");
});

test("sectionWords: a MISSING listed section is not measured here (fwdloop reds it in its separate sections check)", async () => {
  const noSoft = `## Summary\n${words(180)}\n## Professional Skills\n${words(180)}\n`;
  assert.equal((await sw(noSoft)).verdict, "green");
  const both = await run([
    { id: "order", rule: "sectionOrder", field: "text", names: SECTIONS },
    { id: "sw", rule: "sectionWords", field: "text", names: SECTIONS, wordsPerSection: 180 },
  ], noSoft);
  assert.equal(both.verdict, "red");
  assert.deepEqual(both.gaps.map((g) => g.check), ["sectionOrder"]);
});

test("sectionWords: an out-of-order listed heading is not measured and does not bound the section it sits inside (fwdloop's starts list)", async () => {
  const t = `## A\n${words(100)}\n## B\n${words(80)}\n## C\n${words(180)}\n`;
  assert.equal((await sw(t, 180, ["a", "c", "b"])).verdict, "green"); // b is out of order: A runs to C = 100 + 80 + 1 heading word
  assert.equal((await sw(t, 180, ["a", "b", "c"])).verdict, "red"); // in order: A = 100
});

test("sectionWords: headings are the forgiving ones (case, '#', trailing ':', bare line)", async () => {
  const t = `summary\n${words(180)}\nPROFESSIONAL SKILLS:\n${words(180)}\n### Soft Skills\n${words(180)}`;
  assert.equal((await sw(t)).verdict, "green");
});

test("sectionWords: several sections out of band give one gap each, in signed order, rendered joined by '; '", async () => {
  const r = await sw(doc(10, 180, 500));
  assert.deepEqual(r.gaps.map((g) => g.section), ["summary", "soft skills"]);
  assert.equal(renderGaps(r.gaps), "summary: 10 words, about 180 asked (144-216); soft skills: 500 words, about 180 asked (144-216)");
});

test("sectionWords: gaps are bounded (20) with itemsTotal; signed section names are never clipped", async () => {
  const names = Array.from({ length: 30 }, (_, i) => `s${i}`);
  const text = names.map((n) => `## ${n}\nx`).join("\n");
  const r = await sw(text, 100, names);
  assert.equal(r.gaps.length, 20);
  assert.ok(r.gaps.every((g) => g.itemsTotal === 30));
  const long = "n".repeat(500);
  const r2 = await sw(`## ${long}\nx`, 100, [long]);
  assert.equal(r2.gaps[0].section, long);
  assert.equal(renderGaps(r2.gaps), `${long}: 1 words, about 100 asked (80-120)`);
});

test("sectionWords: non-string / missing field is red like other text rules; never throws", async () => {
  assert.equal((await run([{ id: "sw", rule: "sectionWords", field: "body", names: ["a"], wordsPerSection: 5 }], { text: "x" })).gaps[0].kind, "missing");
  assert.equal((await run([{ id: "sw", rule: "sectionWords", field: "text", names: ["a"], wordsPerSection: 5 }], { text: 7 })).gaps[0].kind, "wrong-type");
});

test("sectionWords: createRubric validation", () => {
  const base = { id: "sw", rule: "sectionWords", field: "text", names: ["a"], wordsPerSection: 5 };
  assert.doesNotThrow(() => mk([base]));
  for (const bad of [
    { wordsPerSection: 0 }, { wordsPerSection: -3 }, { wordsPerSection: 1.5 }, { wordsPerSection: "5" }, { wordsPerSection: undefined },
    { names: [] }, { names: [" "] }, { names: [5] }, { names: ["Summary:"] }, { names: undefined },
    { field: undefined }, { strict: true }, { value: 3 },
  ]) {
    assert.throws(() => mk([{ ...base, ...bad }]), /invalid rubric/, JSON.stringify(bad));
  }
});

// ---- allowedKeys ----

const ak = (output, keys = ["text"]) => run([{ id: "ak", rule: "allowedKeys", keys }], output);

test("allowedKeys: fwdloop's extra-key test — an extra key (lines) is red by name even when the text is fine; absent is green", async () => {
  const r = await ak({ text: "hello", lines: ["the real answer"] });
  assert.equal(r.verdict, "red");
  assert.deepEqual(
    { kind: r.gaps[0].kind, keys: r.gaps[0].keys, allowed: r.gaps[0].allowed },
    { kind: "extra-keys", keys: ["lines"], allowed: ["text"] },
  );
  assert.equal(renderGaps(r.gaps), 'artifact has key(s) "lines" besides "text"; the check reads "text" only, so put the whole answer in "text"');
  assert.match(renderGaps(r.gaps), /"lines"/);
  assert.equal((await ak({ text: "hello" })).verdict, "green");
});

test("allowedKeys: multiple extras are all named, in the output's insertion order (as fwdloop's Object.keys)", async () => {
  const r = await ak({ zeta: 1, text: "t", alpha: 2, mid: 3 });
  assert.deepEqual(r.gaps[0].keys, ["zeta", "alpha", "mid"]);
  assert.equal(renderGaps(r.gaps), 'artifact has key(s) "zeta", "alpha", "mid" besides "text"; the check reads "text" only, so put the whole answer in "text"');
});

test("allowedKeys: a multi-key signed list renders every allowed key", async () => {
  const r = await ak({ text: "t", note: "n", lines: [] }, ["text", "note"]);
  assert.equal(r.verdict, "red");
  assert.deepEqual(r.gaps[0].allowed, ["text", "note"]);
  assert.equal(renderGaps(r.gaps), 'artifact has key(s) "lines" besides "text", "note"; the check reads "text", "note" only, so put the whole answer in "text", "note"');
  assert.equal((await ak({ note: "n" }, ["text", "note"])).verdict, "green"); // allowed is a ceiling, not a requirement
});

test("allowedKeys: a plain-string output is the single field `text`", async () => {
  assert.equal((await ak("hello")).verdict, "green");
  assert.equal((await ak("hello", ["body"])).verdict, "red");
});

test("allowedKeys: non-object outputs are red at `happened` (wrong-type), never thrown", async () => {
  for (const o of [null, [], [{ text: "x" }], 5, undefined]) {
    const r = await ak(o);
    assert.equal(r.verdict, "red");
    assert.equal(r.gaps[0].check, "happened");
    assert.equal(r.gaps[0].kind, "wrong-type");
  }
});

test("allowedKeys: keys are exact and case-sensitive; an empty-string and a __proto__ own key are extras", async () => {
  assert.equal((await ak({ Text: "x" })).verdict, "red");
  const o = JSON.parse('{"text":"x","__proto__":1,"":2}');
  const r = await ak(o);
  assert.deepEqual(r.gaps[0].keys, ["__proto__", ""]);
});

test("allowedKeys: output-derived keys are clipped and bounded; the signed allowed list is not", async () => {
  const o = { text: "x" };
  for (let i = 0; i < 25; i++) o[`k${i}`] = 1;
  o["y".repeat(500)] = 1;
  const r = await ak(o);
  assert.equal(r.gaps[0].keys.length, 20);
  assert.equal(r.gaps[0].itemsTotal, 26);
  const r2 = await ak({ ["y".repeat(500)]: 1 });
  assert.equal(r2.gaps[0].keys[0].length, 120);
  const long = "a".repeat(500);
  const r3 = await ak({ b: 1 }, [long]);
  assert.equal(r3.gaps[0].allowed[0], long);
});

test("allowedKeys: a hostile Proxy (throwing ownKeys) is red, never a throw", async () => {
  const p = new Proxy({ text: "x" }, { ownKeys() { throw new Error("boom"); } });
  const r = await ak(p);
  assert.equal(r.verdict, "red");
  assert.equal(r.gaps[0].kind, "unreadable"); // caught by checkStep's own `happened` read
  // a Proxy that survives that first read and throws on the rule's read: red from the rule, not `stopped`
  let n = 0;
  const q = new Proxy({ text: "x" }, { ownKeys(t) { if (++n > 1) throw new Error("boom"); return Reflect.ownKeys(t); } });
  const r2 = await ak(q);
  assert.equal(r2.verdict, "red");
  assert.equal(r2.gaps[0].check, "allowedKeys");
  assert.equal(r2.gaps[0].kind, "unreadable");
});

test("allowedKeys: symbol-keyed and inherited keys are not own string keys (same as fwdloop's Object.keys)", async () => {
  const o = Object.create({ inherited: 1 });
  o.text = "x";
  o[Symbol("s")] = 1;
  assert.equal((await ak(o)).verdict, "green");
});

test("allowedKeys: createRubric validation", () => {
  assert.doesNotThrow(() => mk([{ id: "ak", rule: "allowedKeys", keys: ["text"] }]));
  for (const bad of [
    { keys: [] }, { keys: [""] }, { keys: ["  "] }, { keys: [1] }, { keys: "text" }, { keys: undefined },
    { keys: ["text"], field: "text" }, { keys: ["text"], strict: true }, { keys: ["a".repeat(1001)] },
  ]) {
    assert.throws(() => mk([{ id: "ak", rule: "allowedKeys", ...bad }]), /invalid rubric/, JSON.stringify(bad));
  }
});

test("renderGaps: a malformed section-words / extra-keys gap falls back to the JSON row and never throws", () => {
  const out = renderGaps([
    { key: "cp:a", check: "sectionWords", kind: "section-words", section: "s" },
    { key: "cp:b", check: "allowedKeys", kind: "extra-keys", keys: "lines", allowed: ["text"] },
    { key: "cp:c", check: "allowedKeys", kind: "extra-keys", keys: ["x"], allowed: [] },
    { get kind() { throw new Error("x"); } },
  ]);
  assert.match(out, /^\["cp:a","sectionWords","section-words"/);
  assert.equal(out.split("; ").length, 4);
});

test("vocabulary + signature: both rules are listed, hashed, and changing a field changes the sha", () => {
  const v = rubricVocabulary.rules;
  assert.deepEqual(v.sectionWords.fields.wordsPerSection, { type: "integer", required: true, min: 1, max: null });
  assert.equal(v.sectionWords.fields.names.required, true);
  assert.ok(!("strict" in v.sectionWords.fields));
  assert.deepEqual(Object.keys(v.allowedKeys.fields), ["keys", "text"]);
  assert.match(v.sectionWords.description, /^sectionWords\(/);
  assert.match(v.allowedKeys.description, /^allowedKeys\(/);
  assert.ok(rubricVocabulary.common.rule.enum.includes("sectionWords"));
  assert.ok(rubricVocabulary.common.rule.enum.includes("allowedKeys"));
  const spec = (n, k) => ({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [
    { id: "sw", rule: "sectionWords", field: "text", names: ["a"], wordsPerSection: n },
    { id: "ak", rule: "allowedKeys", keys: k },
  ] } } });
  assert.notEqual(rubricSha(spec(100, ["text"])), rubricSha(spec(101, ["text"])));
  assert.notEqual(rubricSha(spec(100, ["text"])), rubricSha(spec(100, ["text", "x"])));
});

// ---- forgiving list marker (fwd's ask from a live run) ----

const secs = (names, text, strict) =>
  run([{ id: "s", rule: "sections", field: "text", names, ...(strict ? { strict: true } : {}) }], { text });
const green = async (names, text, strict) => (await secs(names, text, strict)).verdict === "green";

test("list marker: numbered headings match the unnumbered section (forgiving)", async () => {
  assert.ok(await green(["Work history"], "## 1. Work History\nx"));
  assert.ok(await green(["Skills"], "## 2) Skills\nx"));
  assert.ok(await green(["Skills"], "## 10. Skills\nx"));
  assert.ok(await green(["How it matches the JD"], "## 1. HOW IT MATCHES THE JD\nx"));
  assert.ok(await green(["Skills"], "## 3.\tSkills:\nx"));
});

test("list marker: strict mode does not strip it", async () => {
  assert.ok(!(await green(["Work history"], "## 1. Work History\nx", true)));
  assert.ok(await green(["Work History"], "## Work History\nx", true));
});

test("list marker: non-markers are left alone", async () => {
  for (const [line, name] of [
    ["## 2024 results", "results"], ["## 1.5 Skills", "Skills"], ["## 1.Work", "Work"],
    ["## a) Skills", "Skills"], ["## **Skills**", "Skills"], ["## ١. Skills", "Skills"],
  ]) assert.ok(!(await green([name], `${line}\nx`)), line);
  assert.ok(await green(["2024 results"], "## 2024 results\nx"));
  assert.ok(await green(["1.5 Skills"], "## 1.5 Skills\nx"));
  assert.ok(await green(["**Skills**"], "## **Skills**\nx"));
});

test("list marker: only ONE marker is stripped", async () => {
  assert.ok(await green(["Skills"], "## 1. Skills\nbody text")); // one marker: stripped
  assert.ok(!(await green(["Skills"], "## 1. 2. Skills\nbody text")));
});

test("list marker: '1.' / '1. ' stay as before (a heading '1.', not empty)", async () => {
  assert.ok(await green(["1."], "## 1.\nx"));
  assert.ok(await green(["1."], "## 1. \nx"));
  assert.ok(await green(["1."], "## 1. :\nx"));
});

test("list marker: a signed name with a marker still matches its own numbered heading", async () => {
  assert.ok(await green(["1. Intro"], "## 1. Intro\nx"));
  assert.ok(await green(["1. Intro"], "## 1. Intro\nx", true));
  assert.ok(await green(["1. Intro"], "## Intro\nx"));
  assert.ok(!(await green(["1. Intro"], "## Intro\nx", true)));
  const r = await run([{ id: "o", rule: "sectionOrder", field: "text", names: ["1. A", "2. B"] }], { text: "## 1. A\n## 2. B\n" });
  assert.equal(r.verdict, "green");
});

test("list marker: sectionWords splits on numbered headings and counts body words only", async () => {
  const t = `## 1. Summary\n${words(180)}\n## 2) Professional Skills\n${words(180)}\n## 3. Soft Skills\n${words(144)}\n`;
  assert.equal((await sw(t)).verdict, "green");
  const bad = `## 1. Summary\n${words(180)}\n## 2) Professional Skills\n${words(180)}\n## 3. Soft Skills\n${words(143)}\n`;
  const r = await sw(bad);
  assert.equal(r.verdict, "red");
  assert.deepEqual(r.gaps.map((g) => [g.section, g.words]), [["soft skills", 143]]);
});
