import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Gate, createRubric, checkStep, rubricSha } from "../src/index.js";
import { normalizeForQuote, carries } from "../src/primitives/rubric.js";
import { decideQuote } from "../src/primitives/rubric-locate.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

// Evidence spans (docs/product/rubric-prd.md §4.6, RULED #66): `full.evidence`, where a `cited` check with `decides` read.

const sha = (s) => createHash("sha256").update(s).digest("hex");

function spec(source, decides, id = "c") {
  return {
    schema: 1,
    goal: "g",
    inputs: [{ name: "offers", sha256: sha(source) }],
    checkpoints: { cp: { gating: true, checks: [{ id, rule: "cited", claims: "claims", source: "offers", ...(decides ? { decides } : {}) }] } },
  };
}
const run = (source, decides, claims, id) => checkStep(createRubric(spec(source, decides, id)), "cp", { claims }, { inputs: { offers: source } });
/** The substrings the spans of an entry highlight, as `role:decide:text` strings (also proves slice(start,end)). */
const marks = (e) => e.spans.map((s) => `${s.role}:${s.decide}:${e.text.slice(s.start, s.end)}`);
const cl = (quote, values, claim = "x") => ({ claim, quote, ...(values ? { values } : {}) });

const FLIGHT = "From 43 US dollars. Nonstop flight with United. Leaves San Francisco International Airport at 9:27 AM on Thursday.";

test("anchored money: anchor, value and unit spans, green", async () => {
  const d = [{ valueKind: "money", unit: ["US dollars"], op: "lt", value: 450, anchor: "From" }];
  const r = await run(FLIGHT, d, [cl(FLIGHT, { d0: "43" }, "43")]);
  assert.equal(r.verdict, "green");
  const [e] = r.full.evidence;
  assert.equal(e.check, "c");
  assert.equal(e.claim, 0);
  assert.equal(e.text, FLIGHT);
  assert.deepEqual(marks(e), ["anchor:0:From", "value:0:43", "unit:0:US dollars"]);
  assert.equal(e.spansTotal, undefined);
});

test("a value that is red on its bound still gets its spans (red and green alike)", async () => {
  const d = [{ valueKind: "money", unit: "US dollars", op: "gt", value: 450, anchor: "From" }];
  const r = await run(FLIGHT, d, [cl(FLIGHT, { d0: "43" }, "43")]);
  assert.equal(r.verdict, "red");
  assert.deepEqual(marks(r.full.evidence[0]), ["anchor:0:From", "value:0:43", "unit:0:US dollars"]);
});

test("a symbol form followed by a signed unit reports both (\"$43 US dollars\")", async () => {
  const q = "From $43 US dollars. Nonstop";
  const d = [{ valueKind: "money", currency: "$", unit: ["US dollars"], op: "lt", value: 450, anchor: "From" }];
  const r = await run(q, d, [cl(q, { d0: "43" }, "43")]);
  assert.deepEqual(marks(r.full.evidence[0]), ["anchor:0:From", "currency:0:$", "value:0:43", "unit:0:US dollars"]);
});

test("same amount = one price: every token, each with its currency / unit span", async () => {
  const q = "$43 x 43 US dollars";
  const d = [{ valueKind: "money", currency: "$", unit: "US dollars", op: "lt", value: 450 }];
  const r = await run(q, d, [cl(q, { d0: "43" }, "43")]);
  assert.equal(r.verdict, "green", JSON.stringify(r.gaps));
  assert.deepEqual(marks(r.full.evidence[0]), ["currency:0:$", "value:0:43", "value:0:43", "unit:0:US dollars"]);
});

test("value-many: all tokens counted are spans (red)", async () => {
  const q = "$43 and 44 US dollars";
  const d = [{ valueKind: "money", currency: "$", unit: "US dollars", op: "lt", value: 450 }];
  const r = await run(q, d, [cl(q, { d0: "43" }, "43")]);
  assert.equal(r.verdict, "red");
  assert.equal(r.gaps[0].items[0].startsWith("#0:d0:value-many"), true);
  assert.deepEqual(marks(r.full.evidence[0]), ["currency:0:$", "value:0:43", "value:0:44", "unit:0:US dollars"]);
});

