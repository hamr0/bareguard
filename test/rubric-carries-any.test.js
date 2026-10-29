import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Gate, createRubric, checkStep, renderGaps, rubricVocabulary, rubricSha } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

// carriesAny (RULED #69): an any-of phrase rule on word edges. Cases from fwdloop's POC F98.

const check = (phrases, extra = {}) => ({ id: "k", rule: "carriesAny", field: "body", phrases, ...extra });
const mk = (checks) => createRubric({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks } } });
const run = (phrases, body, extra) => checkStep(mk([check(phrases, extra)]), "a", { body });
const hit = async (phrases, body, extra) => (await run(phrases, body, extra)).verdict === "green";
const refused = (phrases, extra = {}) => {
  try { mk([check(phrases, extra)]); } catch (e) { return e; }
  assert.fail("expected createRubric to refuse");
};

test("word edges: hang vs fwd's real words", async () => {
  for (const t of ["change", "unchanged", "changing", "hanging", "hanger"]) assert.equal(await hit(["hang"], t), false, t);
  for (const t of ["hang-up", "(hang)", "HANG:", "hang", "a hang b", "x\nhang"]) assert.equal(await hit(["hang"], t), true, t);
  assert.equal(await hit(["crash"], "crash2"), false);
  assert.equal(await hit(["crash"], "2crash"), false);
  assert.equal(await hit(["ANR"], "got ANR, then"), true);
  assert.equal(await hit(["hang"], "hang_x"), true, "underscore is not a word character");
  assert.equal(await hit(["hang"], "hang-up2"), true, "no hyphen glue");
  assert.equal(await hit(["1"], "x 1.5"), true, "no digit glue: '.' ends the word");
});

test("any-of: a hit only on the last phrase is green; matched lists the found ones in signed order", async () => {
  const r = await run(["alpha", "beta", "gamma"], "gamma and beta here");
  assert.equal(r.verdict, "green");
  assert.deepEqual(r.full.matched, [{ check: "k", phrases: ["beta", "gamma"] }]);
});

test("multi-word: a space is a whitespace run (newlines too); other characters exact", async () => {
  assert.equal(await hit(["not responding"], "app is not responding."), true);
  assert.equal(await hit(["not responding"], "not respondingly"), false);
  assert.equal(await hit(["not responding"], "not\n  responding"), true);
  assert.equal(await hit(["not responding"], "not\t\r\n responding"), true);
  assert.equal(await hit(["not responding"], "notresponding"), false);
  assert.equal(await hit(["hang-up"], "hang-up"), true);
  assert.equal(await hit(["hang-up"], "hang up"), false, "inner hyphen is exact");
  assert.equal(await hit(["hang-up"], "hang - up"), false);
  assert.equal(await hit(["a b c"], "a  b\n\nc"), true);
  assert.equal(await hit(["a b"], "a.b"), false);
  assert.equal(await hit(["not responding"], "xnot responding"), false, "first char needs a word edge");
});

test("a failed candidate does not hide a later one", async () => {
  assert.equal(await hit(["hang"], "change hang"), true);
  assert.equal(await hit(["not responding"], "not respondingly. not  responding"), true);
});

test("a failed candidate does not hide a later one, strict too (multi-word, both passes)", async () => {
  assert.equal(await hit(["not responding"], "not respondingly. not  responding", { strict: true }), true);
  assert.equal(await hit(["Not Responding"], "Not Respondingly, Not  Responding", { strict: true }), true);
  assert.equal(await hit(["Not Responding"], "Not Respondingly, NOT  Responding", { strict: true }), false, "the later candidate has the wrong case");
});

