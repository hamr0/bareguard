import test from "node:test";
import assert from "node:assert/strict";
import { groundedValues, groundedLiterals, rubricVocabulary } from "../src/index.js";
import { parseClaimValue, extractValue } from "../src/primitives/rubric-locate.js";

// Ruling #82 (cells-prd.md §11.6): groundedValues / groundedLiterals. Every reader rule has a positive and a negative case; the
// never-throws surface is fed hostile input; the scan is linear.

const NUMS = [-2026, -5, 0, 0.5, 1, 1.5, 2, 3, 4, 5, 7, 9, 10, 11, 15, 18, 20, 29.99, 30, 43, 50, 100, 150, 200, 400, 500, 999, 1000, 1299.5, 2026, 10000.5, 1000000];
const TIMES = ["00:00", "00:30", "05:00", "06:00", "14:00", "09:00", "09:30", "10:30", "11:30", "12:00", "12:30", "13:00", "17:00", "21:00", "23:59"];
const DATES = ["2026-11-18", "2026-02-28", "2026-12-01", "2026-11-30"];
const g1 = (kind, value, text) => groundedValues([{ kind, value }], text).ok;
const saidNums = (text) => NUMS.filter((n) => g1("number", n, text));
const saidTimes = (text) => TIMES.filter((t) => g1("time", t, text));
const saidDates = (text) => DATES.filter((d) => g1("date", d, text));

// ---- 1. numbers ---------------------------------------------------------------------------------------------------

test("numbers: proper thousands groups only; decimals, trailing dot, percent and leading zeros are read", () => {
  assert.deepEqual(saidNums("1,000"), [1000]);
  assert.deepEqual(saidNums("1,000,000"), [1000000]);
  assert.deepEqual(saidNums("10,000.50"), [10000.5]);
  for (const bad of ["1,00", "1,0,0", "1,0000", "1,5,0", "10,00", ",000", "1000,000"]) assert.deepEqual(saidNums(bad), [], bad);
  assert.deepEqual(saidNums("1.5"), [1.5]);
  assert.deepEqual(saidNums("500."), [500]);
  assert.deepEqual(saidNums("1,000,"), [1000], "a trailing comma is punctuation, not part of the number");
  assert.deepEqual(saidNums("It is 50% done"), [50]);
  assert.deepEqual(saidNums("007"), [7]);
  assert.deepEqual(saidNums("3 apples, 4 pears"), [3, 4]);
  assert.deepEqual(saidNums("price 1,299.50 net"), [1299.5]);
});

// ---- 2. sign ---------------------------------------------------------------------------------------------------------

test("sign: only at the start, after whitespace or '('; -5 says -5 and never 5; + is a sign; U+2212 and every glued sign on an amount, date or time is malformed", () => {
  assert.deepEqual(saidNums("-5"), [-5]);
  assert.deepEqual(saidNums("a -5 here"), [-5]);
  assert.deepEqual(saidNums("(-5"), [-5]);
  assert.deepEqual(saidNums("(-5)"), [-5]);
  assert.deepEqual(saidNums("+5"), [5]);
  assert.deepEqual(saidNums("x +5"), [5]);
  assert.deepEqual(saidNums("10-20"), [10, 20], "a dash between numbers is a separator");
  assert.deepEqual(saidNums("a-5"), [5], "a dash glued after a letter is not a sign");
  assert.deepEqual(saidNums("−5"), [], "U+2212 is malformed");
  assert.deepEqual(saidNums("x −5"), []);
  assert.deepEqual(saidNums("-$5"), []);
  assert.deepEqual(saidNums("$-5"), []);
  assert.deepEqual(saidNums("-5€"), []);
  assert.deepEqual(saidNums("-2026-11-18"), [], "a sign on a date");
  assert.deepEqual(saidDates("-2026-11-18"), []);
  assert.deepEqual(saidTimes("-5:00"), [], "a sign on a time");
  assert.deepEqual(saidTimes("-9am"), []);
  assert.deepEqual(saidNums("--5"), [5], "the second dash is not at a token start");
});

// ---- 3 / 4. glued letters, leading . , ( ----------------------------------------------------------------------------

