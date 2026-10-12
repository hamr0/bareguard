import test from "node:test";
import assert from "node:assert/strict";
import { decideQuote, evalDecide, extractValue, parseBound, outcomeKey } from "../src/primitives/rubric-locate.js";

// The PURE decide core of the locate judge (docs/product/rubric-prd.md §5.2, §10). No judge, no gate.

const L =
  'link "From 59 US dollars. Nonstop flight with American. Operated by SkyWest Airlines as American Eagle. Leaves Los Angeles International Airport at 9:27 AM on Thursday, November 12 and arrives at San Francisco International Airport at 11:07 AM on Thursday, November 12. Total duration 1 hr 40 min. 1 carry-on bag included. 0 checked bags included. Select flight"';

const one = (quote, d) => decideQuote(quote, [d]);
const green = (quote, d, msg) => assert.equal(one(quote, d).ok, true, msg ?? `${quote} should be green ${JSON.stringify(one(quote, d))}`);
const red = (quote, d, kind, extra) => {
  const r = one(quote, d);
  assert.equal(r.ok, false, `${quote} should be red`);
  assert.equal(r.kind, kind, `${quote}: ${JSON.stringify(r)}`);
  if (extra) for (const [k, v] of Object.entries(extra)) assert.deepEqual(r[k], v, `${quote}: field ${k} in ${JSON.stringify(r)}`);
  return r;
};
const val = (valueKind, op, bound, more = {}) => ({ valueKind, op, ...(op === "between" ? bound : { value: bound }), ...more });
const between = (valueKind, lo, hi, more = {}) => val(valueKind, "between", { lo, hi }, more);
const money = (op, v, more = {}) => val("money", op, v, { currency: "$", ...more });

test("E1: date gte, real changelog line, AT/UNDER", () => {
  const d = val("date", "gte", "2026-10-01");
  green("## [0.41.0] - 2026-10-12", d);
  red("## [0.41.0] - 2026-09-12", d, "value-under", { measured: "2026-09-12", limit: "2026-10-01", direction: "at-least" });
  green("## [1.0.0] - 2026-10-01", d); // AT
  red("## [1.0.0] - 2026-09-30", d, "value-under");
});

test("E2: money $ lt 400, anchor / no anchor / over / AT / under", () => {
  const q = "Alaska 1234 · LAX 08:10 → SFO 09:35 · Nonstop · Total: $318.40";
  green(q, money("lt", 400, { anchor: "Total:" }));
  green(q, money("lt", 400)); // exactly one $ value
  red("Total: $409.00", money("lt", 400, { anchor: "Total:" }), "value-over", { measured: "409", limit: "400", direction: "below" });
  red("Total: $400.00", money("lt", 400, { anchor: "Total:" }), "value-over"); // lt is strict
  green("Total: $399.99", money("lt", 400, { anchor: "Total:" }));
});

test("E3 traps: anchor-missing, was-price, value-many", () => {
  red("From $349 + taxes and fees", money("lt", 400, { anchor: "Total:" }), "anchor-missing", { anchor: "Total:", measured: 0 });
  green("Total: $318.40 (was $420)", money("lt", 400, { anchor: "Total:" }));
  red("Total: $318.40 (was $420)", money("lt", 400), "value-many", { measured: 2, values: ["318.4", "420"], items: ["d0:value-many"] });
});

test("departure window: no anchor many, anchor, over, AT inclusive both ends, lo>hi bound parse", () => {
  const w = between("time", "06:00", "21:00");
  red("LAX 08:10 → SFO 09:35", w, "value-many", { measured: 2 });
  const wa = between("time", "06:00", "21:00", { anchor: "LAX " });
  green("LAX 08:10 → SFO 09:35", wa);
  red("LAX 22:45 → SFO 00:10", wa, "value-over", { measured: "22:45", limit: "21:00", direction: "at-most" });
  green("LAX 06:00", wa);
  green("LAX 21:00", wa);
  red("LAX 05:59", wa, "value-under", { measured: "05:59", limit: "06:00", direction: "at-least" });
  red("LAX 21:01", wa, "value-over");
});