test("KNOWN behaviour (self-review ledger): final sigma folds by position, so a phrase is not found in text where the sigma is not word-final", async () => {
  // "ΟΔΟΣ".toLowerCase() is "οδος" (final sigma) but inside "ΟΔΟΣ.ΑΒ" the Σ lowers to "σ" ("οδοσ.αβ"). Red none-found today.
  // Pinned as current behaviour, NOT a promise: the fold is deliberately left alone (ledger nit, hamr 2026-10-28).
  assert.equal("ΟΔΟΣ".toLowerCase(), "οδος");
  assert.equal("ΟΔΟΣ.ΑΒ".toLowerCase(), "οδοσ.αβ");
  const r = await run(["ΟΔΟΣ"], "ΟΔΟΣ.ΑΒ");
  assert.equal(r.verdict, "red");
  assert.equal(r.gaps[0].kind, "none-found");
  assert.equal(await hit(["ΟΔΟΣ"], "ΟΔΟΣ"), true);
});

test("case: forgiving folds; strict needs the exact case and is never looser", async () => {
  assert.equal(await hit(["ANR"], "anr"), true);
  assert.equal(await hit(["ANR"], "anr", { strict: true }), false);
  assert.equal(await hit(["ANR"], "ANR", { strict: true }), true);
  assert.equal(await hit(["Not Responding"], "NOT\nRESPONDING", { strict: true }), false);
  // strict is green only where forgiving is green: sweep a small grid
  const phrases = [["ab"], ["a b"], ["Ab c"]];
  const texts = ["ab", "AB", "xab", "ab1", "a  b", "A\nB", "Ab c", "ab  C", "(AB)", "ab-c", "İab", "ab😀", "😀ab", "Ab\tc"];
  for (const p of phrases) for (const t of texts) {
    const f = await hit(p, t);
    const s = await hit(p, t, { strict: true });
    assert.ok(!s || f, `strict green but forgiving red for ${JSON.stringify(p)} on ${JSON.stringify(t)}`);
  }
});

test("case fold changes length: edges are read in the string the match was found in", async () => {
  // "İ".toLowerCase() is 2 code units (i + combining dot, a mark = word char)
  assert.equal("İ".toLowerCase().length, 2);
  assert.equal(await hit(["hang"], "İhang"), false, "a folded İ before the phrase is a word char");
  assert.equal(await hit(["hang"], "hangİ"), false);
  assert.equal(await hit(["hang"], "İ hang İ"), true);
  assert.equal(await hit(["hang"], "İİİİ hang"), true, "indices after several folds stay right");
  assert.equal(await hit(["hang"], "İİİİhang"), false);
  assert.equal(await hit(["i̇stanbul"], "İstanbul"), true);
});

test("astral characters next to a phrase: one code point at a time", async () => {
  assert.equal(await hit(["hang"], "😀hang"), true, "an emoji is not a word char");
  assert.equal(await hit(["hang"], "hang😀"), true);
  assert.equal(await hit(["hang"], "\u{1D7D8}hang"), false, "a mathematical digit (Nd, astral) is a word char");
  assert.equal(await hit(["hang"], "hang\u{1D7D8}"), false);
  assert.equal(await hit(["hang"], "\u{20000}hang"), false, "an astral letter (CJK ext B) is a word char");
  assert.equal(await hit(["hang"], "hang\u{20000}"), false);
  assert.equal(await hit(["hang"], "\uD835hang"), true, "a lone surrogate is not a word char");
});

test("red gap: none-found with the signed list; missing / wrong-type / unreadable keep their kinds", async () => {
  const r = await run(["crash", "hang"], "all fine");
  assert.equal(r.verdict, "red");
  assert.deepEqual(r.gaps, [{ key: "a:k", checkpoint: "a", check: "carriesAny", id: "k", field: "body", kind: "none-found", phrases: ["crash", "hang"] }]);
  assert.deepEqual(r.full.matched, []);
  const rb = mk([check(["x"])]);
  assert.equal((await checkStep(rb, "a", { other: "x" })).gaps[0].kind, "missing");
  assert.equal((await checkStep(rb, "a", { body: 5 })).gaps[0].kind, "wrong-type");
  const hostile = { get body() { throw new Error("no"); } };
  assert.equal((await checkStep(rb, "a", hostile)).gaps[0].kind, "unreadable");
  // mustCarry keeps its released kind
  const mc = createRubric({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [{ id: "m", rule: "mustCarry", field: "body", phrases: ["x"] }] } } });
  assert.equal((await checkStep(mc, "a", { body: "y" })).gaps[0].kind, "missing");
});