test("glued letters ground nothing; a space-separated suffix is a bare number", () => {
  for (const bad of ["5k", "8x", "3rd", "400USD", "k5", "x5", "5é", "é5", "1,000k"]) assert.deepEqual(saidNums(bad), [], bad);
  assert.deepEqual(saidNums("400 USD"), [400]);
  assert.deepEqual(saidNums("5 k"), [5]);
  assert.deepEqual(saidNums("5, 6"), [5], "a comma then a space: 5 is a number, 6 is a number") && assert.deepEqual(saidNums("5, 7"), [5, 7]);
});

test(".5, ,5 and (500) ground nothing; a ( before a date or a time is fine", () => {
  for (const bad of [".5", ",5", "(500)", "(500", "($5)", "x.5"]) assert.deepEqual(saidNums(bad), [], bad);
  assert.deepEqual(saidDates("due (2026-11-18)"), ["2026-11-18"]);
  assert.deepEqual(saidTimes("at (9am)"), ["09:00"]);
  assert.deepEqual(saidTimes("at (9:30)"), ["09:30"]);
  assert.deepEqual(saidNums("(see 5)"), [5]);
});

// ---- 5. amounts ---------------------------------------------------------------------------------------------------

test("amounts: $150 says 150 and not 15; 150€ says 150; both-side symbols, glued words and a space are handled", () => {
  assert.deepEqual(saidNums("$150"), [150]);
  assert.deepEqual(saidNums("£7"), [7]);
  assert.deepEqual(saidNums("€1,299.50"), [1299.5]);
  assert.deepEqual(saidNums("150€"), [150]);
  assert.deepEqual(saidNums("$ 150"), [150], "a space: the bare number");
  assert.equal(g1("number", 15, "$150"), false);
  assert.equal(g1("number", 1, "$150"), false);
  assert.equal(g1("number", 15, "150"), false);
  for (const bad of ["$43$", "$150x", "x$5", "150€x", "150€5", "29,99€"]) assert.deepEqual(saidNums(bad), [], bad);
  assert.deepEqual(saidNums("budget $500 and 3 days"), [3, 500]);
});

// ---- 6. times -----------------------------------------------------------------------------------------------------------

test("times: H:MM / HH:MM, or H alone only before am/pm; any case, glued or one space; compared as minutes of the day", () => {
  assert.deepEqual(saidTimes("5:00 am"), ["05:00"]);
  for (const t of ["5:00 AM", "5:00am", "5:00 Am", "5:00 aM", "5:00 AM sharp"]) assert.deepEqual(saidTimes(t), ["05:00"], t);
  assert.deepEqual(saidTimes("9am"), ["09:00"]);
  assert.deepEqual(saidTimes("9 PM"), ["21:00"]);
  assert.deepEqual(saidTimes("9Pm"), ["21:00"]);
  assert.deepEqual(saidTimes("17:00"), ["17:00"]);
  assert.deepEqual(saidTimes("5:00 pm"), ["17:00"]);
  assert.deepEqual(saidTimes("12 am"), ["00:00"]);
  assert.deepEqual(saidTimes("12 pm"), ["12:00"]);
  assert.deepEqual(saidTimes("12:30 PM"), ["12:30"]);
  assert.deepEqual(saidTimes("12:30 AM"), ["00:30"]);
  assert.deepEqual(saidTimes("23:59"), ["23:59"]);
  assert.deepEqual(saidTimes("10:30-11:30"), ["10:30", "11:30"]);
  assert.deepEqual(saidTimes("09:30"), ["09:30"]);
  // a bare 5:00 grounds only 05:00: no inference to 17:00
  assert.deepEqual(saidTimes("5:00"), ["05:00"]);
  assert.equal(g1("time", "17:00", "5:00"), false);
  assert.equal(g1("time", "05:00", "5:00 pm"), false);
});

test("times: invalid, dotted, extended or letter-glued times are malformed, ground nothing, and still consume their digits", () => {
  for (const bad of ["25:00", "5:60", "13pm", "13 pm", "0 am", "0am", "17:00 pm", "5:00:30", "9 a.m.", "5:00 a.m.", "5:00 p.m.", "5:00x", "x5:00", "5:7", "123:45", "1:2:3", "24:00"]) {
    assert.deepEqual(saidTimes(bad), [], bad);
    assert.deepEqual(saidNums(bad), [], `${bad}: digits are consumed, never bare numbers`);
  }
  // a word that merely starts like the suffix is not a suffix: the number is bare
  assert.deepEqual(saidTimes("9 american"), []);
  assert.deepEqual(saidNums("9 american"), [9]);
  assert.deepEqual(saidTimes("9amazing"), []);
  assert.deepEqual(saidNums("9amazing"), [], "glued letters");
  // a valid time consumes its digits: 05:00 says no bare 5, no bare 0
  assert.deepEqual(saidNums("05:00"), []);
  assert.deepEqual(saidNums("9am"), []);
  assert.deepEqual(saidNums("see 17:00 and 3"), [3]);
});