test("E4 REAL Google Flights link line", () => {
  const checks = [
    val("money", "lt", 400, { unit: "US dollars", anchor: "From " }),
    between("time", "06:00", "21:00", { anchor: "Leaves Los Angeles International Airport at " }),
    { phrases: ["Nonstop flight"] },
  ];
  const r = decideQuote(L, checks);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.results.map((x) => x.extracted), ["59", 567, undefined]);
  // arrival decide as an extra illustration
  green(L, val("time", "lte", "12:00", { anchor: "arrives at San Francisco International Airport at " }));
  red(L, val("time", "lte", "11:00", { anchor: "arrives at San Francisco International Airport at " }), "value-over", { measured: "11:07", limit: "11:00" });
  // unit lt 59 over; From 409 over
  red(L, val("money", "lt", 59, { unit: "US dollars", anchor: "From " }), "value-over");
  red('link "From 409 US dollars. Nonstop flight"', val("money", "lt", 400, { unit: "US dollars", anchor: "From " }), "value-over", { measured: "409", limit: "400" });
  // symbol money on that line is value-none (anchored and not)
  red(L, money("lt", 400, { anchor: "From " }), "value-none", { anchor: "From " });
  red(L, money("lt", 400), "value-none");
  red('generic "59 US dollars"', money("lt", 400), "value-none");
  // the whole check: fourth (symbol) decide is the only red
  const all = decideQuote(L, [...checks, money("lt", 400, { anchor: "From " })]);
  assert.equal(all.ok, false);
  assert.deepEqual(all.items, ["d3:value-none"]);
  // unanchored time on L holds two times
  red(L, between("time", "06:00", "21:00"), "value-many", { measured: 2 });
});

test("12-hour time (#34)", () => {
  const dep = between("time", "06:00", "21:00", { anchor: "Departure time: " });
  green('generic "Departure time: 9:27 AM."', dep); // trailing period
  assert.equal(extractValue({ valueKind: "time", anchor: "T " }, "T 12:05 AM").value, 5);
  assert.equal(extractValue({ valueKind: "time", anchor: "T " }, "T 12:05 PM").value, 725);
  green("T 12:05 AM", val("time", "lt", "01:00", { anchor: "T " }));
  green("T 12:05 PM", val("time", "gte", "12:00", { anchor: "T " }));
  red("T 12:05 PM", val("time", "lt", "01:00", { anchor: "T " }), "value-over");
  red("T 9:27 PM", between("time", "06:00", "21:00", { anchor: "T " }), "value-over");
  green("T 9:00 PM", between("time", "06:00", "21:00", { anchor: "T " }));
  red("T 9:01 PM", between("time", "06:00", "21:00", { anchor: "T " }), "value-over");
  green("T 6:00 AM", between("time", "06:00", "21:00", { anchor: "T " }));
  red("T 5:59 AM", between("time", "06:00", "21:00", { anchor: "T " }), "value-under");
  assert.equal(extractValue({ valueKind: "time" }, "09:27 AM").value, 567);
  assert.deepEqual(parseBound("time", "9:00 PM"), { ok: true, value: 1260, canon: 1260 });
  assert.equal(parseBound("time", "13:00 PM").ok, false);
  assert.equal(parseBound("time", "9:00 PM x").ok, false);
  // trailing punctuation
  green("Total: $59, nonstop", money("lt", 400, { anchor: "Total: " }));
  assert.equal(extractValue({ valueKind: "number" }, "59.").canon, "59");
});

test("malformed times are never read as 24-hour", () => {
  for (const bad of ["0:30 AM", "00:30 AM", "13:05 PM", "9:27 am", "9:27 Am", "9:27 pM", "9:27AM", "9:27 a.m.", "9:27 p.m.", "9:27 AMX", "9:27 PMS", "9:27 AMD", "9:27:", "24:00", "8:7", "08:10:30", "123:45", "08:10am", "2026-10-12T08:00", "-08:10", "−08:10", "9:60"]) {
    red(bad, { valueKind: "time", op: "gte", value: "00:00" }, "value-malformed");
  }
  assert.equal(extractValue({ valueKind: "time" }, "9:27 American").value, 567); // a word, not the suffix
  assert.equal(extractValue({ valueKind: "time" }, "00:30").value, 30);
  assert.equal(extractValue({ valueKind: "time" }, "23:59").value, 23 * 60 + 59);
  assert.equal(extractValue({ valueKind: "time" }, "Total: 5 and 1234").kind, "value-none"); // ":" and bare digits are no time
  // two spaces / a tab: refused by the reader on RAW text. normalizeForQuote collapses them to ONE space before
  // decideQuote ever sees them (spec ambiguity, see the Module 1 report), so through decideQuote they read 09:27 AM.
  assert.equal(extractValue({ valueKind: "time" }, "9:27  AM").kind, "value-malformed");
  assert.equal(extractValue({ valueKind: "time" }, "9:27\tAM").kind, "value-malformed");
  assert.equal(one("T 9:27  AM", val("time", "lt", "12:00", { anchor: "T " })).ok, true);
});