test("none-found list is bounded to 20 with itemsTotal; signed phrases ride unclipped", async () => {
  const mkList = (n) => Array.from({ length: n }, (_, i) => `word${i}`);
  const r20 = await run(mkList(20), "nothing");
  assert.equal(r20.gaps[0].phrases.length, 20);
  assert.equal("itemsTotal" in r20.gaps[0], false);
  const r21 = await run(mkList(21), "nothing");
  assert.equal(r21.gaps[0].phrases.length, 20);
  assert.equal(r21.gaps[0].itemsTotal, 21);
  assert.deepEqual(r21.gaps[0].phrases, mkList(21).slice(0, 20));
  const long = "a".repeat(200);
  assert.equal((await run([long], "z")).gaps[0].phrases[0], long);
});

test("renderGaps: exact sentence, escaping, and ' and N more'", async () => {
  const r = await run(["crash", "hang"], "ok");
  assert.equal(renderGaps(r.gaps), 'none of these words appear in "body": "crash", "hang"');
  const q = await run(['say "hi" \\ x'], "ok");
  assert.equal(renderGaps(q.gaps), 'none of these words appear in "body": "say \\"hi\\" \\\\ x"');
  const rb = createRubric({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [{ ...check(["x"]), field: 'we"ird' }] } } });
  assert.equal(renderGaps((await checkStep(rb, "a", { 'we"ird': "q" })).gaps), 'none of these words appear in "we\\"ird": "x"');
  const many = await run(Array.from({ length: 23 }, (_, i) => `w${i}`), "nothing");
  const out = renderGaps(many.gaps);
  assert.ok(out.startsWith('none of these words appear in "body": "w0", "w1"'));
  assert.ok(out.endsWith('"w19" and 3 more'), out);
  assert.equal(renderGaps(await (async () => (await run(["a"], "b")).gaps)()), 'none of these words appear in "body": "a"');
});

test("createRubric refusals carry the exact e.path", () => {
  const P = "spec.checkpoints.a.checks[0].phrases";
  assert.equal(refused([]).path, P);
  assert.equal(refused(Array.from({ length: 51 }, (_, i) => `w${i}`)).path, P);
  assert.doesNotThrow(() => mk([check(Array.from({ length: 50 }, (_, i) => `w${i}`))]));
  assert.equal(refused(["ok", "a".repeat(201)]).path, `${P}[1]`);
  assert.doesNotThrow(() => mk([check(["a".repeat(200)])]));
  assert.equal(refused(["ok", "  "]).path, `${P}[1]`);
  assert.equal(refused(["ok", ""]).path, `${P}[1]`);
  assert.equal(refused(["ok", 5]).path, `${P}[1]`);
  assert.equal(refused("hang").path, P);
  for (const bad of ["-hang", "hang-", " hang", "hang ", "(hang)", "hang.", "_a", "a_", "a b-", "😀a", "a😀"]) assert.equal(refused(["ok", "x", bad]).path, `${P}[2]`, bad);
  for (const bad of ["a\tb", "a\nb", "a b", "a  b", "a\r\nb", "a b"]) assert.equal(refused(["ok", "x", bad]).path, `${P}[2]`, JSON.stringify(bad));
  assert.equal(refused(["Hang", "x", "hang"]).path, P, "case-fold duplicate");
  assert.equal(refused(["İ1", "i̇1"]).path, P, "fold duplicate beyond ASCII");
  assert.doesNotThrow(() => mk([check(["hang-up", "not responding", "ANR", "crash2", "日本語", "\u{20000}a"])]));
  assert.equal(refused(["x"], { strict: "yes" }).path, "spec.checkpoints.a.checks[0].strict");
  assert.equal(refused(["x"], { bogus: 1 }).path.endsWith("bogus"), true);
});