// ---- 7. dates ---------------------------------------------------------------------------------------------------------------

test("dates: only a real ISO date grounds, glued dates and every other three-group shape are consumed and ground nothing", () => {
  assert.deepEqual(saidDates("on 2026-11-18."), ["2026-11-18"]);
  assert.deepEqual(saidDates("on 2026-11-18, 2026-12-01"), ["2026-11-18", "2026-12-01"]);
  assert.deepEqual(saidDates("2026-02-28"), ["2026-02-28"]);
  assert.deepEqual(saidNums("on 2026-11-18"), [], "2026, 11 and 18 are not bare numbers");
  for (const bad of ["2026-02-30", "2026-13-01", "2026-11-18T10:00", "2026-11-18x", "x2026-11-18", "2026-1-8", "2026/11/18", "2026.11.18", "3/4/2026", "18.11.2026", "2026-11-18-05", "1.2.3.4", "12026-11-18"]) {
    assert.deepEqual(saidDates(bad), [], bad);
    assert.deepEqual(saidNums(bad), [], `${bad}: consumed whole, no digits leak out as bare numbers`);
  }
  assert.deepEqual(saidNums("3/4"), [3, 4], "two groups are not date-shaped");
  assert.deepEqual(saidNums("1.5"), [1.5]);
  assert.deepEqual(saidNums("10-20"), [10, 20]);
  assert.deepEqual(saidDates("0001-01-01"), [], "not in the candidate list, but readable:");
  assert.equal(g1("date", "0001-01-01", "0001-01-01"), true);
  assert.equal(g1("date", "0000-01-01", "0000-01-01"), false, "year 0 is not a real date");
});

// ---- 8 / 9. exact compare and normalization ----------------------------------------------------------------------------

test("numbers compare as exact decimals; exponent forms cannot be grounded; -0 is 0", () => {
  assert.equal(g1("number", 0.1 + 0.2, "0.30000000000000004"), true);
  assert.equal(g1("number", 0.1 + 0.2, "0.3"), false);
  assert.equal(g1("number", 0.3, "0.3"), true);
  assert.equal(g1("number", 5, "5.00"), true);
  assert.equal(g1("number", 5.1, "5.10"), true);
  for (const [n, t] of [[1e-6, "0.000001"], [1e-7, "0.0000001"], [1e21, "1000000000000000000000"], [1.5e-10, "0.00000000015"], [-1.5e-10, "-0.00000000015"], [1.2345e25, "12345000000000000000000000"]]) {
    assert.equal(g1("number", n, t), true, `${n} is grounded by its plain-decimal text`);
    assert.equal(g1("number", n, "5"), false);
  }
  assert.equal(g1("number", 1e21, "1e21"), false, "the exponent spelling in the text grounds nothing");
  assert.equal(g1("number", 123456789012345680000, "123456789012345680000"), true, "the largest plain-decimal form that String(n) gives");
  assert.equal(g1("number", -0, "0"), true);
  assert.equal(g1("number", 0, "-0"), true);
  assert.equal(g1("number", -3, "-3.0"), true);
  assert.equal(g1("number", 3, "-3"), false);
});

test("normalization first: NBSP is whitespace, ** and __ are removed", () => {
  assert.deepEqual(saidNums("$ 150"), [150], "NBSP between the symbol and digits is whitespace: the bare number");
  assert.deepEqual(saidTimes("5 am"), ["05:00"]);
  assert.deepEqual(saidNums("**500**"), [500]);
  assert.deepEqual(saidNums("$**150**"), [150]);
  assert.deepEqual(saidNums("a\n\n 5   "), [5]);
});

test("a mixed sentence: each token is one thing", () => {
  const text = "Invoices over $500 due after 2026-11-18 at 9am, 3 of them, rate 1.5% (not -5)";
  assert.deepEqual(saidNums(text), [-5, 1.5, 3, 500]);
  assert.deepEqual(saidDates(text), ["2026-11-18"]);
  assert.deepEqual(saidTimes(text), ["09:00"]);
});