test("membership: every token with canon; matched is per CLAIM on the same quote", async () => {
  const q = "Alaska 8:15 AM $389 Nonstop $199";
  const d = [{ valueKind: "money", currency: "$" }];
  const r = await run(q, d, [cl(q, { d0: "389" }, "389"), cl(q, { d0: "199" }, "199")]);
  assert.equal(r.verdict, "green", JSON.stringify(r.gaps));
  const [a, b] = r.full.evidence;
  assert.deepEqual(a.spans.map((s) => [s.role, s.canon, s.matched]), [["currency", undefined, undefined], ["value", "389", true], ["currency", undefined, undefined], ["value", "199", undefined]]);
  assert.deepEqual(b.spans.map((s) => [s.role, s.canon, s.matched]), [["currency", undefined, undefined], ["value", "389", undefined], ["currency", undefined, undefined], ["value", "199", true]]);
  assert.deepEqual(marks(a), ["currency:0:$", "value:0:389", "currency:0:$", "value:0:199"]);
  assert.equal(a.claim, 0);
  assert.equal(b.claim, 1);
});

test("membership with a claim value not on the page: no matched anywhere (red)", async () => {
  const q = "Alaska $389 Nonstop $199";
  const r = await run(q, [{ valueKind: "money", currency: "$" }], [cl(q, { d0: "250" }, "250")]);
  assert.equal(r.verdict, "red");
  assert.equal(r.full.evidence[0].spans.some((s) => s.matched), false);
  assert.equal(r.full.evidence[0].spans.filter((s) => s.role === "value").length, 2);
});

test("anchored bind-only: the anchor plus the one value after it, with canon and matched", async () => {
  const q = "Leaves SFO at 9:27 AM on Thursday";
  const d = [{ valueKind: "time", anchor: "Leaves SFO at" }];
  const r = await run(q, d, [cl(q, { d0: "9:27 AM" }, "9:27")]);
  const [e] = r.full.evidence;
  assert.deepEqual(marks(e), ["anchor:0:Leaves SFO at", "value:0:9:27 AM"]);
  assert.equal(e.spans[1].canon, "09:27");
  assert.equal(e.spans[1].matched, true);
  const bad = await run(q, d, [cl(q, { d0: "8:00 AM" }, "9:27")]);
  assert.equal(bad.verdict, "red");
  assert.equal(bad.full.evidence[0].spans[1].matched, undefined);
});

test("Airbnb \"€344 total\": currency, value and unit spans", async () => {
  const q = "€344 total";
  const d = [{ valueKind: "money", currency: "€", unit: ["total"], op: "lt", value: 500 }];
  const r = await run(q, d, [cl(q, { d0: "344" }, "344")]);
  assert.equal(r.verdict, "green", JSON.stringify(r.gaps));
  assert.deepEqual(marks(r.full.evidence[0]), ["currency:0:€", "value:0:344", "unit:0:total"]);
});

test("text decide with anchor + until: anchor, value (the field) and until", async () => {
  const q = "Leaves San Francisco International Airport at 9:27 AM";
  const d = [{ valueKind: "text", anchor: "Leaves", until: " at" }];
  const r = await run(q, d, [cl(q, { d0: "San Francisco International Airport" }, "x")]);
  assert.equal(r.verdict, "green", JSON.stringify(r.gaps));
  assert.deepEqual(marks(r.full.evidence[0]), ["anchor:0:Leaves", "value:0:San Francisco International Airport", "until:0: at"]);
  const bad = await run(q, d, [cl(q, { d0: "Oakland" }, "x")]);
  assert.equal(bad.verdict, "red");
  assert.deepEqual(marks(bad.full.evidence[0]), ["anchor:0:Leaves", "until:0: at"], "a claim text that does not match has no value span");
});

