import test from "node:test";
import assert from "node:assert/strict";
import { createRubric, checkStep, renderGaps } from "../src/index.js";
import { mk } from "./_cells-helpers.js";

// Two fixtures shaped like fwdloop's real jobs, with INVENTED values: an expenses table (Tax blank in half the rows) and an
// AR aging table (Days overdue and bucket columns blank, waiting to be filled). Driven through createRubric + checkStep.

const rubricOf = (checks) => createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks } } });
const run = (checks, tables, output) => checkStep(rubricOf(checks), "cp", output ?? { a: 1 }, { tables });
const kinds = (r) => r.gaps.map((g) => g.kind);

// --- expenses ---------------------------------------------------------------------------------------------

const EXP = mk(["Date", "Description", "Amount", "Tax"], [
  ["2026-01-03", "Team lunch", "84.50", "8.45"],
  ["2026-01-05", "Laptop stand", "129.00", ""],
  ["2026-01-09", "Conference pass", "1,250.00", "125.00"],
  ["2026-01-12", "Taxi", "36.20", ""],
  ["2026-01-15", "Server hosting", "640.00", "64.00"],
  ["2026-01-19", "Printer toner", "212.75", ""],
  ["2026-01-22", "Client dinner", "515.40", "51.54"],
  ["2026-01-26", "Software licence", "899.99", ""],
  ["2026-02-02", "Office chairs", "1,480.00", "148.00"],
  ["2026-02-04", "Courier", "22.10", ""],
  ["2026-02-09", "Training course", "500.00", "50.00"], // exactly 500: NOT over 500
  ["2026-02-11", "Flight", "731.25", ""],
]);
const OVER = [4, 6, 8, 9, 10, 13]; // rows whose Amount is > 500
const over500 = [{ column: "Amount", cmp: "gt", value: 500 }];
const expenses = (claim, op, extra = {}) => ({ id: op, rule: "cells", table: "e", claim: "answer", op, ...extra, _c: claim });
const runExp = (op, extra, claim) => {
  const { _c, ...check } = expenses(claim, op, extra);
  return run([check], { e: EXP }, { answer: claim });
};

test("expenses: the table really holds 12 rows, 6 of them over 500, Tax blank in 6", async () => {
  assert.equal((await runExp("rows", { where: over500 }, { rows: OVER })).verdict, "green");
  assert.equal((await runExp("countEmpty", { column: "Tax" }, { value: 6 })).verdict, "green");
  assert.equal((await runExp("count", { column: "Amount" }, { value: 12 })).verdict, "green");
});

test("expenses rows: the exact claim is green and carries the expected answer in full, not in gaps", async () => {
  const r = await runExp("rows", { where: over500 }, { rows: OVER });
  assert.equal(r.verdict, "green");
  assert.deepEqual(r.full.expected, [{ check: "rows", rows: OVER }]);
  assert.deepEqual(r.gaps, []);
});

test("expenses rows: one EXTRA row (500.00 is not over 500) -> red rows-extra naming row 12", async () => {
  const r = await runExp("rows", { where: over500 }, { rows: [...OVER, 12] });
  assert.equal(r.verdict, "red");
  assert.deepEqual(kinds(r), ["rows-extra"]);
  assert.deepEqual(r.gaps[0].items, ["12"]);
  assert.equal(r.gaps[0].itemsTotal, undefined, "not truncated");
  assert.equal(r.gaps[0].field, "answer");
  assert.deepEqual(r.full.expected[0].rows, OVER, "the expected answer is in full");
  assert.ok(!JSON.stringify(r.gaps).includes("1250") && !JSON.stringify(r.gaps).includes("5516"), "no amount leaks into a gap");
});

test("expenses rows: one MISSING row -> red rows-missing naming row 13", async () => {
  const r = await runExp("rows", { where: over500 }, { rows: OVER.filter((n) => n !== 13) });
  assert.equal(r.verdict, "red");
  assert.deepEqual(kinds(r), ["rows-missing"]);
  assert.deepEqual(r.gaps[0].items, ["13"]);
});

test("expenses rows: extra AND missing together are two typed gaps", async () => {
  const r = await runExp("rows", { where: over500 }, { rows: [4, 6, 8, 9, 10, 12] });
  assert.deepEqual(kinds(r).sort(), ["rows-extra", "rows-missing"]);
});