test("full.matched: always present, signed order, bounded to 20 with phrasesTotal", async () => {
  const none = await checkStep(mk([{ id: "n", rule: "nonEmpty", field: "body" }]), "a", { body: "x" });
  assert.deepEqual(none.full.matched, []);
  assert.ok(Object.isFrozen(none.full.matched));
  const shaped = await checkStep(createRubric({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [] } } }), "a", "text");
  assert.deepEqual(shaped.full.matched, []);
  const bad = await checkStep(mk([check(["x"])]), "a", 5);
  assert.deepEqual(bad.full.matched, [], "a shape-gap output still has the array");
  const list = Array.from({ length: 25 }, (_, i) => `w${i}`);
  const r = await run(list, list.slice().reverse().join(" "));
  assert.equal(r.full.matched[0].phrases.length, 20);
  assert.deepEqual(r.full.matched[0].phrases, list.slice(0, 20), "signed order, not text order");
  assert.equal(r.full.matched[0].phrasesTotal, 25);
  const r20 = await run(list.slice(0, 20), list.join(" "));
  assert.equal("phrasesTotal" in r20.full.matched[0], false);
});

test("full.matched: a green check gets an entry even when another check is red; a red check gets none", async () => {
  const rb = mk([
    { id: "g1", rule: "carriesAny", field: "body", phrases: ["hang", "crash"] },
    { id: "r1", rule: "carriesAny", field: "body", phrases: ["nope"] },
    { id: "g2", rule: "carriesAny", field: "body", phrases: ["ANR"] },
    { id: "m", rule: "maxWords", field: "body", value: 1 },
  ]);
  const r = await checkStep(rb, "a", { body: "a hang and ANR" });
  assert.equal(r.verdict, "red");
  assert.deepEqual(r.full.matched, [{ check: "g1", phrases: ["hang"] }, { check: "g2", phrases: ["ANR"] }]);
  assert.deepEqual(r.gaps.map((g) => g.id), ["r1", "m"]);
});

test("rubricSha of an existing spec is unchanged; the new rule is a signed change", () => {
  const old = { schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [
    { id: "m", rule: "mustCarry", field: "text", phrases: ["hang", "crash"] },
    { id: "b", rule: "blockLines", field: "text", size: 2, phrases: ["x"] },
  ] } } };
  // computed with the code BEFORE #69 (HEAD 92a0865) on exactly this spec
  assert.equal(rubricSha(old), "598af74fa93da001bc375c351046eb0137e5bb053c249f07c04bdb70a000dca3");
  const withNew = JSON.parse(JSON.stringify(old));
  withNew.checkpoints.a.checks.push({ id: "c", rule: "carriesAny", field: "text", phrases: ["hang"] });
  assert.notEqual(rubricSha(withNew), rubricSha(old));
});