test("text decide, anchored without until and unanchored", async () => {
  const q = "Leaves San Francisco International Airport at 9:27 AM";
  const r = await run(q, [{ valueKind: "text", anchor: "Leaves" }, { valueKind: "text" }], [cl(q, { d0: "san francisco", d1: "airport" }, "x")]);
  assert.equal(r.verdict, "green", JSON.stringify(r.gaps));
  assert.deepEqual(marks(r.full.evidence[0]), ["anchor:0:Leaves", "value:0:San Francisco", "value:1:Airport"]);
});

test("presence: one phrase span per found phrase at its first case-insensitive occurrence; a missing phrase has none", async () => {
  const q = "From 43 US dollars. Nonstop flight with United. United again";
  const r = await run(q, [{ phrases: ["nonstop FLIGHT", "united", "Delta"] }], [cl(q)]);
  assert.equal(r.verdict, "red");
  const [e] = r.full.evidence;
  assert.deepEqual(marks(e), ["phrase:0:Nonstop flight", "phrase:0:United"]);
  assert.equal(e.spans[1].start, q.indexOf("United"));
});

test("anchor-missing: no spans; anchor-ambiguous: every qualifying anchor", async () => {
  const q = "From 5 US dollars. From 6 US dollars.";
  const miss = await run(q, [{ valueKind: "money", unit: "US dollars", op: "lt", value: 9, anchor: "Starting" }], [cl(q)]);
  assert.equal(miss.verdict, "red");
  assert.deepEqual(miss.full.evidence[0].spans, []);
  const amb = await run(q, [{ valueKind: "money", unit: "US dollars", op: "lt", value: 9, anchor: "From" }], [cl(q)]);
  assert.equal(amb.verdict, "red");
  assert.deepEqual(marks(amb.full.evidence[0]), ["anchor:0:From", "anchor:0:From"]);
});

test("value-none keeps the located anchor; until-missing keeps anchor; value-malformed points at the token", async () => {
  const q = "Total: nothing here";
  const none = await run(q, [{ valueKind: "number", op: "lt", value: 9, anchor: "Total:" }], [cl(q)]);
  assert.deepEqual(marks(none.full.evidence[0]), ["anchor:0:Total:"]);
  const noUntil = await run(q, [{ valueKind: "text", anchor: "Total:", until: " zzz" }], [cl(q, { d0: "nothing" })]);
  assert.deepEqual(marks(noUntil.full.evidence[0]), ["anchor:0:Total:"]);
  const q2 = "Count 5a items";
  const mal = await run(q2, [{ valueKind: "number", op: "lt", value: 9 }], [cl(q2)]);
  assert.equal(mal.gaps[0].items[0].startsWith("#0:d0:value-malformed"), true);
  const [e] = mal.full.evidence;
  assert.equal(e.spans.length, 1);
  assert.equal(e.spans[0].role, "value");
  assert.ok("5a".startsWith(e.text.slice(e.spans[0].start, e.spans[0].end)) && e.spans[0].end > e.spans[0].start);
});

test("quote-not-found, empty-quote, malformed, non-string quote: entry with spans [] (text only when the quote is a string)", async () => {
  const d = [{ valueKind: "money", currency: "$" }];
  const r = await run(FLIGHT, d, [cl("  **not** on   the page "), cl("   "), { quote: "From 43", values: {} }, { claim: "c", quote: 7 }, { claim: "c" }]);
  const ev = r.full.evidence;
  assert.equal(ev.length, 5);
  assert.deepEqual(ev.map((e) => e.claim), [0, 1, 2, 3, 4]);
  assert.deepEqual(ev[0], { check: "c", claim: 0, text: "not on the page", spans: [] });
  assert.deepEqual(ev[1], { check: "c", claim: 1, text: "", spans: [] });
  assert.deepEqual(ev[2], { check: "c", claim: 2, text: "From 43", spans: [] });
  assert.deepEqual(ev[3], { check: "c", claim: 3, spans: [] });
  assert.deepEqual(ev[4], { check: "c", claim: 4, spans: [] });
});

