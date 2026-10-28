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
  assert.ok(t < 5000, `${t.toFixed(0)}ms`);
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

// --- work cap (RULED #69 amendment 1): a step counter, no clock -------------------------------------------------
// Steps: one per candidate position (each indexOf hit of the first word), one per later word compared, one per whitespace
// unit skipped. Both passes, all phrases, one budget per check. Over it = red too-many { limit }.

const CAP = rubricVocabulary.bounds.carriesAnyWorkMax;
const kindOf = (r) => r.gaps[0]?.kind ?? null;

test("work cap: the bound is exposed in rubricVocabulary.bounds, not as a top-level export", async () => {
  assert.equal(CAP, 10_000_000);
  const top = await import("../src/index.js");
  assert.ok(!Object.keys(top).some((k) => /work|cap/i.test(k)), "no cap constant is exported");
});

test("work cap boundary: phrase 'a b' on 'a' x n costs exactly n+1 steps; cap steps pass, cap+1 is red too-many", async () => {
  const atCap = await run(["a b"], "a".repeat(CAP - 1));
  assert.equal(kindOf(atCap), "none-found", "exactly CAP steps never trips");
  const over = await run(["a b"], "a".repeat(CAP));
  assert.equal(over.verdict, "red");
  assert.deepEqual(over.gaps, [{ key: "a:k", checkpoint: "a", check: "carriesAny", id: "k", field: "body", kind: "too-many", limit: CAP }]);
  assert.deepEqual(over.full.matched, []);
});

test("work cap guarantee: 3 x field length x total phrase words <= cap never trips, whatever the body", async () => {
  // 1 phrase of 98 words, near-miss flood, forgiving and strict
  const p98 = "a ".repeat(97) + "b";
  const L98 = Math.floor(CAP / 3 / 98);
  for (const strict of [false, true]) {
    const r = await run([p98], "a ".repeat(Math.floor(L98 / 2)), { strict });
    assert.equal(kindOf(r), "none-found", `98 words, strict=${strict}`);
  }
  // fwdloop's shape: 12 phrases of 2 words on a 120,000-char body (10x their real 12K), every word a first-word candidate
  const twelve = Array.from({ length: 12 }, (_, i) => `a b${i}`);
  assert.ok(3 * 120_000 * 24 <= CAP);
  const bodies = ["a ".repeat(60_000), "a".repeat(120_000), "a  ".repeat(40_000), ("a" + " ".repeat(9)).repeat(12_000), "A ".repeat(60_000), "a\n".repeat(60_000), "a-".repeat(60_000)];
  for (const strict of [false, true]) for (const [i, body] of bodies.entries()) {
    const r = await run(twelve, body, { strict });
    assert.equal(r.gaps[0]?.kind, "none-found", `body ${i} strict=${strict}`);
  }
  // forgiving hits at the very end, the raw (strict) pass then re-walks the whole body for every phrase
  const hitsAtEnd = Array.from({ length: 12 }, (_, i) => (i === 11 ? "a b" : `a b${i}`));
  const r = await run(hitsAtEnd, "a ".repeat(59_999) + "A B", { strict: true });
  assert.equal(kindOf(r), "none-found");
  const g = await run(hitsAtEnd, "a ".repeat(59_999) + "a b", { strict: true });
  assert.equal(g.verdict, "green");
});

test("work cap: the 47 s case (50 legal 98-word near-miss phrases over 200 KB) is red too-many, and fast", async () => {
  const phrases = Array.from({ length: 50 }, (_, i) => "a ".repeat(97) + "b" + i);
  const body = "a ".repeat(100_000);
  for (const strict of [false, true]) {
    const t0 = process.hrtime.bigint();
    const r = await run(phrases, body, { strict });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(kindOf(r), "too-many", `strict=${strict}`);
    assert.equal(r.gaps[0].limit, CAP);
    assert.ok(ms < 5000, `${ms.toFixed(0)}ms (was 47-72 s; ~0.2 s unloaded)`);
  }
});

test("work cap is per check, shared by every phrase: two phrases that each fit alone trip together", async () => {
  const body = "a ".repeat(2_000_000); // ~6M steps per near-miss phrase
  assert.equal(kindOf(await run(["a b"], body)), "none-found");
  assert.equal(kindOf(await run(["a c"], body)), "none-found");
  const both = await run(["a b", "a c"], body);
  assert.equal(kindOf(both), "too-many");
});

test("work cap: strict mode counts the raw pass too", async () => {
  // forgiving walks ~6M steps then hits at the end; the raw pass walks ~6M more and finds nothing ("A B" is the wrong case)
  const body = "a ".repeat(2_000_000) + "A B";
  const f = await run(["a b"], body);
  assert.equal(f.verdict, "green");
  const s = await run(["a b"], body, { strict: true });
  assert.equal(kindOf(s), "too-many");
});

test("work cap: a hit found before the cap is green, matched keeps found phrases in signed order; a hit after the cap is never reached", async () => {
  const body = "hit " + "a ".repeat(2_000_000);
  const g = await run(["hit", "a b", "a c"], body);
  assert.equal(g.verdict, "green", "green stays green when the budget runs out on a later phrase");
  assert.deepEqual(g.full.matched, [{ check: "k", phrases: ["hit"] }]);
  assert.deepEqual(g.gaps, []);
  const late = await run(["a b", "a c", "hit"], body);
  assert.equal(kindOf(late), "too-many", "signed order: phrases after the cap are not searched");
  assert.deepEqual(late.full.matched, []);
});

test("work cap: renderGaps exact sentence; other too-many gaps keep their JSON row", async () => {
  const over = await run(["a b"], "a".repeat(CAP));
  assert.equal(renderGaps(over.gaps), `"body" is too large to check for these words (work limit ${CAP})`);
  assert.equal(renderGaps(over.gaps), '"body" is too large to check for these words (work limit 10000000)');
  const rb = createRubric({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [{ ...check(["a b"]), field: 'we"ird' }] } } });
  const odd = await checkStep(rb, "a", { 'we"ird': "a".repeat(CAP) });
  assert.equal(renderGaps(odd.gaps), `"we\\"ird" is too large to check for these words (work limit ${CAP})`);
  // a hand-built gap of another rule is not rendered as this sentence
  assert.equal(renderGaps([{ key: "a:c", check: "cited", kind: "too-many", field: "x", measured: 30, limit: 25 }]), JSON.stringify(["a:c", "cited", "too-many", "x", 30, 25, null, null, null]));
});

test("work cap through gate.checkStep: the too-many gap reaches the worker and the audit line", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const phrases = Array.from({ length: 50 }, (_, i) => "a ".repeat(97) + "b" + i);
  const spec = { schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [check(phrases)] } } };
  const g = new Gate({ audit: { path: auditPath }, runId, rubric: { spec, sha256: rubricSha(spec), advanceOn: ["done"] }, humanChannel: async () => ({ decision: "allow" }) });
  await g.init();
  const r = await g.checkStep("a", { body: "a ".repeat(100_000) });
  assert.equal(r.verdict, "red");
  assert.equal(r.gaps[0].kind, "too-many");
  assert.equal(r.gaps[0].limit, CAP);
  const line = fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.phase === "rubric");
  assert.equal(line.gaps[0].kind, "too-many");
  assert.equal(line.gaps[0].limit, CAP);
  assert.equal(line.gaps[0].field, "body");
  const drained = g.drainGaps();
  assert.equal(drained[0].kind, "too-many");
  assert.equal(drained[0].limit, CAP);
});