test("rubricVocabulary lists carriesAny; the description is generated", () => {
  const v = rubricVocabulary.rules.carriesAny;
  assert.ok(rubricVocabulary.common.rule.enum.includes("carriesAny"));
  assert.deepEqual(Object.keys(v.fields).sort(), ["field", "phrases", "strict", "text"]);
  assert.equal(v.fields.phrases.maxItems, 50);
  assert.equal(v.fields.phrases.itemMaxLength, 200);
  assert.match(v.description, /^carriesAny\(\{ id, field: .*phrases: non-empty list \(max 50\)/);
  assert.equal(rubricVocabulary.rules.mustCarry.fields.phrases.maxItems, undefined, "mustCarry is unchanged");
});

// --- performance: linear-ish, no regex built from signed input. Growth-ratio checks, generous margins. ---

async function timeOf(fn) {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
// min of a few runs: load spikes only add time
async function best(fn, n = 3) {
  let m = Infinity;
  for (let i = 0; i < n; i++) m = Math.min(m, await timeOf(fn));
  return m;
}

test("perf: a long whitespace run and near-miss floods grow about linearly (ratio check)", async () => {
  const cases = [
    (n) => ({ phrase: "a b", text: "a" + " ".repeat(n) + "c" }),
    (n) => ({ phrase: "a a a a a b", text: "a ".repeat(n) + "c" }),
    (n) => ({ phrase: "a b", text: "a".repeat(n) }),
    (n) => ({ phrase: "hang", text: "hang".repeat(n) }),
    (n) => ({ phrase: "a  b".replace("  ", " "), text: ("a" + " ".repeat(50)).repeat(Math.floor(n / 50)) + "c" }),
  ];
  for (const [i, mkCase] of cases.entries()) {
    const small = mkCase(100_000);
    const big = mkCase(400_000);
    const rb = mk([check([small.phrase])]);
    const ts = await best(() => checkStep(rb, "a", { body: small.text }));
    const tb = await best(() => checkStep(rb, "a", { body: big.text }));
    // 4x the input; a quadratic path would be ~16x. Allow 10x plus a floor for timer noise.
    assert.ok(tb < Math.max(ts * 10, 400), `case ${i}: ${ts.toFixed(1)}ms -> ${tb.toFixed(1)}ms`);
  }
});

test("perf: 50 phrases over a 1 MiB field stay well under a generous bound", async () => {
  const phrases = Array.from({ length: 50 }, (_, i) => `near${i} miss`);
  const text = "near1 ".repeat(170_000);
  const rb = mk([check(phrases)]);
  const t = await best(() => checkStep(rb, "a", { body: text }), 2);
  assert.ok(t < 8_000, `${t.toFixed(0)}ms (bound 8000; about 1.3-1.9 s on a loaded dev machine: 50 linear scans of 1 MiB; the native-indexOf matcher before amendment 3 took ~0.1 s here)`);
});

// --- gate: matched rides the result only -------------------------------------------------------

test("gate.checkStep: matched is on the result, absent from the audit line and the human ask", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const spec = { schema: 1, goal: "g", checkpoints: { a: { gating: true, requiresHuman: true, checks: [
    check(["SECRETWORD-ONE", "SECRETWORD-TWO"].map((s) => s.toLowerCase())),
    { id: "bad", rule: "carriesAny", field: "body", phrases: ["nopeSIGNED"] },
  ] }, b: { gating: true, requiresHuman: true, checks: [check(["secretword-one"])] } } };
  const asks = [];
  const g = new Gate({ audit: { path: auditPath }, runId, rubric: { spec, sha256: rubricSha(spec), advanceOn: ["done"] }, humanChannel: async (ev) => { asks.push(JSON.stringify(ev)); return { decision: "allow" }; } });
  await g.init();
  const red = await g.checkStep("a", { body: "has secretword-one in it" });
  assert.equal(red.verdict, "red");
  assert.deepEqual(red.full.matched, [{ check: "k", phrases: ["secretword-one"] }]);
  const green = await g.checkStep("b", { body: "has secretword-one in it" }, { outputBytes: "bytes-b" });
  assert.equal(green.verdict, "green");
  assert.deepEqual(green.full.matched, [{ check: "k", phrases: ["secretword-one"] }]);
  const d = await g.check({ type: "done", checkpoint: "b", outputSha: green.outputSha });
  assert.equal(d.outcome, "allow", JSON.stringify(d));
  assert.equal(asks.length, 1, "the live ask happened");
  assert.ok(!asks[0].includes("matched"), "no matched in the human ask");
  const raw = fs.readFileSync(auditPath, "utf8");
  assert.ok(!raw.includes('"matched"'), "no matched key in the audit");
  const rubricLines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.phase === "rubric");
  assert.equal(rubricLines.length, 2);
  // the none-found gap (phrases) is a worker gap and does appear in the red audit line
  assert.ok(rubricLines[0].gaps[0].phrases.includes("nopeSIGNED"));
  assert.deepEqual(g.drainGaps()[0].phrases, ["nopeSIGNED"], "the worker keeps the phrase list");
});

// --- amendment 3: normalize once, KMP, no cap (RULED #69) ----------------------------------------------------------

const kindOf = (r) => r.gaps[0]?.kind ?? null;
const WS = [" ", " ", " ", "\t", "\r\n", "\n\n", "    ", " ", "﻿"];

test("no cap in the vocabulary, no top-level export, no too-many kind for carriesAny", async () => {
  assert.equal("carriesAnyWorkMax" in rubricVocabulary.bounds, false);
  const top = await import("../src/index.js");
  assert.ok(!Object.keys(top).some((k) => /work|cap/i.test(k)), "no cap constant is exported");
  const r = await run(["a b"], "a ".repeat(200_000));
  assert.equal(kindOf(r), "none-found");
});

test("collapse equivalence: a phrase space matches ANY whitespace run, whatever the run is made of", async () => {
  for (const w of WS) {
    assert.equal(await hit(["not responding"], `app is not${w}responding.`), true, JSON.stringify(w));
    assert.equal(await hit(["not responding"], `app is not${w}${w}${w}responding.`, { strict: true }), true, JSON.stringify(w) + " x3 strict");
    assert.equal(await hit(["a b c"], `a${w}b${w}${w}c`), true, JSON.stringify(w) + " three words");
    assert.equal(await hit(["a b"], `ab`), false);
    assert.equal(await hit(["a b"], `a${w}x${w}b`), false, "a word between is not a gap");
  }
  assert.equal(await hit(["a b"], `a${" ".repeat(5000)}b`), true, "a very long run");
  assert.equal(await hit(["a b"], `a${"  \t\n".repeat(5000)}b`), true, "a very long mixed run");
});

test("edges next to collapsed runs: a run is a non-word on either side, and word characters still glue", async () => {
  for (const w of WS) {
    assert.equal(await hit(["hang"], `x${w}${w}hang${w}${w}y`), true, JSON.stringify(w));
    assert.equal(await hit(["hang"], `${w}hang${w}`), true, "run at the text edges");
    assert.equal(await hit(["hang"], `hang`), true);
    assert.equal(await hit(["not responding"], `not${w}respondingly`), false, "after-edge next to a word");
    assert.equal(await hit(["not responding"], `xnot${w}responding`), false, "before-edge next to a word");
    assert.equal(await hit(["not responding"], `not${w}${w}responding${w}${w}ly`), true, "a run after the phrase is an edge");
  }
  assert.equal(await hit(["b"], "a  b  c"), true);
  assert.equal(await hit(["b c"], "ab  c"), false, "the run is collapsed, the glue before b is not");
  assert.equal(await hit(["a b"], "a   b2"), false);
});

test("collapse after lowering: İ (i + U+0307), final sigma and surrogate pairs sit next to runs unharmed", async () => {
  assert.equal(await hit(["İ x"], "İ  x"), true);
  assert.equal(await hit(["İ x"], "i̇ x"), true, "İ in the phrase is i + U+0307 in the lowered text");
  assert.equal(await hit(["x İ"], "x \n İ"), true);
  assert.equal(await hit(["x İ"], "x \n İtalic"), false, "a letter after İ glues");
  assert.equal(await hit(["x i"], "x i̇"), false, "U+0307 is a mark: a word character, so 'i' does not end on an edge");
  // astral letters and digits are word characters, whole code points, also beside a run
  assert.equal(await hit(["a b"], "a  b\u{1D400}"), false);
  assert.equal(await hit(["a b"], "\u{1D400}a  b"), false);
  assert.equal(await hit(["a b"], "\u{1D7CE}a b"), false, "mathematical digit zero glues");
  assert.equal(await hit(["a b"], "\u{1F600}a  b\u{1F600}"), true, "an emoji is not a word character");
  assert.equal(await hit(["\u{1D400} b"], "x \u{1D400} b"), true);
  assert.equal(await hit(["ß x"], "ß  X"), true);
  assert.equal(await hit(["ß x"], "ß  X", { strict: true }), false, "strict is exact case");
});

test("KMP: overlapping candidates are all tried, and a failed one never hides a later one", async () => {
  assert.equal(await hit(["a-a"], "xa-a-a"), true, "the first match fails its left edge, the overlapping one succeeds");
  assert.equal(await hit(["aa"], "aaa"), false);
  assert.equal(await hit(["aba"], "ababa"), false);
  assert.equal(await hit(["aba"], "ababa aba"), true);
  assert.equal(await hit(["aab"], "aaab"), false, "the match starts glued to an 'a'");
  assert.equal(await hit(["a a b"], "a a a b"), true, "the partial match restarts from the failure link");
  assert.equal(await hit(["a a b"], "x a a a b"), true);
  assert.equal(await hit(["ab ab c"], "ab ab ab c"), true);
  assert.equal(await hit(["ab ab c"], "ab ab ab d"), false);
  assert.equal(await hit(["aaaa b"], "a".repeat(30) + " aaaa b"), true, "the run of a's ends before the space");
  assert.equal(await hit(["aaaa b"], "a".repeat(30) + "aaaa b"), false, "glued to a longer run of a's");
  assert.equal(await hit(["aaaa b"], "a".repeat(30) + " aaaa b", { strict: true }), true);
  assert.equal(await hit(["aaaa b"], "a".repeat(30) + " aaaa  bc"), false, "after-edge");
  assert.equal(await hit(["aaaa b"], "a".repeat(30) + "-aaaa b"), true);
});

test("matched is complete: every signed phrase found, in signed order, bounded 20 + phrasesTotal, on a body that used to hit the cap", async () => {
  const phrases = Array.from({ length: 30 }, (_, i) => "w" + i + " z");
  const body = phrases.map((p) => p.replace(" ", "  ")).reverse().join(" ") + " " + "a ".repeat(50_000);
  const r = await run(phrases, body);
  assert.equal(r.verdict, "green");
  assert.deepEqual(r.full.matched, [{ check: "k", phrases: phrases.slice(0, 20), phrasesTotal: 30 }]);
  const some = await run(["q q", "w3 z", "nope", "w7 z"], body);
  assert.deepEqual(some.full.matched, [{ check: "k", phrases: ["w3 z", "w7 z"] }]);
  // after a hit, a later phrase is still searched on the huge body (this used to be cut by the cap)
  const late = await run(["hit", "a b", "a c", "a d", "zzz"], "hit " + "a ".repeat(100_000) + "zzz", { strict: true });
  assert.deepEqual(late.full.matched, [{ check: "k", phrases: ["hit", "zzz"] }]);
});

// Differential oracle: the pre-cap matcher (commit 10b9460) verbatim, native indexOf + per-unit whitespace walk.
const OWORD = /^[\p{L}\p{M}\p{Nd}]$/u;
const oWordAt = (t, i) => i >= 0 && i < t.length && OWORD.test(String.fromCodePoint(t.codePointAt(i)));
function oEnds(t, e) {
  if (e < 1) return false;
  const u = t.charCodeAt(e - 1);
  const low = u >= 0xdc00 && u <= 0xdfff && e >= 2 && t.charCodeAt(e - 2) >= 0xd800 && t.charCodeAt(e - 2) <= 0xdbff;
  return oWordAt(t, low ? e - 2 : e - 1);
}
function oEdges(t, words) {
  const w0 = words[0];
  for (let i = t.indexOf(w0); i !== -1; i = t.indexOf(w0, i + 1)) {
    if (oEnds(t, i)) continue;
    let pos = i + w0.length;
    let ok = true;
    for (let j = 1; j < words.length; j++) {
      const from = pos;
      while (pos < t.length && /^\s$/.test(t[pos])) pos++;
      if (pos === from || !t.startsWith(words[j], pos)) { ok = false; break; }
      pos += words[j].length;
    }
    if (ok && !oWordAt(t, pos)) return true;
  }
  return false;
}
const oracle = (text, phrases, strict) => {
  const lower = text.toLowerCase();
  return phrases.filter((p) => oEdges(lower, p.toLowerCase().split(" ")) && (!strict || oEdges(text, p.split(" "))));
};

test("differential fuzz against the pre-cap matcher (10b9460): same verdict, same matched list", async () => {
  let seed = 20261029;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const tok = ["İ", "i̇", "i", "I", "ß", "σ", "Σ", "ς", "a", "A", "b", "1", "_", "-", "'", "\u{1D400}", "\u{10400}", "\u{1D7CE}", "é"];
  let ran = 0;
  for (let it = 0; it < 2500; it++) {
    const strict = rnd() < 0.5;
    const phrases = [];
    for (let k = 0, n = 1 + Math.floor(rnd() * 5); k < n; k++) {
      const ph = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(tok)).join("")).join(" ");
      if (/^[\p{L}\p{Nd}]/u.test(ph) && /[\p{L}\p{Nd}]$/u.test(ph) && !phrases.some((q) => q.toLowerCase() === ph.toLowerCase())) phrases.push(ph);
    }
    if (!phrases.length) continue;
    const body = Array.from({ length: Math.floor(rnd() * 30) }, () => (rnd() < 0.15 ? pick(phrases).split(" ").join(pick(WS)) : rnd() < 0.4 ? pick(WS) : pick(tok))).join("");
    const r = await run(phrases, body, { strict });
    const exp = oracle(body, phrases, strict);
    assert.equal(r.verdict, exp.length ? "green" : "red", JSON.stringify({ body, phrases, strict }));
    assert.deepEqual(r.full.matched[0]?.phrases ?? [], exp, JSON.stringify({ body, phrases, strict }));
    ran++;
  }
  assert.ok(ran > 2000, `ran ${ran}`);
});