test("presence decide (#35)", () => {
  const p = { phrases: ["Nonstop flight"] };
  green(L, p);
  green("a NONSTOP FLIGHT here", p);
  red("1 stop with Delta", p, "phrase-missing", { measured: "Nonstop flight" });
  red('StaticText "Nonstop"', p, "phrase-missing");
  red(L, { phrases: ["Nonstop flight", "Delta"] }, "phrase-missing", { measured: "Delta" });
  green("**Nonstop**   flight", p); // normalized
});

test("co-location list: all evaluated, first red's kind, items in signed order", () => {
  const checks = [between("time", "06:00", "21:00", { anchor: "Leaves Los Angeles International Airport at " }), val("time", "lte", "11:00", { anchor: "arrives at San Francisco International Airport at " }), { phrases: ["Nonstop flight"] }];
  const r = decideQuote(L, checks);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "value-over");
  assert.equal(r.measured, "11:07");
  assert.equal(r.limit, "11:00");
  assert.deepEqual(r.items, ["d1:value-over"]);
  const both = decideQuote("Leaves at 22:00 and 1 stop", [{ phrases: ["Nonstop flight"] }, val("time", "lt", "12:00")]);
  assert.equal(both.kind, "phrase-missing"); // first in signed order, not the first kind found
  assert.deepEqual(both.items, ["d0:phrase-missing", "d1:value-over"]);
  assert.equal(both.results.length, 2);
  // bounded items
  const many = decideQuote("x", Array.from({ length: 30 }, () => ({ phrases: ["y"] })));
  assert.equal(many.items.length, 20);
  assert.equal(many.itemsTotal, 30);
  assert.throws(() => decideQuote("x", []), TypeError);
});

test("money unit (#43)", () => {
  const u = (op, v, more = {}) => val("money", op, v, { unit: "US dollars", ...more });
  green("From 59 US dollars.", u("lt", 400, { anchor: "From " }));
  assert.equal(extractValue({ valueKind: "money", unit: "US dollars", anchor: "From " }, "From 1,234 US dollars.").canon, "1234");
  red("From 1,234 US dollars.", u("lt", 400, { anchor: "From " }), "value-over");
  green("From 1,234 US dollars.", u("gt", 1000, { anchor: "From " }));
  red("From 400 US dollars", u("lt", 400, { anchor: "From " }), "value-over");
  green("From 399.99 US dollars", u("lt", 400, { anchor: "From " }));
  for (const q of ["59 US dollars.", "59 US dollars, x", "(59 US dollars)".replace("(", "x ")]) green(q, u("lt", 400));
  green("(x 59 US dollars)", u("lt", 400));
  for (const q of ["From 59 dollars.", "From 59.", "From 59US dollars", "From 59 US dollarsX", "From 59 us dollars", "From 59 US Dollars"]) {
    red(q, u("lt", 400, { anchor: "From " }), "value-none", { anchor: "From " });
  }
  red("59 US dollars and 61 US dollars", u("lt", 400), "value-many", { values: ["59", "61"] });
  green("took 1 hr 40 min, 0 checked bags, 59 US dollars", u("lt", 400));
  red("v59 US dollars", u("lt", 400), "value-malformed");
  red("-59 US dollars", u("lt", 400), "value-malformed");
  red("1.2k US dollars", u("lt", 400), "value-malformed");
  red("12,34 US dollars", u("lt", 400), "value-malformed");
  red("0 checked bags included", u("lt", 400), "value-none");
});