test("quote-too-long: spans [] and no text", async () => {
  const long = "$5 " + "x".repeat(4100);
  const r = await run(long, [{ valueKind: "money", currency: "$" }], [cl(long, { d0: "5" })]);
  assert.equal(r.gaps[0].items[0], "#0:quote-too-long");
  assert.deepEqual(r.full.evidence, [{ check: "c", claim: 0, spans: [] }]);
});

test("claim index stays the caller's index with a red claim in the middle; the check id is exactly as signed", async () => {
  const src = "Alaska $389 and Delta $199 and United $250";
  const d = [{ valueKind: "money", currency: "$", anchor: "Delta" }];
  const r = await run(src, d, [cl("Alaska $389", null), cl("zzz not there"), cl("Delta $199", { d0: "199" }, "199")], "flight_1-Z");
  // claim 0 has no values (d0 missing: red), 1 not found, 2 fine
  assert.equal(r.verdict, "red");
  assert.deepEqual(r.full.evidence.map((e) => [e.check, e.claim]), [["flight_1-Z", 0], ["flight_1-Z", 1], ["flight_1-Z", 2]]);
  assert.deepEqual(marks(r.full.evidence[2]), ["anchor:0:Delta", "currency:0:$", "value:0:199"]);
  assert.equal(r.full.evidence[2].spans[2].matched, true);
});

test("evidence only for cited checks that sign decides, in check order then claim order", async () => {
  const src = "From 5 US dollars. Nonstop";
  const s = {
    schema: 1,
    goal: "g",
    inputs: [{ name: "offers", sha256: sha(src) }],
    checkpoints: {
      cp: {
        gating: true,
        checks: [
          { id: "plain", rule: "cited", claims: "claims", source: "offers" },
          { id: "a", rule: "cited", claims: "claims", source: "offers", decides: [{ phrases: ["Nonstop"] }] },
          { id: "w", rule: "maxWords", field: "text", value: 50 },
          { id: "b", rule: "cited", claims: "claims", source: "offers", decides: [{ phrases: ["From"] }] },
        ],
      },
    },
  };
  const claims = [cl("From 5 US dollars", null, "5"), cl("Nonstop")];
  const r = await checkStep(createRubric(s), "cp", { claims, text: "hello" }, { inputs: { offers: src } });
  assert.deepEqual(r.full.evidence.map((e) => `${e.check}#${e.claim}`), ["a#0", "a#1", "b#0", "b#1"]);
  const none = await run(src, null, [cl("Nonstop")]);
  assert.deepEqual(none.full.evidence, []);
});

test("bounds: 101 claims give 100 entries and evidenceTotal; >50 spans give spansTotal", async () => {
  const claims = Array.from({ length: 101 }, () => cl(FLIGHT, { d0: "43" }, "43"));
  const r = await run(FLIGHT, [{ valueKind: "money", unit: "US dollars", op: "lt", value: 450, anchor: "From" }], claims);
  assert.equal(r.full.evidence.length, 100);
  assert.equal(r.full.evidence[99].claim, 99);
  assert.equal(r.full.evidenceTotal, 101);
  const ok = await run(FLIGHT, [{ valueKind: "money", unit: "US dollars", op: "lt", value: 450, anchor: "From" }], claims.slice(0, 100));
  assert.equal(ok.full.evidenceTotal, undefined, "present only when something was cut");
  const q = Array.from({ length: 60 }, (_, i) => String(i + 1)).join(" ");
  const m = await run(q, [{ valueKind: "number" }], [cl(q, { d0: "7" }, "7")]);
  const [e] = m.full.evidence;
  assert.equal(e.spans.length, 50);
  assert.equal(e.spansTotal, 60);
  assert.deepEqual(marks(e).slice(0, 3), ["value:0:1", "value:0:2", "value:0:3"]);
});