test("expenses rows by keys: a multiset of descriptions, needs the signed keyColumn", async () => {
  const keys = ["Conference pass", "Server hosting", "Client dinner", "Software licence", "Office chairs", "Flight"];
  assert.equal((await runExp("rows", { where: over500, keyColumn: "Description" }, { keys })).verdict, "green");
  const r = await runExp("rows", { where: over500, keyColumn: "Description" }, { keys: [...keys.slice(1), "Taxi"] });
  assert.deepEqual(kinds(r).sort(), ["keys-extra", "rows-missing"]);
  assert.deepEqual(r.gaps.find((g) => g.kind === "keys-extra").items, ["Taxi"]);
  assert.deepEqual(r.gaps.find((g) => g.kind === "rows-missing").items, ["4"]);
});

test("expenses countIf / sumIf / averageIf over Amount > 500", async () => {
  assert.equal((await runExp("countIf", { where: over500 }, { value: 6 })).verdict, "green");
  assert.equal((await runExp("countIf", { where: over500 }, { value: 7 })).verdict, "red");
  assert.equal((await runExp("countIf", { where: over500 }, { value: 5 })).verdict, "red");
  assert.equal((await runExp("sumIf", { column: "Amount", where: over500 }, { value: 5516.64 })).verdict, "green");
  assert.equal((await runExp("sumIf", { column: "Amount", where: over500 }, { value: "5,516.64" })).verdict, "green", "a claim string reads like a cell");
  assert.equal((await runExp("sumIf", { column: "Amount", where: over500 }, { value: 5516.66 })).verdict, "red");
  assert.equal((await runExp("averageIf", { column: "Amount", where: over500 }, { value: 919.44 })).verdict, "green");
  assert.equal((await runExp("averageIf", { column: "Amount", where: over500 }, { value: 919.5 })).verdict, "red");
  const r = await runExp("sumIf", { column: "Amount", where: over500 }, { value: 5516.64 });
  assert.equal(r.full.expected[0].value, 5516.64);
});

test("expenses: a gap shows the claimed value, never the expected one", async () => {
  const r = await runExp("sumIf", { column: "Amount", where: over500 }, { value: 4000 });
  assert.equal(r.gaps[0].kind, "value-mismatch");
  assert.equal(r.gaps[0].measured, 4000);
  assert.equal(JSON.stringify(r.gaps).includes("5516"), false);
});

test("expenses: Tax is blank in half the rows: sum skips blanks, count and countEmpty split them, row math needs allowEmpty", async () => {
  assert.equal((await runExp("sum", { column: "Tax" }, { value: 446.99 })).verdict, "green");
  assert.equal((await runExp("count", { column: "Tax" }, { value: 6 })).verdict, "green");
  const tax = (extra) => run([{ id: "tax", rule: "table", table: "e", op: "rowMath", fn: "mul", a: "Amount", b: { const: 0.1 }, result: "Tax", where: [{ column: "Tax", cmp: "notEmpty" }], ...extra }], { e: EXP });
  // 10% of Amount on the rows that HAVE a Tax: 8.45, 125, 64, 51.54, 148, 50 are all 10% (to the cent)
  assert.equal((await tax({})).verdict, "green");
  const all = await run([{ id: "tax", rule: "table", table: "e", op: "rowMath", fn: "mul", a: "Amount", b: { const: 0.1 }, result: "Tax" }], { e: EXP });
  assert.equal(all.verdict, "red", "a blank RESULT is red");
  assert.ok(kinds(all).includes("result-empty"));
});

// --- AR aging ----------------------------------------------------------------------------------------------