// ---- the shape of groundedValues -------------------------------------------------------------------------------------------

test("groundedValues: ok / missing shape, order, index and kinds", () => {
  const r = groundedValues([{ kind: "number", value: 150 }, { kind: "number", value: 15 }, { kind: "date", value: "2026-11-18" }, { kind: "date", value: "2026-11-19" }, { kind: "time", value: "09:00" }, { kind: "time", value: "10:00" }], "budget $150 by 2026-11-18 at 9am");
  assert.deepEqual(r, { ok: false, missing: [{ index: 1, kind: "number", value: 15 }, { index: 3, kind: "date", value: "2026-11-19" }, { index: 5, kind: "time", value: "10:00" }] });
  assert.deepEqual(groundedValues([], "text"), { ok: true, missing: [] });
  assert.deepEqual(groundedValues([{ kind: "number", value: 150 }], "budget $150"), { ok: true, missing: [] });
  assert.deepEqual(groundedValues([{ kind: "number", value: 1 }, { kind: "number", value: 1 }], "x"), { ok: false, missing: [{ index: 0, kind: "number", value: 1 }, { index: 1, kind: "number", value: 1 }] }, "per index, not de-duplicated");
});

test("groundedValues: a bad entry is itself missing, never skipped", () => {
  const long = "x".repeat(500);
  const cases = [
    [{ kind: "number", value: "5" }, "number", "5"], [{ kind: "number", value: NaN }, "number", NaN], [{ kind: "number", value: Infinity }, "number", Infinity],
    [{ kind: "number", value: null }, "number", "null"], [{ kind: "number", value: [5] }, "number", "array"], [{ kind: "number", value: {} }, "number", "object"], [{ kind: "number" }, "number", "undefined"], [{ kind: "number", value: 5n }, "number", "bigint"],
    [{ kind: "number", value: long }, "number", long.slice(0, 120)],
    [{ kind: "date", value: "2026-02-30" }, "date", "2026-02-30"], [{ kind: "date", value: "2026-1-1" }, "date", "2026-1-1"], [{ kind: "date", value: 20261118 }, "date", 20261118], [{ kind: "date", value: " 2026-11-18" }, "date", " 2026-11-18"],
    [{ kind: "time", value: "5:00" }, "time", "5:00"], [{ kind: "time", value: "24:00" }, "time", "24:00"], [{ kind: "time", value: "09:60" }, "time", "09:60"], [{ kind: "time", value: 900 }, "time", 900], [{ kind: "time", value: "9:00 am" }, "time", "9:00 am"],
    [{ kind: "money", value: 5 }, "invalid", 5], [{ kind: undefined, value: 5 }, "invalid", 5], [{ kind: "Number", value: 5 }, "invalid", 5],
    [null, "invalid", "unreadable"], [5, "invalid", "unreadable"], ["x", "invalid", "unreadable"], [[], "invalid", "unreadable"], [undefined, "invalid", "unreadable"],
  ];
  for (const [entry, kind, value] of cases) {
    const r = groundedValues([entry], "5 2026-11-18 5:00 9:00 24:00 x 1000000000000000000000 20261118 900 null 2026-02-30 09:60");
    assert.equal(r.ok, false, String(entry && typeof entry === "object" ? Object.keys(entry) : entry));
    assert.deepEqual(r.missing, [{ index: 0, kind, value }].map((m) => ({ ...m, value: Number.isNaN(m.value) ? NaN : m.value })).map((m) => (Number.isNaN(m.value) ? { ...m, value: r.missing[0].value } : m)), String(entry && typeof entry === "object" ? Object.keys(entry) : entry));
    if (Number.isNaN(value)) assert.ok(Number.isNaN(r.missing[0].value));
  }
});

test("groundedValues: non-array values and non-string text", () => {
  for (const bad of [undefined, null, 5, "x", {}, { length: 1, 0: { kind: "number", value: 1 } }]) assert.deepEqual(groundedValues(bad, "text"), { ok: false, missing: [], why: "not-an-array" }, String(bad));
  const entries = [{ kind: "number", value: 1 }, { kind: "number", value: "bad" }];
  for (const text of [undefined, null, 5, {}, [], ["1"], Buffer.from("1")]) {
    const r = groundedValues(entries, text);
    assert.equal(r.ok, false);
    assert.equal(r.why, "not-a-string");
    assert.deepEqual(r.missing.map((m) => m.index), [0, 1], "nothing grounds in a non-string");
  }
  assert.deepEqual(groundedValues([], 5), { ok: false, missing: [], why: "not-a-string" });
  assert.equal(groundedValues([{ kind: "number", value: 1 }], "1").why, undefined);
});