test("evidence is not in the worker gaps", async () => {
  const q = "$43 and 44 US dollars";
  const r = await run(q, [{ valueKind: "money", currency: "$", unit: "US dollars", op: "lt", value: 450 }], [cl(q, { d0: "43" }, "43")]);
  assert.equal(r.verdict, "red");
  assert.equal(JSON.stringify(r.gaps).includes("evidence"), false);
  assert.equal(JSON.stringify(r.gaps).includes("spans"), false);
  assert.equal(r.evidence, undefined);
  assert.equal(JSON.stringify(r.full.gaps).includes("spans"), false);
});

test("gate.checkStep returns full.evidence but the audit line and the human ask carry none", async (t) => {
  const dir = await makeTmpDir();
  t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const q = "$43 and 44 US dollars";
  const sp = spec(q, [{ valueKind: "money", currency: "$", unit: "US dollars", op: "lt", value: 450 }]);
  const gate = new Gate({ audit: { path: auditPath }, rubric: { spec: sp, sha256: rubricSha(sp), advanceOn: ["done"] }, runId });
  await gate.init();
  const r = await gate.checkStep("cp", { claims: [cl(q, { d0: "43" }, "43")] }, { inputs: { offers: q } });
  assert.equal(r.verdict, "red");
  assert.equal(r.full.evidence.length, 1);
  assert.equal(r.full.evidence[0].spans.length, 4);
  const raw = fs.readFileSync(auditPath, "utf8");
  const rub = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.phase === "rubric");
  assert.equal(rub.length, 1);
  assert.equal(raw.includes("evidence"), false);
  assert.equal(raw.includes('"spans"'), false);
});

test("malformed claims with a huge quote: normalized once, evidence unchanged in shape (perf regression)", async () => {
  const big = "word  **x** ".repeat(400000);
  const claims = Array.from({ length: 100 }, () => ({ claim: 5, quote: big }));
  const t0 = Date.now();
  const r = await run(FLIGHT, [{ valueKind: "number" }], claims);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `took ${ms} ms`);
  assert.equal(r.full.evidence.length, 100);
  for (const e of r.full.evidence) {
    assert.deepEqual(e.spans, []);
    assert.equal("text" in e, false);
  }
});

test("symbol form: the unit span is the token's own read (longest signed unit, exact case, not before a letter)", async () => {
  const d = [{ valueKind: "money", currency: "$", unit: ["US", "US dollars"], op: "lt", value: 450 }];
  const cases = [
    ["Fare $43 US dollars.", ["currency:0:$", "value:0:43", "unit:0:US dollars"]],
    ["Fare $43 US dollarsX.", ["currency:0:$", "value:0:43", "unit:0:US"]],
    ["Fare $43 us dollars.", ["currency:0:$", "value:0:43"]],
  ];
  for (const [q, want] of cases) {
    const r = await run(q, d, [cl(q, { d0: "43" }, "43")]);
    assert.deepEqual(marks(r.full.evidence[0]), want, q);
  }
});

// --- U+0130 (İ): spans after / inside İ are mapped back; only an edge inside one İ's expansion is omitted (ruling #66, 2A) ---

test("İ: the only code point whose default toLowerCase changes length", () => {
  const odd = [];
  for (let c = 0; c < 0x10000; c++) if (String.fromCharCode(c).toLowerCase().length !== 1) odd.push(c);
  for (let c = 0x10000; c < 0x110000; c++) if (String.fromCodePoint(c).toLowerCase().length !== 2) odd.push(c);
  assert.deepEqual(odd, [0x130]);
});

test("İ: presence phrase after İ gets its span (repro)", async () => {
  const q = "Hotel İstanbul. Price: 43 USD. Flight nonstop";
  const r = await run(q, [{ phrases: ["nonstop"] }], [cl(q)]);
  assert.equal(r.verdict, "green", JSON.stringify(r.gaps));
  const [s] = r.full.evidence[0].spans;
  assert.deepEqual([s.start, s.end], [38, 45]);
  assert.equal(r.full.evidence[0].text.slice(s.start, s.end), "nonstop");
});