test("value edge cases: none, zero, many, malformed, signs, separators", () => {
  const n = (op, v, m) => val("number", op, v, m);
  red("no price listed", money("lt", 400), "value-none");
  green("$0.00", money("lt", 400));
  green("0", n("lt", 5));
  red("2 weeks and 3 days", n("lt", 5), "value-many", { measured: 2 });
  for (const bad of ["0.41.0", "12,34", "1.2k", "5m", "v2", "1,2", ".5", "1.2.3", "5.k"]) red(bad, n("lt", 5), "value-malformed");
  for (const bad of ["$5USD", "-$5", "−$5", "($5)", "US$5"]) red(bad, money("lt", 400), "value-malformed");
  for (const bad of ["−5", "(5)"]) red(bad, n("lt", 50), "value-malformed");
  assert.equal(extractValue({ valueKind: "number" }, "-5").canon, "-5");
  assert.equal(extractValue({ valueKind: "number" }, "x (-5)").canon, "-5");
  assert.equal(extractValue({ valueKind: "number" }, "+5").canon, "5");
  assert.equal(extractValue({ valueKind: "number" }, "2026-10").ok, false); // two values, '-' is a separator
  assert.equal(extractValue({ valueKind: "number" }, "2026-10").kind, "value-many");
  assert.equal(extractValue({ valueKind: "number" }, "50% off").canon, "50");
  assert.equal(extractValue({ valueKind: "number" }, "1,234.50").canon, "1234.5");
  assert.equal(extractValue({ valueKind: "number" }, "007.500").canon, "7.5");
  assert.equal(extractValue({ valueKind: "number" }, "-0.0").canon, "0");
  assert.equal(extractValue({ valueKind: "number" }, "٥٦").kind, "value-none"); // non-ASCII digits
  assert.equal(extractValue(money("lt", 1), "€400").kind, "value-none"); // other symbol ignored, not malformed
  assert.equal(extractValue(money("lt", 1), "$ 400").kind, "value-none");
  assert.equal(extractValue(money("lt", 1), "$abc").kind, "value-none");
});

test("AT / UNDER / OVER for each op (number, exact)", () => {
  const at = (op, v, q) => one(`x ${q}`, val("number", op, v)).ok;
  assert.equal(at("lt", 5, "4"), true); assert.equal(at("lt", 5, "5"), false); assert.equal(at("lt", 5, "6"), false);
  assert.equal(at("lte", 5, "4"), true); assert.equal(at("lte", 5, "5"), true); assert.equal(at("lte", 5, "6"), false);
  assert.equal(at("gt", 5, "4"), false); assert.equal(at("gt", 5, "5"), false); assert.equal(at("gt", 5, "6"), true);
  assert.equal(at("gte", 5, "4"), false); assert.equal(at("gte", 5, "5"), true); assert.equal(at("gte", 5, "6"), true);
  const b = (q) => one(`x ${q}`, val("number", "between", { lo: 2, hi: 4 })).ok;
  assert.equal(b("1"), false); assert.equal(b("2"), true); assert.equal(b("3"), true); assert.equal(b("4"), true); assert.equal(b("4.0001"), false); assert.equal(b("1.9999"), false);
  // directions
  assert.equal(one("x 9", val("number", "lte", 5)).direction, "at-most");
  assert.equal(one("x 9", val("number", "lt", 5)).direction, "below");
  assert.equal(one("x 1", val("number", "gt", 5)).direction, "above");
  assert.equal(one("x 1", val("number", "gte", 5)).direction, "at-least");
  assert.equal(one("x 1", val("number", "between", { lo: 2, hi: 4 })).limit, "2");
  assert.equal(one("x 9", val("number", "between", { lo: 2, hi: 4 })).limit, "4");
  // negatives
  assert.equal(one("x -5", val("number", "lt", -4)).ok, true);
  assert.equal(one("x -5", val("number", "gt", -6)).ok, true);
  assert.equal(one("x -5", val("number", "gt", -5)).ok, false);
});