test("groundedValues never throws on hostile values: throwing getters, Proxies, inherited fields, __proto__ keys, sparse and Proxy arrays", () => {
  const boom = () => { throw new Error("boom"); };
  const r = groundedValues([{ get kind() { boom(); }, value: 1 }, { kind: "number", get value() { boom(); } }, new Proxy({}, { get: boom, ownKeys: boom, getPrototypeOf: boom }), Object.create({ kind: "number", value: 1 }), JSON.parse('{"__proto__": {"kind": "number"}, "kind": "number", "value": 1}')], "1");
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map((m) => m.index), [0, 1, 2, 3], "inherited fields are not read; an own __proto__ key is harmless");
  assert.equal(r.missing[3].kind, "invalid", "kind is read from own properties only");
  assert.equal(({}).kind, undefined);
  const sparse = [{ kind: "number", value: 1 }, , { kind: "number", value: 1 }];
  assert.deepEqual(groundedValues(sparse, "1").missing.map((m) => m.index), [1]);
  const px = new Proxy([{ kind: "number", value: 1 }], { get(t, k) { if (k === "length") boom(); return t[k]; } });
  assert.deepEqual(groundedValues(px, "1"), { ok: false, missing: [], why: "not-an-array" });
  const px2 = new Proxy([{ kind: "number", value: 1 }], { get(t, k) { if (k === "0") boom(); return t[k]; } });
  assert.deepEqual(groundedValues(px2, "1").missing.map((m) => m.index), [0]);
});

test("groundedValues: hostile text (lone surrogates, mixed scripts, every grammar character in a row) never throws and answers sensibly", () => {
  for (const text of ["\ud800", "5\ud800", "\udc005", "$\ud800 5", "5́", "٥", "5٥", "$$$$$", "-----", ":::::", "1,1,1,1,1,", "1.1.1.1.1.1", "$1$1$1$1", "9 a 9 a 9 a", "+-+-+-", "(((5", "5 am am am", "\u0000", "  5  "]) {
    assert.doesNotThrow(() => groundedValues([{ kind: "number", value: 5 }, { kind: "date", value: "2026-11-18" }, { kind: "time", value: "09:00" }], text), JSON.stringify(text));
  }
  assert.equal(g1("number", 5, "5\ud800"), true, "a lone surrogate after a number is not a letter");
  assert.equal(g1("number", 5, "\ud8005"), true);
  assert.equal(g1("number", 5, "5́"), false, "a combining mark glues like a letter");
  assert.equal(g1("number", 5, "5٥"), false, "a non-ASCII digit glues");
});

// ---- linearity: a fast default-suite shape test (the 5 MiB cases are in `npm run bench:rubric`) ----------------------------------------------

test("the scan is linear: 4x the text costs under 10x (16 KiB -> 64 KiB, best of 3) for every hostile shape", () => {
  const shapes = { digits: "7", commas: "1,", dots: "1.", dashes: "-", colons: ":", dollars: "$", mixed: "09:27 AM 1.2k $5USD (5) -5 −5 a.m. ", dateRuns: "1-1-", amounts: "$1$", chain: "1.1.1.", numbers: "1 ", times: "12:05 AM " };
  const values = [{ kind: "number", value: 5 }, { kind: "date", value: "2026-11-18" }, { kind: "time", value: "09:00" }];
  const best = (text) => {
    let b = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = process.hrtime.bigint();
      groundedValues(values, text);
      b = Math.min(b, Number(process.hrtime.bigint() - t));
    }
    return b;
  };
  for (const [name, unit] of Object.entries(shapes)) {
    const mk = (bytes) => unit.repeat(Math.ceil(bytes / unit.length));
    best(mk(4096)); // warm up
    const small = best(mk(16 * 1024));
    const large = best(mk(64 * 1024));
    // Cost shape: linear. The text grows 4x (16 KiB -> 64 KiB), so the ideal ratio is ~4x; a quadratic scan lands near 16x.
    // 10x, not 8x: on an idle machine the worst shape (dollars/chain/dateRuns) measured ~5.6x, and 8x flaked once in a
    // full-suite run under load. 10x is the margin that still catches a quadratic scan.
    assert.ok(large < Math.max(small, 200_000) * 10, `${name}: ${small} ns -> ${large} ns is not linear`);
  }
});