const ASOF = "2026-10-31";
// due dates chosen so the days overdue are exactly the band edges: 0, 1, 30, 31, 90, 91 (+ 60 and -15)
const AR = mk(["Customer", "Invoice #", "Invoice date", "Due date", "Amount", "Days overdue", "Bucket"], [
  ["Harbor Foods", "INV-1001", "2026-10-01", "2026-10-31", "1,200.00", "", ""], // 0
  ["Birch Supply", "INV-1002", "2026-09-30", "2026-10-30", "480.50", "", ""], // 1
  ["Harbor Foods", "INV-1003", "2026-09-01", "2026-10-01", "75.00", "", ""], // 30
  ["Kite Labs", "INV-1004", "2026-09-01", "2026-09-30", "2,310.00", "", ""], // 31
  ["Birch Supply", "INV-1005", "2026-07-03", "2026-08-02", "960.00", "", ""], // 90
  ["Kite Labs", "INV-1006", "2026-07-02", "2026-08-01", "145.25", "", ""], // 91
  ["Orchard Co", "INV-1007", "2026-10-15", "2026-11-15", "300.00", "", ""], // -15
  ["Orchard Co", "INV-1008", "2026-08-02", "2026-09-01", "88.80", "", ""], // 60
]);
const DAYS = { 2: 0, 3: 1, 4: 30, 5: 31, 6: 90, 7: 91, 8: -15, 9: 60 };
const BANDS = [
  { name: "Current", lte: 0 },
  { name: "1-30", gte: 1, lte: 30 },
  { name: "31-60", gte: 31, lte: 60 },
  { name: "61-90", gte: 61, lte: 90 },
  { name: "90+", gt: 90 },
];
const BAND_OF = { 2: "Current", 3: "1-30", 4: "1-30", 5: "31-60", 6: "61-90", 7: "90+", 8: "Current", 9: "31-60" };
const ISO_DUE = [{ column: "Due date", format: "YYYY-MM-DD" }];
const daysCheck = (extra = {}) => ({ id: "days", rule: "cells", table: "ar", claim: "answer", op: "daysSince", column: "Due date", asOf: ASOF, dateFormats: ISO_DUE, ...extra });
const bandCheck = (extra = {}) => ({ id: "band", rule: "cells", table: "ar", claim: "answer", op: "band", column: "Due date", asOf: ASOF, dateFormats: ISO_DUE, bands: BANDS, ...extra });
const runAr = (check, claim, table = AR) => run([check], { ar: table }, { answer: claim });

test("AR aging: daysSince(Due date, asOf) for every row, claimed as a map of row -> days", async () => {
  const r = await runAr(daysCheck(), { days: DAYS });
  assert.equal(r.verdict, "green");
  assert.deepEqual(r.full.expected[0].days.map((d) => d.days), Object.values(DAYS));
});

test("AR aging: one wrong day count is red days-mismatch naming the row; a row left out is rows-missing", async () => {
  const wrong = await runAr(daysCheck(), { days: { ...DAYS, 5: 30 } });
  assert.deepEqual(kinds(wrong), ["days-mismatch"]);
  assert.deepEqual(wrong.gaps[0].items, ["5"]);
  const { 9: _gone, ...fewer } = DAYS;
  const missing = await runAr(daysCheck(), { days: fewer });
  assert.deepEqual(kinds(missing), ["rows-missing"]);
  assert.deepEqual(missing.gaps[0].items, ["9"]);
});

test("AR aging: every band edge (0, 1, 30, 31, 90, 91) lands in its band, and claiming the NEIGHBOUR band is red", async () => {
  assert.equal((await runAr(bandCheck(), { bands: BAND_OF })).verdict, "green");
  const neighbour = { 2: "1-30", 3: "Current", 4: "31-60", 5: "1-30", 6: "90+", 7: "61-90" }; // row -> the wrong adjacent band
  for (const [row, band] of Object.entries(neighbour)) {
    const r = await runAr(bandCheck(), { bands: { ...BAND_OF, [row]: band } });
    assert.equal(r.verdict, "red", `row ${row} claimed ${band}`);
    assert.deepEqual(r.gaps.map((g) => [g.kind, g.items]), [["band-mismatch", [row]]], `row ${row}`);
  }
});

test("AR aging: band names are exact (no case folding, no trimming)", async () => {
  assert.equal((await runAr(bandCheck(), { bands: { ...BAND_OF, 2: "current" } })).verdict, "red");
  assert.equal((await runAr(bandCheck(), { bands: { ...BAND_OF, 2: "Current " } })).verdict, "red");
});