test("decimal exactness: no floats", () => {
  // 0.1 + 0.2 style: 0.30000000000000004 is a distinct, larger exact decimal
  assert.equal(one("x 0.30000000000000004", val("number", "gt", 0.3)).ok, true);
  assert.equal(one("x 0.3", val("number", "lte", 0.3)).ok, true);
  assert.equal(one("x 0.30", val("number", "lte", 0.3)).ok, true);
  const big = "123456789012345678901234567890";
  assert.equal(extractValue({ valueKind: "number" }, `x ${big}`).canon, big);
  assert.equal(one(`x ${big}`, val("number", "gt", 9007199254740992)).ok, true);
  assert.equal(one("x 9007199254740993", val("number", "gt", 9007199254740992)).ok, true); // not representable as a float
  assert.equal(parseBound("number", 1e21).ok, false);
  assert.equal(parseBound("number", NaN).ok, false);
  assert.equal(parseBound("number", "5").ok, false);
  assert.equal(parseBound("money", 0.1).canon, "0.1");
  assert.equal(parseBound("date", "2026-02-30").ok, false);
  assert.equal(parseBound("date", "2026-02-28").ok, true);
  assert.equal(parseBound("date", 20260101).ok, false);
});

test("dates: shape, calendar, year range, adjacency", () => {
  const d = val("date", "gte", "0001-01-01");
  assert.equal(extractValue({ valueKind: "date" }, "on 2024-02-29.").canon, "2024-02-29");
  red("2026-13-45", d, "value-malformed");
  red("2026-02-30", d, "value-malformed");
  red("2023-02-29", d, "value-malformed");
  red("0000-01-01", d, "value-malformed");
  red("2026-10-12T08:00", d, "value-malformed");
  red("v2026-10-12", d, "value-malformed");
  green("0001-01-01", d);
  green("9999-12-31", d);
  assert.equal(extractValue({ valueKind: "date" }, "12026-10-12").kind, "value-none");
  assert.equal(extractValue({ valueKind: "date" }, "0.41.0 - 1234").kind, "value-none");
  assert.equal(extractValue({ valueKind: "date" }, "2026-10-12 and 2026-10-13").kind, "value-many");
  assert.equal(extractValue({ valueKind: "date" }, "-2026-10-12").kind, "value-none"); // run includes the leading '-'
});

test("anchors", () => {
  const a = (anchor, more = {}) => val("number", "gte", 0, { anchor, ...more });
  green("Total: 5", a("Total:"));
  red("Total: 5 Total: 6", a("Total:"), "anchor-ambiguous", { measured: 2, anchor: "Total:" });
  red("Total: see $400", money("lt", 500, { anchor: "Total:" }), "value-none", { anchor: "Total:" });
  assert.equal(extractValue({ valueKind: "number", anchor: "LAX " }, "LAX 7 SFO 9").canon, "7"); // 'LAX ' equals 'LAX'
  red("total: 5", a("Total:"), "anchor-missing"); // case-sensitive
  green("**Total:**    5", a("Total:")); // normalized by decideQuote
  // two decides, two anchors, one quote
  const r = decideQuote("A 3 B 8", [val("number", "lt", 5, { anchor: "A" }), val("number", "gt", 5, { anchor: "B" })]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => x.extracted), ["3", "8"]);
  // anchor then malformed token
  red("Total: 1.2k", a("Total:"), "value-malformed");
  // anchor then sign
  assert.equal(extractValue({ valueKind: "number", anchor: "Delta:" }, "Delta: -5").canon, "-5");
  // blank / whitespace anchors fail closed
  red("5", a("**"), "anchor-missing");
});

test("hostile: non-string quote, never throws", () => {
  for (const q of [undefined, null, 5, {}, [], Symbol("x"), () => 1, { toString() { throw new Error("x"); } }]) {
    const r = decideQuote(q, [val("number", "lt", 5), { phrases: ["a"] }]);
    assert.equal(r.ok, false);
    assert.equal(r.items.length, 2);
  }
  assert.equal(extractValue({ valueKind: "bogus" }, "5").ok, false);
  assert.equal(extractValue({ valueKind: "number" }, undefined).ok, false);
});