// ---- groundedLiterals -------------------------------------------------------------------------------------------------------

const cell = (extra) => ({ id: "c", rule: "cells", table: "t", claim: "a", op: "countIf", where: [], ...extra });
const gl = (check, text) => groundedLiterals(check, text);

test("groundedLiterals: every in-scope path is read, with its exact path and kind", () => {
  const where = [
    { column: "A", cmp: "gt", value: 11 }, { column: "A", cmp: "gte", value: 12 }, { column: "A", cmp: "lt", value: 13 }, { column: "A", cmp: "lte", value: 14 }, { column: "A", cmp: "eq", value: 15 },
    { column: "A", cmp: "between", lo: 16, hi: 17 },
    { column: "D", cmp: "before", value: "2026-01-01" }, { column: "D", cmp: "after", value: "2026-01-02" }, { column: "D", cmp: "dateOn", value: "2026-01-03" }, { column: "D", cmp: "dateBetween", lo: "2026-01-04", hi: "2026-01-05" },
  ];
  const check = cell({ where, asOf: "2026-02-01", b: { const: 77 } });
  const r = gl(check, "nothing relevant here");
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map((m) => [m.path, m.kind, m.value]), [
    ["where[0].value", "number", 11], ["where[1].value", "number", 12], ["where[2].value", "number", 13], ["where[3].value", "number", 14], ["where[4].value", "number", 15],
    ["where[5].lo", "number", 16], ["where[5].hi", "number", 17],
    ["where[6].value", "date", "2026-01-01"], ["where[7].value", "date", "2026-01-02"], ["where[8].value", "date", "2026-01-03"], ["where[9].lo", "date", "2026-01-04"], ["where[9].hi", "date", "2026-01-05"],
    ["asOf", "date", "2026-02-01"], ["b.const", "number", 77],
  ]);
  const said = gl(check, "11 12 13 14 15 16 17 2026-01-01 2026-01-02 2026-01-03 2026-01-04 2026-01-05 2026-02-01 77");
  assert.deepEqual(said, { ok: true, missing: [] });
  // each literal alone: removing only it from the text leaves only it missing
  const tokens = [["where[0].value", "11"], ["where[5].hi", "17"], ["where[9].lo", "2026-01-04"], ["asOf", "2026-02-01"], ["b.const", "77"]];
  const all = "11 12 13 14 15 16 17 2026-01-01 2026-01-02 2026-01-03 2026-01-04 2026-01-05 2026-02-01 77";
  for (const [path, tok] of tokens) {
    const r2 = gl(check, all.split(" ").filter((x) => x !== tok).join(" "));
    assert.deepEqual(r2.missing.map((m) => m.path), [path]);
  }
});

test("groundedLiterals: fields that are not literals the AI invents are NOT read", () => {
  const check = {
    id: "c", rule: "cells", table: "t", claim: "a", op: "lookup", column: "A", keyColumn: "K", keyValue: "99", needle: "88", n: 77, tolerance: 66, range: { from: 55, to: 56 },
    where: [{ column: "A", cmp: "equals", value: "44" }, { column: "A", cmp: "empty" }, { column: "A", cmp: "notEmpty" }],
    bands: [{ name: "33", gte: 22, lt: 23 }], exceptKeys: ["11"], b: "Tax",
  };
  assert.deepEqual(gl(check, "nothing"), { ok: true, missing: [] });
  assert.deepEqual(gl({ ...check, b: { const: 5 } }, "nothing").missing.map((m) => m.path), ["b.const"], "only b.const among them");
  assert.deepEqual(gl({ where: [{ cmp: "equals", value: "x" }, { cmp: "empty" }, { cmp: "notEmpty" }] }, "nothing"), { ok: true, missing: [] }, "equals, empty, notEmpty carry no literal");
  assert.deepEqual(gl({ where: [{ cmp: "weird", value: "x" }, null, 5, "s", [], {}] }, "nothing").missing.map((m) => [m.path, m.kind]), [0, 1, 2, 3, 4, 5].map((i) => [`where[${i}]`, "invalid"]), "an unknown cmp or a non-object entry is missing: we cannot tell it has no literal");
});