// --- cost: linear for any input, no cap. Each family below was a slow or capped one in the self-reviews. -------------

const P = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const timed = async (phrases, body, strict) => {
  const t0 = process.hrtime.bigint();
  const r = await run(phrases, body, { strict });
  return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
};

test("adversarial families are linear and none-found (never too-many)", async () => {
  const wsUnit = (w) => "a" + w.repeat(200);
  const fams = [
    ["50 near-miss 98-word phrases over 200 KB 'a '", P(50, (i) => "a ".repeat(97) + "b" + i), "a ".repeat(100_000)],
    ["50 'a' x (148 + i) + ' b' over 200K 'a'", P(50, (i) => "a".repeat(148 + i) + " b"), "a".repeat(200_000)],
    ...[" ", " ", " "].map((w) => [`98-word near-miss over a + ${JSON.stringify(w)} x 200`, P(50, (i) => "a ".repeat(97) + "b" + i), wsUnit(w).repeat(Math.ceil(82_812 / 201)).slice(0, 82_812)]),
    ["'a' / 'a x<i>' over 'éa ' to 600K", ["a", ...P(49, (i) => "a x" + i)], "éa ".repeat(200_000)],
  ];
  for (const [fi, [name, phrases, body]] of fams.entries()) for (const strict of fi === 0 ? [false, true] : [false]) { // strict repeats the forgiving pass when nothing is found
    const { r, ms } = await timed(phrases, body, strict);
    assert.equal(kindOf(r), "none-found", `${name} strict=${strict}`);
    assert.ok(ms < 20_000, `${name} strict=${strict}: ${ms.toFixed(0)}ms`);
  }
});

test("growth ratio: doubling a whitespace-flood body roughly doubles the time", async () => {
  const phrases = P(20, (i) => "a ".repeat(97) + "b" + i);
  const body = (n) => ("a" + "   \n".repeat(50)).repeat(Math.ceil(n / 201)).slice(0, n);
  const best = async (n) => {
    let m = Infinity;
    for (let i = 0; i < 3; i++) m = Math.min(m, (await timed(phrases, body(n), false)).ms);
    return m;
  };
  await best(20_000); // warm
  const t1 = await best(200_000);
  const t2 = await best(400_000);
  assert.ok(t2 / t1 < 4, `400K took ${t2.toFixed(0)}ms vs ${t1.toFixed(0)}ms for 200K (ratio ${(t2 / t1).toFixed(2)}, linear is ~2, quadratic ~4+)`);
  assert.ok(t2 < 20_000, `${t2.toFixed(0)}ms`);
});