test("hostile: pathological inputs, linear on 5 MiB", () => {
  const MiB5 = 5 * 1024 * 1024;
  const cases = {
    digits: "7".repeat(MiB5),
    commas: "1,".repeat(MiB5 / 2),
    dotsdigits: "1.".repeat(MiB5 / 2),
    anchors: "Total: ".repeat(MiB5 / 7),
    numbers: "1 ".repeat(MiB5 / 2),
    times: "12:05 AM ".repeat(Math.floor(MiB5 / 9)),
    dates: "2026-10-12 ".repeat(Math.floor(MiB5 / 11)),
    money: "$1,234.50 ".repeat(Math.floor(MiB5 / 10)),
    units: "5 US dollars ".repeat(Math.floor(MiB5 / 13)),
    dashes: "-".repeat(MiB5),
    colons: ":".repeat(MiB5),
    mixed: "09:27 AM 1.2k $5USD (5) -5 −5 a.m. ".repeat(Math.floor(MiB5 / 36)),
  };
  const decs = [
    val("number", "lt", 5), money("lt", 5), val("money", "lt", 5, { unit: "US dollars" }), val("date", "gte", "2026-01-01"), val("time", "lt", "12:00"),
    val("number", "lt", 5, { anchor: "Total:" }), val("time", "lt", "12:00", { anchor: "Total: " }), { phrases: ["zzz"] },
  ];
  let worst = 0;
  const t0 = process.hrtime.bigint();
  for (const [name, q] of Object.entries(cases)) {
    for (const d of decs) {
      const t1 = process.hrtime.bigint();
      const r = decideQuote(q, [d]);
      const ms = Number(process.hrtime.bigint() - t1) / 1e6;
      worst = Math.max(worst, ms);
      assert.equal(typeof r.ok, "boolean", `${name}`);
      assert.ok(ms < 30000, `${name} ${JSON.stringify(d)} took ${ms}ms`); // includes the existing normalizeForQuote
    }
  }
  console.log(`# 5 MiB decide: worst single decide ${worst.toFixed(0)} ms, total ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms`);
  // extraction alone (no normalize) is linear: 5x the input costs well under 15x the time
  const tm = (q) => { const t1 = process.hrtime.bigint(); extractValue({ valueKind: "time" }, q); extractValue({ valueKind: "number" }, q); extractValue(money("lt", 1), q); return Number(process.hrtime.bigint() - t1) / 1e6; };
  const unit = "09:27 AM $5 12 2026-10-12 ";
  tm(unit.repeat(1000)); // warm up
  const small = tm(unit.repeat(MiB5 / 5 / unit.length | 0));
  const large = tm(unit.repeat(MiB5 / unit.length | 0));
  console.log(`# extraction only: 1 MiB ${small.toFixed(0)} ms, 5 MiB ${large.toFixed(0)} ms`);
  assert.ok(large < 10000 && large < small * 15 + 50, `not linear: ${small} -> ${large}`);
  // one huge number is still exact and bounded
  assert.equal(extractValue({ valueKind: "number" }, cases.digits).ok, true);
  assert.equal(one(cases.digits, val("number", "gt", 5)).ok, true);
});

test("outcomeKey: values and kinds, not quotes (#38)", () => {
  const ds = [between("time", "06:00", "21:00", { anchor: "T " }), { phrases: ["Nonstop"] }];
  const a = outcomeKey(decideQuote("Nonstop T 9:27 AM x", ds));
  const b = outcomeKey(decideQuote("T 09:27 AM Nonstop y", ds));
  assert.equal(a, b); // different quotes, same extracted values
  assert.notEqual(a, outcomeKey(decideQuote("T 10:15 AM Nonstop", ds))); // both green, different value
  assert.notEqual(a, outcomeKey(decideQuote("T 9:27 AM 1 stop", ds))); // presence differs
  assert.notEqual(a, outcomeKey(decideQuote("T 9:27 PM Nonstop", ds))); // over vs green
  // two reds with the same kinds and values do not disagree
  assert.equal(outcomeKey(decideQuote("T 22:00 x", ds)), outcomeKey(decideQuote("y T 22:00", ds)));
  // value-many carries its values
  assert.notEqual(outcomeKey(decideQuote("1 2", [val("number", "lt", 5)])), outcomeKey(decideQuote("1 3", [val("number", "lt", 5)])));
  assert.equal(typeof outcomeKey(null), "string");
});

test("evalDecide is pure: same input, same output", () => {
  const d = money("lt", 400, { anchor: "Total:" });
  assert.deepEqual(evalDecide(d, "Total: $5"), evalDecide(d, "Total: $5"));
});