test("groundedLiterals: a literal of the wrong type is itself missing, with its path", () => {
  const wrong = gl(cell({ where: [{ column: "A", cmp: "gt", value: "5" }, { column: "A", cmp: "gt", value: NaN }, { column: "A", cmp: "gt", value: Infinity }, { column: "A", cmp: "between", hi: 5 }, { column: "D", cmp: "before", value: "2026-1-1" }, { column: "D", cmp: "after", value: "2026-02-30" }, { column: "D", cmp: "dateOn", value: 20261118 }, { column: "A", cmp: "eq", value: 1e21 }], asOf: 5, b: { const: "7" } }), "5 7 1 2026 20261118");
  assert.deepEqual(wrong.missing.map((m) => [m.path, m.kind]), [["where[0].value", "number"], ["where[1].value", "number"], ["where[2].value", "number"], ["where[3].lo", "number"], ["where[4].value", "date"], ["where[5].value", "date"], ["where[6].value", "date"], ["where[7].value", "number"], ["asOf", "date"], ["b.const", "number"]]);
  assert.equal(wrong.missing[3].value, "undefined");
  assert.equal(wrong.ok, false);
  // a literal that IS right passes next to them
  assert.deepEqual(gl(cell({ where: [{ column: "A", cmp: "gt", value: 5 }] }), "over 5").missing, []);
});

test("groundedLiterals: a non-object check and a non-string text", () => {
  for (const bad of [null, undefined, 5, "x", [], true, () => 1]) {
    const r = gl(bad, "text");
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].path, "");
    assert.equal(r.missing[0].kind, "check");
  }
  const check = cell({ where: [{ column: "A", cmp: "gt", value: 5 }], asOf: "2026-01-01" });
  for (const text of [undefined, null, 5, {}]) {
    const r = gl(check, text);
    assert.equal(r.ok, false);
    assert.equal(r.why, "not-a-string");
    assert.deepEqual(r.missing.map((m) => m.path), ["where[0].value", "asOf"]);
  }
  assert.equal(gl(cell({}), "x").ok, true, "a check with no literals is ok");
  assert.deepEqual(gl({}, "x"), { ok: true, missing: [] });
});

test("groundedLiterals never throws on a hostile check: getters, Proxies, inherited fields, __proto__ keys; own properties only", () => {
  const boom = () => { throw new Error("boom"); };
  assert.deepEqual(gl({ get where() { boom(); } }, "x").missing.map((m) => [m.path, m.kind, m.value]), [["where", "invalid", "unreadable"]]);
  assert.deepEqual(gl({ where: [{ get cmp() { boom(); }, value: 1 }] }, "x").missing.map((m) => [m.path, m.kind, m.value]), [["where[0]", "invalid", "unreadable"]]);
  assert.equal(gl({ where: [new Proxy({}, { get() { throw 1; }, ownKeys() { throw 1; }, getOwnPropertyDescriptor() { throw 1; }, has() { throw 1; } })] }, "5").ok, false);
  assert.deepEqual(gl({ where: [new Proxy({}, { get() { throw 1; }, ownKeys() { throw 1; }, getOwnPropertyDescriptor() { throw 1; }, has() { throw 1; } })] }, "5").missing.map((m) => m.path), ["where[0]"]);
  const thrower = [];
  Object.defineProperty(thrower, 0, { get() { throw 1; } });
  assert.deepEqual(gl({ where: thrower }, "5").missing.map((m) => m.path), ["where[0]"]);
  assert.deepEqual(gl({ where: [{ cmp: "gt", get value() { boom(); } }] }, "x").missing.map((m) => [m.path, m.value]), [["where[0].value", "unreadable"]]);
  assert.deepEqual(gl({ where: [{ column: "A", cmp: "gt", value: 1 }], get asOf() { boom(); } }, "1").missing.map((m) => [m.path, m.value]), [["asOf", "unreadable"]]);
  assert.deepEqual(gl({ get b() { boom(); } }, "x"), { ok: true, missing: [] }, "an unreadable b is not a const literal");
  assert.doesNotThrow(() => gl(new Proxy({}, { get: boom, ownKeys: boom, has: boom, getOwnPropertyDescriptor: boom, getPrototypeOf: boom }), "x"));
  assert.doesNotThrow(() => gl({ where: new Proxy([], { get: boom }) }, "x"));
  const inherited = Object.create({ where: [{ column: "A", cmp: "gt", value: 99 }], asOf: "2026-01-01" });
  assert.deepEqual(gl(inherited, "x"), { ok: true, missing: [] }, "inherited fields are not the check's own");
  const proto = JSON.parse('{"__proto__": {"where": [{"column":"A","cmp":"gt","value":99}]}, "where": [{"column":"A","cmp":"gt","value":1}]}');
  assert.deepEqual(gl(proto, "x").missing.map((m) => m.path), ["where[0].value"]);
  assert.equal(({}).where, undefined);
});