test("İ: a phrase containing İ, and a phrase ending right after İ", async () => {
  const q = "Visit İstanbul İ";
  const r = await run(q, [{ phrases: ["İstanbul", "İ"] }], [cl(q)]);
  assert.equal(r.verdict, "green", JSON.stringify(r.gaps));
  assert.deepEqual(marks(r.full.evidence[0]), ["phrase:0:İstanbul", "phrase:0:İ"]);
  const q2 = "ab İ cd";
  const r2 = await run(q2, [{ phrases: ["b i"] }], [cl(q2)]);
  assert.deepEqual(marks(r2.full.evidence[0]), []);
  const q3 = "xİ";
  const r3 = await run(q3, [{ phrases: ["xi̇"] }], [cl(q3)]);
  assert.deepEqual(marks(r3.full.evidence[0]), ["phrase:0:xİ"]);
});

test("İ: an edge inside one İ's expansion has no span; the verdict is unchanged", async () => {
  const q = "İstanbul";
  const r = await run(q, [{ phrases: ["i"] }], [cl(q)]); // "i" is the first half of İ's fold: its END edge is mid-expansion
  assert.equal(r.verdict, "green");
  assert.deepEqual(r.full.evidence[0].spans, []);
  const r2 = await run(q, [{ phrases: ["̇stanbul"] }], [cl(q)]); // START edge mid-expansion
  assert.equal(r2.verdict, "green");
  assert.deepEqual(r2.full.evidence[0].spans, []);
});

test("İ: unanchored text value after İ, and anchored text value containing İ", async () => {
  const q = "Hotel İstanbul Airport and more";
  const a = await run(q, [{ valueKind: "text" }], [cl(q, { d0: "airport" })]);
  assert.equal(a.verdict, "green", JSON.stringify(a.gaps));
  assert.deepEqual(marks(a.full.evidence[0]), ["value:0:Airport"]);
  const b = await run(q, [{ valueKind: "text", anchor: "Hotel" }], [cl(q, { d0: "İstanbul" })]);
  assert.equal(b.verdict, "green", JSON.stringify(b.gaps));
  assert.deepEqual(marks(b.full.evidence[0]), ["anchor:0:Hotel", "value:0:İstanbul"]);
  const c = await run("Hotel Airport İ", [{ valueKind: "text", anchor: "Airport" }], [cl("Hotel Airport İ", { d0: "İ" })]);
  assert.deepEqual(marks(c.full.evidence[0]), ["anchor:0:Airport", "value:0:İ"]);
});

test("İ: a quote without İ is unchanged", async () => {
  const q = "Hotel Istanbul nonstop";
  const r = await run(q, [{ phrases: ["NONSTOP"] }], [cl(q)]);
  assert.deepEqual(marks(r.full.evidence[0]), ["phrase:0:nonstop"]);
});

test("İ property: every emitted presence span folds to its phrase; verdict equals the plain carries answer (seeded)", async () => {
  let seed = 20261019;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const alpha = ["a", "b", "i", "İ", "I", "B", " ", "x", "̇"];
  const word = (max) => Array.from({ length: 1 + Math.floor(rnd() * max) }, () => alpha[Math.floor(rnd() * alpha.length)]).join("");
  let withSpan = 0;
  for (let n = 0; n < 1500; n++) {
    const q = word(14);
    const phrases = Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => word(4));
    const norm = normalizeForQuote(q);
    if (norm === "" || phrases.some((p) => p.trim() === "" || p !== p.trim())) continue;
    const res = decideQuote(q, [{ phrases }], true).results[0];
    const want = phrases.every((p) => carries(norm, norm.toLowerCase(), p, false));
    assert.equal(res.ok, want, JSON.stringify([q, phrases]));
    for (const s of res.sp) {
      withSpan++;
      assert.ok(phrases.some((p) => norm.slice(s.start, s.end).toLowerCase() === p.toLowerCase()), JSON.stringify([q, phrases, s]));
    }
  }
  assert.ok(withSpan > 200, `only ${withSpan} spans exercised`);
});