test("AR aging: the Days overdue and Bucket columns are blank: banding them is red empty-operand unless the check signs allowEmpty", async () => {
  const blank = bandCheck({ column: "Days overdue", asOf: undefined, dateFormats: undefined });
  delete blank.asOf;
  delete blank.dateFormats;
  const r = await runAr(blank, { bands: {} });
  assert.equal(r.verdict, "red");
  assert.ok(kinds(r).includes("empty-operand"));
  assert.equal(r.gaps.find((g) => g.kind === "empty-operand").items.length, 8);
  const ok = await runAr({ ...blank, allowEmpty: true }, { bands: {} });
  assert.equal(ok.verdict, "green", "allowEmpty skips blank rows: an empty claim is the whole answer");
  const extra = await runAr({ ...blank, allowEmpty: true }, { bands: { 2: "Current" } });
  assert.deepEqual(kinds(extra), ["rows-extra"]);
});

test("AR aging: a filled Days overdue column can be banded directly (numbers, no dates)", async () => {
  const filled = mk(AR.header, AR.rows.map((r) => { const c = [...r.cells]; c[5] = String(DAYS[r.rowNumber]); return c; }));
  const chk = { id: "band", rule: "cells", table: "ar", claim: "answer", op: "band", column: "Days overdue", bands: BANDS };
  assert.equal((await runAr(chk, { bands: BAND_OF }, filled)).verdict, "green");
  const frac = mk(AR.header, [["x", "I", "2026-01-01", "2026-01-02", "1", "30.5", ""]]);
  const r = await runAr(chk, { bands: {} }, frac);
  assert.deepEqual(kinds(r), ["no-band"], "30.5 falls between 1-30 and 31-60: no band, red, never guessed");
});

test('AR aging: "every invoice appears exactly once" = rows over the whole table + noDuplicates on Invoice #', async () => {
  const checks = [
    { id: "all-rows", rule: "cells", table: "ar", claim: "answer", op: "rows", where: [{ column: "Invoice #", cmp: "notEmpty" }] },
    { id: "unique", rule: "table", table: "ar", op: "noDuplicates", column: "Invoice #" },
  ];
  const all = [2, 3, 4, 5, 6, 7, 8, 9];
  assert.equal((await run(checks, { ar: AR }, { answer: { rows: all } })).verdict, "green");
  const dropped = await run(checks, { ar: AR }, { answer: { rows: all.slice(1) } });
  assert.deepEqual(kinds(dropped), ["rows-missing"]);
  const dup = mk(AR.header, [...AR.rows.map((r) => r.cells), AR.rows[0].cells]);
  const d = await run(checks, { ar: dup }, { answer: { rows: [...all, 10] } });
  assert.equal(d.verdict, "red");
  assert.deepEqual(d.gaps.map((g) => [g.id, g.kind, g.items]), [["unique", "duplicate-values", ["2", "10"]]]);
});

test("AR aging: the same job with a D MMM YYYY due date column gives the same days", async () => {
  const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmt = (iso) => { const [y, m, d] = iso.split("-"); return `${+d} ${MONTH[+m - 1]} ${y}`; };
  const t = mk(AR.header, AR.rows.map((r) => { const c = [...r.cells]; c[3] = fmt(c[3]); return c; }));
  const chk = daysCheck({ dateFormats: [{ column: "Due date", format: "D MMM YYYY" }] });
  assert.equal((await runAr(chk, { days: DAYS }, t)).verdict, "green");
  assert.equal((await runAr(daysCheck(), { days: DAYS }, t)).verdict, "red", "the ISO format does not read them: unreadable-cell, never guessed");
});

test("AR aging: gaps render through renderGaps with an 'and N more' tail", async () => {
  const r = await runAr(daysCheck(), { days: Object.fromEntries(Object.keys(DAYS).map((k) => [k, 999])) });
  assert.equal(r.verdict, "red");
  assert.equal(renderGaps(r.gaps), "days: claimed days are wrong: 2, 3, 4, 5, 6, 7, 8, 9");
  const big = mk(["Due"], Array.from({ length: 25 }, () => ["2026-01-01"]));
  const rr = await run([{ id: "d", rule: "cells", table: "t", claim: "answer", op: "daysSince", column: "Due", asOf: "2026-01-02", dateFormats: [{ column: "Due", format: "YYYY-MM-DD" }] }], { t: big }, { answer: { days: Object.fromEntries(big.rows.map((x) => [x.rowNumber, 5])) } });
  assert.equal(rr.gaps[0].items.length, 20);
  assert.equal(rr.gaps[0].itemsTotal, 25);
  assert.equal(renderGaps(rr.gaps), "d: claimed days are wrong: 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21 and 5 more");
});