test("groundedLiterals: a fresh result each call; the check is never mutated (a deep-frozen one works)", () => {
  const check = Object.freeze(cell({ where: Object.freeze([Object.freeze({ column: "A", cmp: "gt", value: 5 })]) }));
  const a = gl(check, "x");
  a.missing.push("junk");
  a.missing[0].value = "mutated";
  const b = gl(check, "x");
  assert.deepEqual(b.missing, [{ path: "where[0].value", kind: "number", value: 5 }]);
  assert.notEqual(a.missing, b.missing);
  assert.equal(check.where[0].value, 5);
});

test("groundedLiterals equals groundedValues on the extracted literals (differential)", () => {
  const texts = ["5 2026-01-01", "over $5 since 2026-01-01", "5k and 2026-1-1", "", "-5", "(5)"];
  const check = cell({ where: [{ column: "A", cmp: "gt", value: 5 }, { column: "D", cmp: "after", value: "2026-01-01" }], asOf: "2026-01-01", b: { const: 5 } });
  const lits = [{ kind: "number", value: 5 }, { kind: "date", value: "2026-01-01" }, { kind: "date", value: "2026-01-01" }, { kind: "number", value: 5 }];
  for (const t of texts) {
    const a = gl(check, t);
    const b = groundedValues(lits, t);
    assert.equal(a.ok, b.ok, t);
    assert.deepEqual(a.missing.map((m) => m.value), b.missing.map((m) => m.value), t);
    assert.deepEqual(a.missing.map((m) => m.kind), b.missing.map((m) => m.kind), t);
  }
});

test("scope vs the vocabulary: every field groundedLiterals reads is a documented `where` / `asOf` / `b` field", () => {
  const f = rubricVocabulary.rules.table.fields;
  for (const k of ["where", "b"]) assert.ok(f[k]);
  assert.ok(rubricVocabulary.rules.cells.fields.asOf);
  assert.deepEqual(rubricVocabulary.rules.cells.fields.where.cmpKinds.number, ["gt", "gte", "lt", "lte", "eq", "between"]);
  assert.deepEqual(rubricVocabulary.rules.cells.fields.where.cmpKinds.date, ["before", "after", "dateBetween", "dateOn"]);
});

// ---- differential against the cited number reader ----------------------------------------------------------------------------------------

test("differential: a text the cited `number` reader reads as one value is grounded here for that value (20,000 random texts)", () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alphabet = "0123456789,.-+ $x";
  let agreed = 0;
  for (let i = 0; i < 20000; i++) {
    let s = "";
    for (let k = 1 + rnd(8); k > 0; k--) s += alphabet[rnd(alphabet.length)];
    const c = parseClaimValue("number", s);
    if (!c.ok) continue;
    agreed++;
    const v = Number(c.canon);
    assert.equal(g1("number", v, s), true, `cited reads ${JSON.stringify(s)} as ${c.canon}; groundedValues does not ground it`);
  }
  assert.ok(agreed > 500, `${agreed} texts read by both`);
});

// ---- the two time readers disagree on purpose: pinned side by side ------------------------------------------------------

test("time readers: grounded reads any-case am/pm, the cited time reader calls lowercase malformed (a change to either goes red)", () => {
  // groundedValues (suffixAt in rubric-grounded.js): "9:27 am" grounds 09:27. cited (readTime in rubric-locate.js, #34): malformed.
  assert.equal(g1("time", "09:27", "9:27 am"), true);
  assert.equal(g1("time", "09:27", "9:27 AM"), true);
  assert.equal(g1("time", "09:27", "9:27 a.m."), false, "dotted: refused by both");
  assert.equal(extractValue({ valueKind: "time" }, "9:27 AM").value, 567);
  assert.equal(extractValue({ valueKind: "time" }, "9:27 am").kind, "value-malformed");
  assert.equal(extractValue({ valueKind: "time" }, "9:27 a.m.").kind, "value-malformed");
});
