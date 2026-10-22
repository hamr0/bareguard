import test from "node:test";
import assert from "node:assert/strict";
import { readCellNumber, readCellDate } from "../src/primitives/rubric-cells.js";
import { MISSING, runCheck, mk } from "./_cells-helpers.js";

// cells / table / diff (docs/product/cells-prd.md, ruling #67): every op, condition, date format, shape check and diff check,
// plus the edge cases of the POC's synthetic suite. Driven through `evaluate` (so a broken check or table is visible as
// `stopped`, which createRubric would refuse earlier); test/rubric-cells-gate.test.js drives checkStep.

function T(name, check, tables, claim, expect, kind) {
  test(name, () => {
    const r = runCheck(check, tables, claim);
    assert.equal(r.verdict, expect, `${name}: ${JSON.stringify(r.gaps)} ${JSON.stringify(r.stopped)}`);
    if (kind !== undefined) assert.ok(r.gaps.some((g) => g.kind === kind) || r.stopped?.kind === kind, `${name}: wanted ${kind}, got ${JSON.stringify(r.gaps)} ${JSON.stringify(r.stopped)}`);
  });
}
const H = ["Id", "Date", "Cat", "Amount", "Tax", "Total"];
const D = [
  ["A1", "2026-01-05", "food", "$1,200.50", "100", "1300.50"],
  ["A2", "2026-01-10", "food", "300", "30", "330"],
  ["A3", "2026-02-01", "rent", "300", "", "300"],
  ["A4", "2026-02-15", "rent", "", "5", "5"],
  ["A5", "2026-03-01", "misc", "50", "5", "55"],
  ["A6", "2026-03-01", "misc", "700", "70", "770"],
  ["A7", "2026-03-20", "food", "300", "30", "330"],
];
const tb = { t: mk(H, D) };
const base = (op, extra = {}) => ({ id: op, op, table: "t", ...extra });
const ISO = [{ column: "Date", format: "YYYY-MM-DD" }];

// ---- aggregates ----
T("count green (non-empty Amount = 6)", base("count", { column: "Amount" }), tb, { value: 6 }, "green");
T("count red (7)", base("count", { column: "Amount" }), tb, { value: 7 }, "red", "value-mismatch");
T("countEmpty green (Tax blank = 1)", base("countEmpty", { column: "Tax" }), tb, { value: 1 }, "green");
T("countEmpty red", base("countEmpty", { column: "Tax" }), tb, { value: 0 }, "red");
T("countIf green (Amount>500 = 2)", base("countIf", { where: [{ column: "Amount", cmp: "gt", value: 500 }] }), tb, { value: 2 }, "green");
T("countIf red", base("countIf", { where: [{ column: "Amount", cmp: "gt", value: 500 }] }), tb, { value: 3 }, "red");
T("sum green $1,200.50 cell read (2850.5)", base("sum", { column: "Amount" }), tb, { value: 2850.5 }, "green");
T("sum: a claim as a numeric string is red claim-malformed (strict types)", base("sum", { column: "Amount" }), tb, { value: "$2,850.50" }, "red", "claim-malformed");
T("sum red off by 0.01", base("sum", { column: "Amount" }), tb, { value: 2850.49 }, "red");
T("sumIf green (food = 1800.5)", base("sumIf", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "food" }] }), tb, { value: 1800.5 }, "green");
T("sumIf red", base("sumIf", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "food" }] }), tb, { value: 1800 }, "red");
T("average green exact", base("average", { column: "Amount" }), tb, { value: 2850.5 / 6 }, "green");
T("average green rounded to cents 475.08 (default tol 0.005)", base("average", { column: "Amount" }), tb, { value: 475.08 }, "green");
T("average red 475.09", base("average", { column: "Amount" }), tb, { value: 475.09 }, "red");
T("average red 475", base("average", { column: "Amount" }), tb, { value: 475 }, "red");
T("average green with signed tolerance 1", base("average", { column: "Amount", tolerance: 1 }), tb, { value: 475 }, "green");
T("averageIf green (food)", base("averageIf", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "food" }] }), tb, { value: 1800.5 / 3 }, "green");
T("averageIf red (blank skipped, not zero: rent avg = 300 not 150)", base("averageIf", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "rent" }] }), tb, { value: 150 }, "red");
T("averageIf green rent = 300 (blank skipped)", base("averageIf", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "rent" }] }), tb, { value: 300 }, "green");
T("averageIf no numeric values -> red no-values", base("averageIf", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "nope" }] }), tb, { value: 0 }, "red", "no-values");
T("median green (300)", base("median", { column: "Amount" }), tb, { value: 300 }, "green");
T("median red", base("median", { column: "Amount" }), tb, { value: 475 }, "red");
T("median even count mean of middles", base("median", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "food" }] }), tb, { value: 300 }, "green");
T("min green 50", base("min", { column: "Amount" }), tb, { value: 50 }, "green");
T("min red (blank not read as 0)", base("min", { column: "Amount" }), tb, { value: 0 }, "red");
T("max green $1,200.50", base("max", { column: "Amount" }), tb, { value: 1200.5 }, "green");
T("max red", base("max", { column: "Amount" }), tb, { value: 700 }, "red");
T("found green", base("found", { column: "Id", needle: "A3" }), tb, { value: true }, "green");
T("found green (absent, claim false)", base("found", { column: "Id", needle: "A9" }), tb, { value: false }, "green");
T("found red (claims present)", base("found", { column: "Id", needle: "A9" }), tb, { value: true }, "red");
T("found red claim not boolean", base("found", { column: "Id", needle: "A3" }), tb, { value: "true" }, "red", "claim-malformed");
T("found exact case (a3 != A3)", base("found", { column: "Id", needle: "a3" }), tb, { value: true }, "red");
T("lookup number green", base("lookup", { column: "Amount", keyColumn: "Id", keyValue: "A7", valueKind: "number" }), tb, { value: 300 }, "green");
T("lookup number red", base("lookup", { column: "Amount", keyColumn: "Id", keyValue: "A7", valueKind: "number" }), tb, { value: 301 }, "red");
T("lookup text green", base("lookup", { column: "Cat", keyColumn: "Id", keyValue: "A7", valueKind: "text" }), tb, { value: "food" }, "green");
T("lookup text red (case)", base("lookup", { column: "Cat", keyColumn: "Id", keyValue: "A7", valueKind: "text" }), tb, { value: "Food" }, "red");
T("lookup 0 matches -> red", base("lookup", { column: "Cat", keyColumn: "Id", keyValue: "ZZ", valueKind: "text" }), tb, { value: "food" }, "red", "lookup-not-unique");
T("lookup 2 matches -> red even if claim equals a match", base("lookup", { column: "Id", keyColumn: "Date", keyValue: "2026-03-01", valueKind: "text" }), tb, { value: "A5" }, "red", "lookup-not-unique");
T("lookup date green", base("lookup", { column: "Date", keyColumn: "Id", keyValue: "A7", valueKind: "date", dateFormats: ISO }), tb, { value: "2026-03-20" }, "green");
T("lookup date red bad claim format", base("lookup", { column: "Date", keyColumn: "Id", keyValue: "A7", valueKind: "date", dateFormats: ISO }), tb, { value: "20/03/2026" }, "red", "claim-malformed");
T("uniqueCount green (3 categories)", base("uniqueCount", { column: "Cat" }), tb, { value: 3 }, "green");
T("uniqueCount red", base("uniqueCount", { column: "Cat" }), tb, { value: 4 }, "red");
T("uniqueCount number-kind (300 x3 + 1200.5,50,700 = 4)", base("uniqueCount", { column: "Amount", valueKind: "number" }), tb, { value: 4 }, "green");
T("duplicates values green (\"300\")", base("duplicates", { column: "Amount" }), tb, { values: ["300"] }, "green");
T("duplicates values red extra", base("duplicates", { column: "Amount" }), tb, { values: ["300", "50"] }, "red", "values-extra");
T("duplicates values red missing", base("duplicates", { column: "Amount" }), tb, { values: [] }, "red", "values-missing");
T("duplicates rows green (3,4,8)", base("duplicates", { column: "Amount" }), tb, { rows: [3, 4, 8] }, "green");
T("duplicates rows red (missing 8, extra 5)", base("duplicates", { column: "Amount" }), tb, { rows: [3, 4, 5] }, "red", "rows-missing");
T("groupTotals green", base("groupTotals", { column: "Amount", groupColumn: "Cat" }), tb, { totals: [{ group: "food", total: 1800.5 }, { group: "rent", total: 300 }, { group: "misc", total: 750 }] }, "green");
T("groupTotals red wrong total", base("groupTotals", { column: "Amount", groupColumn: "Cat" }), tb, { totals: [{ group: "food", total: 1800.5 }, { group: "rent", total: 300 }, { group: "misc", total: 700 }] }, "red", "group-total-mismatch");
T("groupTotals red missing + extra group", base("groupTotals", { column: "Amount", groupColumn: "Cat" }), tb, { totals: [{ group: "food", total: 1800.5 }, { group: "rent", total: 300 }, { group: "other", total: 0 }] }, "red", "groups-missing");
T("groupTotals claim is a map, not a list of pairs -> red", base("groupTotals", { column: "Amount", groupColumn: "Cat" }), tb, { totals: { food: 1800.5 } }, "red", "claim-malformed");
T("groupTotals pair with a non-string group -> red", base("groupTotals", { column: "Amount", groupColumn: "Cat" }), tb, { totals: [{ group: 1, total: 1 }] }, "red", "claim-malformed");
T("groupTotals group listed twice -> red groups-duplicated", base("groupTotals", { column: "Amount", groupColumn: "Cat" }), tb, { totals: [{ group: "food", total: 1800.5 }, { group: "food", total: 1800.5 }, { group: "rent", total: 300 }, { group: "misc", total: 750 }] }, "red", "groups-duplicated");
T("groupTotals a group named __proto__ is just a group name", base("groupTotals", { column: "Amount", groupColumn: "Cat" }), { t: mk(H, [["A", "2026-01-01", "__proto__", "5", "", ""], ["B", "2026-01-01", "constructor", "7", "", ""]]) }, { totals: [{ group: "__proto__", total: 5 }, { group: "constructor", total: 7 }] }, "green");
T("groupTotals claim group __proto__ is an extra group, nothing is poisoned", base("groupTotals", { column: "Amount", groupColumn: "Cat" }), tb, { totals: JSON.parse('[{"group":"__proto__","total":1},{"group":"food","total":1800.5},{"group":"rent","total":300},{"group":"misc","total":750}]') }, "red", "groups-extra");
T("percentOfTotal green (food)", base("percentOfTotal", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "food" }] }), tb, { value: (1800.5 / 2850.5) * 100 }, "green");
T("percentOfTotal red", base("percentOfTotal", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "food" }] }), tb, { value: 60 }, "red");

// ---- rows / conditions ----
const rowsOf = (where, extra = {}) => base("rows", { where, keyColumn: "Amount", ...extra });
const rowsNum = (where) => rowsOf(where, { valueKind: "number" });
T("rows green Amount>500", rowsOf([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { rows: [2, 7] }, "green");
T("rows red missing", rowsOf([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { rows: [2] }, "red", "rows-missing");
T("rows red extra", rowsOf([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { rows: [2, 7, 3] }, "red", "rows-extra");
T("rows red duplicate listed twice", rowsOf([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { rows: [2, 7, 7] }, "red", "rows-duplicated");
T("rows red non-integer row", rowsOf([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { rows: [2, "7"] }, "red", "claim-malformed");
T("rows by keys green (amounts, valueKind number)", rowsNum([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { keys: [700, 1200.5] }, "green");
T("rows by keys red extra amount", rowsNum([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { keys: [700, 1200.5, 300] }, "red", "keys-extra");
T("rows no claim fields -> red claim-missing", rowsOf([{ column: "Amount", cmp: "gt", value: 500 }]), tb, {}, "red", "claim-missing");
T("cond gte (>=300: 2,3,4,7,8)", rowsOf([{ column: "Amount", cmp: "gte", value: 300 }]), tb, { rows: [2, 3, 4, 7, 8] }, "green");
T("cond gte red (omits boundary 300s)", rowsOf([{ column: "Amount", cmp: "gte", value: 300 }]), tb, { rows: [2, 7] }, "red");
T("cond lt (<300: only 6; blank not matched)", rowsOf([{ column: "Amount", cmp: "lt", value: 300 }]), tb, { rows: [6] }, "green");
T("cond lt red (blank row 5 claimed)", rowsOf([{ column: "Amount", cmp: "lt", value: 300 }]), tb, { rows: [5, 6] }, "red", "rows-extra");
T("cond lte", rowsOf([{ column: "Amount", cmp: "lte", value: 300 }]), tb, { rows: [3, 4, 6, 8] }, "green");
T("cond eq", rowsOf([{ column: "Amount", cmp: "eq", value: 300 }]), tb, { rows: [3, 4, 8] }, "green");
T("cond between inclusive", rowsOf([{ column: "Amount", cmp: "between", lo: 50, hi: 300 }]), tb, { rows: [3, 4, 6, 8] }, "green");
T("cond between red", rowsOf([{ column: "Amount", cmp: "between", lo: 50, hi: 300 }]), tb, { rows: [3, 4, 6] }, "red");
T("cond text equals exact", rowsOf([{ column: "Cat", cmp: "equals", value: "food" }]), tb, { rows: [2, 3, 8] }, "green");
T("cond text equals no case folding (\"Food\" matches none)", rowsOf([{ column: "Cat", cmp: "equals", value: "Food" }]), tb, { rows: [] }, "green");
T("cond text equals no wildcard (\"fo*\" matches none)", rowsOf([{ column: "Cat", cmp: "equals", value: "fo*" }]), tb, { rows: [2, 3, 8] }, "red");
T("cond empty", rowsOf([{ column: "Tax", cmp: "empty" }]), tb, { rows: [4] }, "green");
T("cond notEmpty", rowsOf([{ column: "Amount", cmp: "notEmpty" }]), tb, { rows: [2, 3, 4, 6, 7, 8] }, "green");
T("cond notEmpty red (includes blank)", rowsOf([{ column: "Amount", cmp: "notEmpty" }]), tb, { rows: [2, 3, 4, 5, 6, 7, 8] }, "red");
T("cond AND (food and >=300: 2,3,8)", rowsOf([{ column: "Cat", cmp: "equals", value: "food" }, { column: "Amount", cmp: "gte", value: 300 }]), tb, { rows: [2, 3, 8] }, "green");
T("cond AND red (treated as OR)", rowsOf([{ column: "Cat", cmp: "equals", value: "food" }, { column: "Amount", cmp: "gte", value: 300 }]), tb, { rows: [2, 3, 4, 7, 8] }, "red");
T("range scope rows 3..5 only", rowsOf([{ column: "Amount", cmp: "gte", value: 300 }], { range: { from: 3, to: 5 } }), tb, { rows: [3, 4] }, "green");
T("non-numeric text in number column -> red unreadable-cell", rowsOf([{ column: "Amount", cmp: "gt", value: 500 }]), { t: mk(H, [...D, ["A8", "2026-04-01", "food", "abc", "", ""]]) }, { rows: [2, 7] }, "red", "unreadable-cell");
T("sum with non-numeric text cell -> red even if claim equals partial sum", base("sum", { column: "Amount" }), { t: mk(H, [...D, ["A8", "2026-04-01", "food", "abc", "", ""]]) }, { value: 2850.5 }, "red", "unreadable-cell");
T("sum with whitespace-only cell treated as empty (green)", base("sum", { column: "Amount" }), { t: mk(H, [...D, ["A8", "2026-04-01", "food", "   ", "", ""]]) }, { value: 2850.5 }, "green");

// ---- topN ----
T("topN green no tie (top2)", base("topN", { column: "Amount", n: 2 }), tb, { rows: [2, 7] }, "green");
T("topN red wrong row", base("topN", { column: "Amount", n: 2 }), tb, { rows: [2, 3] }, "red");
T("topN tie at cutoff, any (top3: 2,7 + one of 3|4|8) -> pick 3", base("topN", { column: "Amount", n: 3 }), tb, { rows: [2, 7, 3] }, "green");
T("topN tie at cutoff, any -> pick 8 also green", base("topN", { column: "Amount", n: 3 }), tb, { rows: [8, 2, 7] }, "green");
T("topN tie, claim two of the tied (4 rows for n=3) -> red", base("topN", { column: "Amount", n: 3 }), tb, { rows: [2, 7, 3, 4] }, "red", "rows-extra");
T("topN tie, claim too few -> red", base("topN", { column: "Amount", n: 3 }), tb, { rows: [2, 7] }, "red");
T("topN tie ties:all needs every tied row", base("topN", { column: "Amount", n: 3, ties: "all" }), tb, { rows: [2, 7, 3, 4, 8] }, "green");
T("topN tie ties:all red with one", base("topN", { column: "Amount", n: 3, ties: "all" }), tb, { rows: [2, 7, 3] }, "red");
T("topN by values green", base("topN", { column: "Amount", n: 3 }), tb, { values: [1200.5, 700, 300] }, "green");
T("topN by values red", base("topN", { column: "Amount", n: 3 }), tb, { values: [1200.5, 700, 50] }, "red");
T("topN asc (bottom 1 = row 6, 50)", base("topN", { column: "Amount", n: 1, order: "asc" }), tb, { rows: [6] }, "green");
T("topN n larger than data -> red fewer-than-n", base("topN", { column: "Amount", n: 20 }), tb, { rows: [2] }, "red", "fewer-than-n");

// ---- row math ----
const rm = (fn, extra) => base("rowMath", { fn, ...extra });
T("rowMath add red: a blank operand is empty-operand by default", rm("add", { a: "Amount", b: "Tax", result: "Total" }), tb, undefined, "red", "empty-operand");
T("rowMath add green with signed allowEmpty (blank = 0)", rm("add", { a: "Amount", b: "Tax", result: "Total", allowEmpty: true }), tb, undefined, "green");
const badTotal = JSON.parse(JSON.stringify(D)); badTotal[4][5] = "56";
T("rowMath add red on one row", rm("add", { a: "Amount", b: "Tax", result: "Total", allowEmpty: true }), { t: mk(H, badTotal) }, undefined, "red", "row-math-mismatch");
const blankTotal = JSON.parse(JSON.stringify(D)); blankTotal[1][5] = "";
T("rowMath add red: blank result", rm("add", { a: "Amount", b: "Tax", result: "Total", allowEmpty: true }), { t: mk(H, blankTotal) }, undefined, "red", "result-empty");
T("rowMath sub green (Amount = Total - Tax, misc rows)", rm("sub", { a: "Total", b: "Tax", result: "Amount", where: [{ column: "Cat", cmp: "equals", value: "misc" }] }), tb, undefined, "green");
T("rowMath mul const green (misc Tax = Amount*0.1)", rm("mul", { a: "Amount", b: { const: 0.1 }, result: "Tax", where: [{ column: "Cat", cmp: "equals", value: "misc" }] }), tb, undefined, "green");
T("rowMath mul const red (food)", rm("mul", { a: "Amount", b: { const: 0.1 }, result: "Tax", where: [{ column: "Cat", cmp: "equals", value: "food" }] }), tb, undefined, "red", "row-math-mismatch");
const P = mk(["A", "B", "Div", "Pct"], [["10", "4", "2.5", "250"], ["9", "3", "3", "300"]]);
T("rowMath div green", rm("div", { a: "A", b: "B", result: "Div" }), { t: P }, undefined, "green");
T("rowMath pct green (A as % of B)", rm("pct", { a: "A", b: "B", result: "Pct" }), { t: P }, undefined, "green");
T("rowMath pct red", rm("pct", { a: "A", b: "B", result: "Div" }), { t: P }, undefined, "red");
T("rowMath div by zero -> red div-zero", rm("div", { a: "A", b: "B", result: "Div" }), { t: mk(["A", "B", "Div"], [["10", "0", "1"]]) }, undefined, "red", "div-zero");
T("rowMath non-numeric operand -> red unreadable", rm("add", { a: "Amount", b: "Tax", result: "Total" }), { t: mk(H, [["A1", "2026-01-05", "food", "n/a", "1", "1"]]) }, undefined, "red", "unreadable-cell");
T("rowMath unknown fn -> stopped", rm("pow", { a: "A", b: "B", result: "Div" }), { t: P }, undefined, "stopped", "check-invalid");

// ---- dates: the signed per-column format ----
const DT = { t: mk(["Id", "Date"], [["a", "2026-01-05"], ["b", "2026-01-10"], ["c", "2026-02-01"], ["d", "2026-03-01"]]) };
const dq = (op, extra) => ({ op, table: "t", dateFormats: ISO, ...extra });
const cellA = { column: "Date", row: 2 };
T("daysBetween green (5)", dq("daysBetween", { from: cellA, to: { column: "Date", row: 3 } }), DT, { value: 5 }, "green");
T("daysBetween red", dq("daysBetween", { from: cellA, to: { column: "Date", row: 3 } }), DT, { value: 6 }, "red", "value-mismatch");
T("daysBetween signed (reverse = -5)", dq("daysBetween", { from: { column: "Date", row: 3 }, to: cellA }), DT, { value: -5 }, "green");
T("daysBetween across months (Jan5->Mar1 = 55)", dq("daysBetween", { from: cellA, to: { column: "Date", row: 5 } }), DT, { value: 55 }, "green");
T("daysBetween: a row that is not in the table -> stopped", dq("daysBetween", { from: cellA, to: { column: "Date", row: 99 } }), DT, { value: 1 }, "stopped", "check-invalid");
T("daysSince cell green (asOf 2026-02-01 - 2026-01-05 = 27)", dq("daysSince", { cell: cellA, asOf: "2026-02-01" }), DT, { value: 27 }, "green");
T("daysSince cell red", dq("daysSince", { cell: cellA, asOf: "2026-02-01" }), DT, { value: 26 }, "red");
T("daysSince bad asOf -> stopped (signed check broken)", dq("daysSince", { cell: cellA, asOf: "02/01/2026" }), DT, { value: 27 }, "stopped", "check-invalid");
T("daysSince asOf 2026-02-30 (not a real day) -> stopped", dq("daysSince", { cell: cellA, asOf: "2026-02-30" }), DT, { value: 27 }, "stopped", "check-invalid");
T("daysSince per row green", dq("daysSince", { column: "Date", asOf: "2026-02-01" }), DT, { days: { 2: 27, 3: 22, 4: 0, 5: -28 } }, "green");
T("daysSince per row red: one wrong", dq("daysSince", { column: "Date", asOf: "2026-02-01" }), DT, { days: { 2: 27, 3: 22, 4: 0, 5: -27 } }, "red", "days-mismatch");
T("daysSince per row red: a row missing", dq("daysSince", { column: "Date", asOf: "2026-02-01" }), DT, { days: { 2: 27, 3: 22, 4: 0 } }, "red", "rows-missing");
T("daysSince per row red: a row too many", dq("daysSince", { column: "Date", asOf: "2026-02-01" }), DT, { days: { 2: 27, 3: 22, 4: 0, 5: -28, 6: 1 } }, "red", "rows-extra");
T("daysSince per row: key __proto__ in the claim is malformed, never a crash", dq("daysSince", { column: "Date", asOf: "2026-02-01" }), DT, JSON.parse('{"days": {"__proto__": 1}}'), "red", "claim-malformed");
T("earliest green", dq("earliest", { column: "Date" }), DT, { value: "2026-01-05" }, "green");
T("earliest red", dq("earliest", { column: "Date" }), DT, { value: "2026-01-10" }, "red");
T("latest green", dq("latest", { column: "Date" }), DT, { value: "2026-03-01" }, "green");
T("latest red claim in another format", dq("latest", { column: "Date" }), DT, { value: "03/01/2026" }, "red", "claim-malformed");
const dr = (c) => base("rows", { where: [c], keyColumn: "Amount", dateFormats: ISO });
T("date before is strict", dr({ column: "Date", cmp: "before", value: "2026-02-01" }), tb, { rows: [2, 3] }, "green");
T("date after is strict", dr({ column: "Date", cmp: "after", value: "2026-03-01" }), tb, { rows: [8] }, "green");
T("date before: the boundary day itself is NOT before", dr({ column: "Date", cmp: "before", value: "2026-02-01" }), tb, { rows: [2, 3, 4] }, "red", "rows-extra");
T("date after: the boundary day itself is NOT after", dr({ column: "Date", cmp: "after", value: "2026-03-01" }), tb, { rows: [6, 7, 8] }, "red", "rows-extra");
T("date dateBetween is inclusive", dr({ column: "Date", cmp: "dateBetween", lo: "2026-02-01", hi: "2026-02-15" }), tb, { rows: [4, 5] }, "green");
T("date dateBetween red (exclusive bounds claimed)", dr({ column: "Date", cmp: "dateBetween", lo: "2026-02-01", hi: "2026-02-15" }), tb, { rows: [] }, "red", "rows-missing");
T("date dateOn", dr({ column: "Date", cmp: "dateOn", value: "2026-03-01" }), tb, { rows: [6, 7] }, "green");
const BADD = { t: mk(["Id", "Date"], [["a", "03/04/2026"], ["b", "2026-2-3"], ["c", "2026-02-30"], ["d", "2026-03-01"]]) };
T("bad date forms in an ISO column -> red unreadable-cell (never guessed)", dq("earliest", { column: "Date" }), BADD, { value: "2026-03-01" }, "red", "unreadable-cell");
T("date condition over a column with bad forms -> red unreadable-cell", { op: "rows", table: "t", keyColumn: "Date", dateFormats: ISO, where: [{ column: "Date", cmp: "after", value: "2026-01-01" }] }, BADD, { rows: [5] }, "red", "unreadable-cell");
T("daysBetween over a bad-form cell -> red unreadable-cell", dq("daysBetween", { from: cellA, to: { column: "Date", row: 5 } }), BADD, { value: 1 }, "red", "unreadable-cell");
T("date column with no dateFormats entry -> stopped", { op: "earliest", table: "t", column: "Date" }, DT, { value: "2026-01-05" }, "stopped", "check-invalid");

// every format, both a green read and its refusals; the reader is checked directly and through a check
const FMT = {
  "YYYY-MM-DD": { ok: ["2026-10-22", "2024-02-29", " 2026-10-22 "], no: ["2026-2-3", "22/10/2026", "2026-10-22T00:00", "2026-02-30", "2026-13-01", "2025-02-29", "2100-02-29", "0000-01-01", "", "20261022"] },
  "DD/MM/YYYY": { ok: ["22/10/2026", "29/02/2024"], no: ["10/22/2026", "22/10/26", "2/3/2026", "31/04/2026", "29/02/2025", "2026-10-22", "22-10-2026"] },
  "MM/DD/YYYY": { ok: ["10/22/2026", "02/29/2024"], no: ["22/10/2026", "13/01/2026", "2/3/2026", "04/31/2026", "02/29/2025"] },
  "D MMM YYYY": { ok: ["22 Oct 2026", "5 Jan 2026", "05 Jan 2026", "29 Feb 2024", "22 OCT 2026", "22 oct 2026"], no: ["22 October 2026", "22 Sept 2026", "22 Sep. 2026", "30 Feb 2026", "29 Feb 2025", "22  Oct 2026", "Oct 22 2026", "22-Oct-2026", "22 Foo 2026", "100 Jan 2026"] },
};
for (const [fmt, { ok, no }] of Object.entries(FMT)) {
  test(`readCellDate ${fmt}: reads exactly this form, with real-calendar validation`, () => {
    for (const s of ok) assert.notEqual(readCellDate(s, fmt), null, `${fmt} ${JSON.stringify(s)}`);
    for (const s of no) assert.equal(readCellDate(s, fmt), null, `${fmt} ${JSON.stringify(s)}`);
  });
}
test("readCellDate: the same day in every format has the same day number; 1970-01-01 is 0", () => {
  const d = readCellDate("2026-10-22", "YYYY-MM-DD");
  assert.equal(readCellDate("22/10/2026", "DD/MM/YYYY"), d);
  assert.equal(readCellDate("10/22/2026", "MM/DD/YYYY"), d);
  assert.equal(readCellDate("22 Oct 2026", "D MMM YYYY"), d);
  assert.equal(readCellDate("1970-01-01", "YYYY-MM-DD"), 0);
  assert.equal(readCellDate("1969-12-31", "YYYY-MM-DD"), -1);
  assert.equal(readCellDate("2000-03-01", "YYYY-MM-DD") - readCellDate("2000-02-28", "YYYY-MM-DD"), 2, "2000 is a leap year");
  assert.equal(readCellDate("1900-03-01", "YYYY-MM-DD") - readCellDate("1900-02-28", "YYYY-MM-DD"), 1, "1900 is not");
});
test("readCellDate: 03/04/2026 is never auto-read: it means 3 April in DD/MM and 4 March in MM/DD, so the signed format decides", () => {
  assert.equal(readCellDate("03/04/2026", "YYYY-MM-DD"), null);
  assert.equal(readCellDate("03/04/2026", "DD/MM/YYYY") - readCellDate("03/04/2026", "MM/DD/YYYY"), 30);
  assert.equal(readCellDate("2026-10-22", "dd/mm/yyyy"), null, "an unknown format name reads nothing");
  assert.equal(readCellDate(20261022, "YYYY-MM-DD"), null);
});
for (const [fmt, sample, other] of [["DD/MM/YYYY", "22/10/2026", "2026-10-22"], ["MM/DD/YYYY", "10/22/2026", "22/10/2026"], ["D MMM YYYY", "22 Oct 2026", "2026-10-22"]]) {
  const T2 = { t: mk(["Id", "D"], [["a", sample], ["b", other]]) };
  const chk = { op: "allDates", table: "t", column: "D", dateFormats: [{ column: "D", format: fmt }] };
  T(`allDates ${fmt}: the other form in the column is red not-date`, chk, T2, undefined, "red", "not-date");
  T(`allDates ${fmt}: green when every cell is in the signed form`, chk, { t: mk(["Id", "D"], [["a", sample]]) }, undefined, "green");
}
T("a date column can be signed with a different format per column", { op: "rows", table: "t", keyColumn: "Id", dateFormats: [{ column: "A", format: "DD/MM/YYYY" }, { column: "B", format: "D MMM YYYY" }], where: [{ column: "A", cmp: "before", value: "2026-10-23" }, { column: "B", cmp: "after", value: "2026-10-01" }] }, { t: mk(["Id", "A", "B"], [["x", "22/10/2026", "5 Nov 2026"], ["y", "24/10/2026", "5 Nov 2026"], ["z", "22/10/2026", "5 Sep 2026"]]) }, { rows: [2] }, "green");
T("an unknown date format name -> stopped (createRubric refuses it first)", { op: "earliest", table: "t", column: "Date", dateFormats: [{ column: "Date", format: "YYYY/MM/DD" }] }, DT, { value: "2026-01-05" }, "stopped", "check-invalid");
T("lookup date: the claim must be in the column's signed format", base("lookup", { column: "D", keyColumn: "Id", keyValue: "a", valueKind: "date", dateFormats: [{ column: "D", format: "D MMM YYYY" }] }), { t: mk(["Id", "D"], [["a", "22 Oct 2026"]]) }, { value: "22 Oct 2026" }, "green");
T("lookup date: ISO claim for a D MMM YYYY column is malformed", base("lookup", { column: "D", keyColumn: "Id", keyValue: "a", valueKind: "date", dateFormats: [{ column: "D", format: "D MMM YYYY" }] }), { t: mk(["Id", "D"], [["a", "22 Oct 2026"]]) }, { value: "2026-10-22" }, "red", "claim-malformed");

// ---- shape ----
T("allNumbers green", base("allNumbers", { column: "Total" }), tb, undefined, "green");
T("allNumbers red (blank Amount counts as bad)", base("allNumbers", { column: "Amount" }), tb, undefined, "red", "not-number");
T("allNumbers green with signed allowEmpty", base("allNumbers", { column: "Amount", allowEmpty: true }), tb, undefined, "green");
T("allNumbers red text", base("allNumbers", { column: "Amount" }), { t: mk(H, [["A", "2026-01-01", "x", "12abc", "", ""]]) }, undefined, "red");
T("allDates green", base("allDates", { column: "Date", dateFormats: ISO }), tb, undefined, "green");
T("allDates red (03/04/2026 in an ISO column)", dq("allDates", { column: "Date" }), BADD, undefined, "red", "not-date");
T("allDates: a blank is red unless allowEmpty", dq("allDates", { column: "D" , dateFormats: [{ column: "D", format: "YYYY-MM-DD" }] }), { t: mk(["Id", "D"], [["a", ""], ["b", "2026-01-01"]]) }, undefined, "red", "not-date");
T("allDates: a blank is fine with allowEmpty", dq("allDates", { column: "D", allowEmpty: true, dateFormats: [{ column: "D", format: "YYYY-MM-DD" }] }), { t: mk(["Id", "D"], [["a", ""], ["b", "2026-01-01"]]) }, undefined, "green");
T("noEmpty green", base("noEmpty", { column: "Id" }), tb, undefined, "green");
T("noEmpty red", base("noEmpty", { column: "Tax" }), tb, undefined, "red", "empty-cells");
T("noEmpty: whitespace only is blank", base("noEmpty", { column: "Id" }), { t: mk(["Id"], [["a"], ["  \t"]]) }, undefined, "red", "empty-cells");
T("noDuplicates green", base("noDuplicates", { column: "Id" }), tb, undefined, "green");
T("noDuplicates red (Amount 300 x3)", base("noDuplicates", { column: "Amount" }), tb, undefined, "red", "duplicate-values");
T("noDuplicates: exact, so 'a' and 'A' are different", base("noDuplicates", { column: "Id" }), { t: mk(["Id"], [["a"], ["A"]]) }, undefined, "green");
T("noDuplicates: blanks are ignored", base("noDuplicates", { column: "Id" }), { t: mk(["Id"], [[""], [""]]) }, undefined, "green");
T("rowCount green 7", base("rowCount", { n: 7 }), tb, undefined, "green");
T("rowCount red 8", base("rowCount", { n: 8 }), tb, undefined, "red", "row-count");
T("rowCount honours range", base("rowCount", { n: 3, range: { from: 3, to: 5 } }), tb, undefined, "green");
T("rowCount 0 on an empty table is green", base("rowCount", { n: 0 }), { t: mk(["Id"], []) }, undefined, "green");

// ---- diff (before vs after, aligned by the signed key) ----
const clone = (t) => ({ header: [...t.header], rows: t.rows.map((r) => ({ rowNumber: r.rowNumber, cells: [...r.cells] })) });
const A0 = clone(tb.t);
const w = (op, extra = {}) => ({ id: op, op, before: "b", after: "a", keyColumn: "Id", ...extra });
const wt = (a) => ({ b: tb.t, a });
T("diff identical: onlyColumnsChanged [] green", w("onlyColumnsChanged", { columns: [] }), wt(A0), undefined, "green");
const A1 = clone(tb.t); A1.rows[1].cells[4] = "31";
T("diff onlyColumnsChanged [Tax] green", w("onlyColumnsChanged", { columns: ["Tax"] }), wt(A1), undefined, "green");
T("diff onlyColumnsChanged [Amount] red (Tax changed)", w("onlyColumnsChanged", { columns: ["Amount"] }), wt(A1), undefined, "red", "column-changed");
const A2 = clone(tb.t); A2.rows[0].cells[2] = "food ";
T("diff: a trailing-space edit is a change (byte identical)", w("onlyColumnsChanged", { columns: ["Tax"] }), wt(A2), undefined, "red", "column-changed");
T("diff untouchedIdentical except key A2 green", w("untouchedIdentical", { exceptKeys: ["A2"] }), wt(A1), undefined, "green");
T("diff untouchedIdentical except key A3 red", w("untouchedIdentical", { exceptKeys: ["A3"] }), wt(A1), undefined, "red", "untouched-cell-changed");
T("diff untouchedIdentical with no exceptions: any change is red", w("untouchedIdentical"), wt(A1), undefined, "red", "untouched-cell-changed");
const A3 = clone(tb.t); A3.rows.push({ rowNumber: 9, cells: ["A8", "2026-04-01", "misc", "5", "0", "5"] });
T("diff rowsAdded n=1 green", w("rowsAdded", { n: 1 }), wt(A3), undefined, "green");
T("diff rowsAdded n=0 red when one was added", w("rowsAdded", { n: 0 }), wt(A3), undefined, "red", "rows-added-count");
T("diff rowsAdded n=0 green when none", w("rowsAdded", { n: 0 }), wt(A0), undefined, "green");
T("diff rowsAdded: n is required (stopped without it)", w("rowsAdded"), wt(A0), undefined, "stopped", "check-invalid");
const A4 = clone(tb.t); A4.rows.pop();
T("diff rowsDeleted n=1 green (last row)", w("rowsDeleted", { n: 1 }), wt(A4), undefined, "green");
T("diff rowsDeleted n=0 red when one was deleted", w("rowsDeleted", { n: 0 }), wt(A4), undefined, "red", "rows-deleted-count");
const A5 = clone(tb.t); A5.header.push("Total2"); A5.rows.forEach((r) => r.cells.push(String(Number(r.cells[3].replace(/[$,]/g, "") || 0) + Number(r.cells[4] || 0))));
T("diff new column only: onlyColumnsChanged [Total2] green", w("onlyColumnsChanged", { columns: ["Total2"] }), wt(A5), undefined, "green");
T("diff new column not allowed -> red column-added", w("onlyColumnsChanged", { columns: [] }), wt(A5), undefined, "red", "column-added");
const rule2 = { fn: "add", a: "Amount", b: "Tax", result: "Total2", allowEmpty: true };
T("diff newColumnRule add green", w("newColumnRule", rule2), wt(A5), undefined, "green");
const A6 = clone(A5); A6.rows[2].cells[6] = "999";
T("diff newColumnRule red on one row", w("newColumnRule", rule2), wt(A6), undefined, "red", "row-math-mismatch");
T("diff newColumnRule on an UNCHANGED existing column -> red", w("newColumnRule", { ...rule2, result: "Total" }), wt(A0), undefined, "red", "column-not-new-or-changed");
T("diff newColumnRule: result column absent from after -> stopped", w("newColumnRule", { ...rule2, result: "Nope" }), wt(A0), undefined, "stopped", "check-invalid");
const A7 = clone(tb.t); A7.header = A7.header.filter((h) => h !== "Tax"); A7.rows.forEach((r) => r.cells.splice(4, 1));
T("diff column removed -> red even when listed", w("onlyColumnsChanged", { columns: ["Tax"] }), wt(A7), undefined, "red", "column-removed");
const A8 = clone(tb.t); A8.rows.splice(1, 1); // middle row deleted, rowNumbers kept (sparse)
T("diff middle delete with kept rowNumbers: rowsDeleted n=1 green", w("rowsDeleted", { n: 1 }), wt(A8), undefined, "green");
const A9 = clone(A8); A9.rows.forEach((r, i) => (r.rowNumber = 2 + i)); // renumbered after the delete
T("diff middle delete RENUMBERED: aligned by the key, rowsDeleted n=1 green", w("rowsDeleted", { n: 1 }), wt(A9), undefined, "green");
T("diff middle delete RENUMBERED: nothing else changed (the key, not the row number, aligns)", w("onlyColumnsChanged", { columns: [] }), wt(A9), undefined, "green");
T("diff keyColumn not unique -> red key-not-unique", w("rowsAdded", { n: 0, keyColumn: "Cat" }), wt(A0), undefined, "red", "key-not-unique");
T("diff keyColumn with a blank key -> red key-not-unique", w("rowsAdded", { n: 0, keyColumn: "Tax" }), wt(A0), undefined, "red", "key-not-unique");
T("diff without a keyColumn -> stopped", { id: "d", op: "rowsAdded", n: 0, before: "b", after: "a" }, wt(A0), undefined, "stopped", "check-invalid");
T("diff: keyColumn absent from a table -> stopped", w("rowsAdded", { n: 0, keyColumn: "Nope" }), wt(A0), undefined, "stopped", "check-invalid");
T("diff: the after table missing -> stopped table-invalid", w("rowsAdded", { n: 0 }), { b: tb.t }, undefined, "stopped", "table-invalid");

// ---- hostile / broken ----
const thrower = { get value() { throw new Error("boom"); } };
T("hostile: throwing getter on claim -> red", base("count", { column: "Amount" }), tb, thrower, "red", "claim-unreadable");
const px = new Proxy({}, { get() { throw new Error("trap"); }, has() { throw new Error("trap"); }, ownKeys() { throw new Error("trap"); }, getOwnPropertyDescriptor() { throw new Error("trap"); } });
T("hostile: Proxy with throwing traps -> red", base("count", { column: "Amount" }), tb, px, "red", "claim-unreadable");
T("hostile: Proxy array of rows", rowsOf([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { rows: new Proxy([], { get() { throw new Error("t"); } }) }, "red", "claim-unreadable");
T("hostile: a row-list element that is an object -> red, its getters never run", rowsOf([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { rows: [2, { valueOf() { throw new Error("no"); } }] }, "red", "claim-malformed");
T("hostile: claim null", base("count", { column: "Amount" }), tb, null, "red", "claim-malformed");
T("hostile: claim a string", base("count", { column: "Amount" }), tb, "6", "red", "claim-malformed");
T("hostile: claim an array", base("count", { column: "Amount" }), tb, [6], "red", "claim-malformed");
T("hostile: claim field missing", base("count", { column: "Amount" }), tb, MISSING, "red", "claim-missing");
T("hostile: claim object without the key", base("count", { column: "Amount" }), tb, {}, "red", "claim-missing");
T("hostile: inherited value via prototype ignored", base("count", { column: "Amount" }), tb, Object.create({ value: 6 }), "red", "claim-missing");
T("hostile: value NaN", base("count", { column: "Amount" }), tb, { value: NaN }, "red", "claim-malformed");
T("hostile: value Infinity", base("sum", { column: "Amount" }), tb, { value: Infinity }, "red", "claim-malformed");
T("hostile: value boolean", base("count", { column: "Amount" }), tb, { value: true }, "red", "claim-malformed");
T("hostile: value object with valueOf", base("count", { column: "Amount" }), tb, { value: { valueOf() { return 6; } } }, "red", "claim-malformed");
T("hostile: value 1e3 string is refused like a cell", base("count", { column: "Amount" }), tb, { value: "6e0" }, "red", "claim-malformed");
T("hostile: rows list of CLAIM_MAX+1 entries -> red claim-too-large", rowsOf([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { rows: new Array(100001).fill(2) }, "red", "claim-too-large");
T("hostile: a __proto__ own key in the claim object is ignored", base("count", { column: "Amount" }), tb, JSON.parse('{"__proto__": {"value": 6}}'), "red", "claim-missing");
T("hostile: bad op -> stopped", base("evalFormula", { column: "Amount" }), tb, { value: 1 }, "stopped", "check-invalid");
T("hostile: unknown table -> stopped", { op: "count", table: "zzz", column: "Amount" }, tb, { value: 1 }, "stopped", "table-invalid");
T("hostile: unknown column -> stopped", base("count", { column: "Nope" }), tb, { value: 1 }, "stopped", "check-invalid");
T("hostile: a broken table wins over a bad claim (stopped, not red)", base("count", { column: "Nope" }), tb, null, "stopped", "check-invalid");
T("hostile: check null -> stopped", null, tb, { value: 1 }, "stopped");
T("hostile: tables null -> stopped", base("count", { column: "Amount" }), null, { value: 1 }, "stopped", "table-invalid");
T("hostile: table cell not a string -> stopped", base("count", { column: "Amount" }), { t: { header: ["Amount"], rows: [{ rowNumber: 2, cells: [5] }] } }, { value: 1 }, "stopped", "table-invalid");
T("hostile: ragged row -> stopped", base("count", { column: "Amount" }), { t: { header: ["Amount", "X"], rows: [{ rowNumber: 2, cells: ["5"] }] } }, { value: 1 }, "stopped", "table-invalid");
T("hostile: duplicate header -> stopped", base("count", { column: "A" }), { t: { header: ["A", "A"], rows: [] } }, { value: 0 }, "stopped", "table-invalid");
T("hostile: rowNumber out of order -> stopped", base("count", { column: "A" }), { t: { header: ["A"], rows: [{ rowNumber: 3, cells: ["1"] }, { rowNumber: 3, cells: ["1"] }] } }, { value: 2 }, "stopped", "table-invalid");
T("hostile: rowNumber 1 (the header) -> stopped", base("count", { column: "A" }), { t: { header: ["A"], rows: [{ rowNumber: 1, cells: ["1"] }] } }, { value: 1 }, "stopped", "table-invalid");
T("hostile: table getter throws -> stopped", base("count", { column: "Amount" }), { get t() { throw new Error("x"); } }, { value: 1 }, "stopped", "table-invalid");
T("hostile: a Proxy table -> stopped, not a crash", base("count", { column: "Amount" }), { t: px }, { value: 1 }, "stopped", "table-invalid");
T("hostile: header holds a Proxy row array -> stopped", base("count", { column: "Amount" }), { t: { header: ["Amount"], rows: new Proxy([], { get() { throw new Error("t"); } }) } }, { value: 1 }, "stopped", "table-invalid");
T("hostile: a table named __proto__ is looked up as an own key only", { op: "count", table: "__proto__", column: "Amount" }, tb, { value: 1 }, "stopped", "table-invalid");
T("hostile: bad tolerance -> stopped", base("sum", { column: "Amount", tolerance: -1 }), tb, { value: 2850.5 }, "stopped", "check-invalid");
T("hostile: non-number tolerance -> stopped", base("sum", { column: "Amount", tolerance: "1" }), tb, { value: 2850.5 }, "stopped", "check-invalid");
T("hostile: tolerance on an exact op (count) -> stopped", base("count", { column: "Amount", tolerance: 1 }), tb, { value: 6 }, "stopped", "check-invalid");
T("hostile: regex-looking equals is literal text, not a regex", rowsOf([{ column: "Cat", cmp: "equals", value: ".*" }]), tb, { rows: [] }, "green");
T("hostile: unknown cmp (like 'matches') -> stopped", rowsOf([{ column: "Cat", cmp: "matches", value: "f.*" }]), tb, { rows: [] }, "stopped", "check-invalid");
T("hostile: cond value as string number -> stopped (signed values are typed)", rowsOf([{ column: "Amount", cmp: "gt", value: "500" }]), tb, { rows: [] }, "stopped", "check-invalid");
T("hostile: OR is not a thing: a cmp list or 'or' key is refused", rowsOf([{ column: "Cat", cmp: "equals", value: "food", or: [] }]), tb, { rows: [] }, "stopped", "check-invalid");
T("hostile: a field the op does not take -> stopped", base("count", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "food" }] }), tb, { value: 6 }, "stopped", "check-invalid");

// ---- STRICT claim types (hamr 2026-10-22: strict for spreadsheets) ----
// A claimed number is a finite JS number, never a numeric string; one test per claim shape, each with the TRUE value as a string.
const STR = "claim-malformed";
T("strict count: {value:\"6\"} is red claim-malformed", base("count", { column: "Amount" }), tb, { value: "6" }, "red", STR);
T("strict count: {value:6} is green", base("count", { column: "Amount" }), tb, { value: 6 }, "green");
T("strict countEmpty", base("countEmpty", { column: "Tax" }), tb, { value: "1" }, "red", STR);
T("strict countIf", base("countIf", { where: [{ column: "Amount", cmp: "gt", value: 500 }] }), tb, { value: "2" }, "red", STR);
T("strict sum", base("sum", { column: "Amount" }), tb, { value: "2850.5" }, "red", STR);
T("strict sumIf", base("sumIf", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "food" }] }), tb, { value: "1800.5" }, "red", STR);
T("strict average", base("average", { column: "Amount" }), tb, { value: "475.08" }, "red", STR);
T("strict averageIf", base("averageIf", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "rent" }] }), tb, { value: "300" }, "red", STR);
T("strict median", base("median", { column: "Amount" }), tb, { value: "300" }, "red", STR);
T("strict min", base("min", { column: "Amount" }), tb, { value: "50" }, "red", STR);
T("strict max", base("max", { column: "Amount" }), tb, { value: "1200.5" }, "red", STR);
T("strict uniqueCount", base("uniqueCount", { column: "Cat" }), tb, { value: "3" }, "red", STR);
T("strict percentOfTotal", base("percentOfTotal", { column: "Amount", where: [{ column: "Cat", cmp: "equals", value: "food" }] }), tb, { value: "63.16" }, "red", STR);
T("strict lookup number", base("lookup", { column: "Amount", keyColumn: "Id", keyValue: "A7", valueKind: "number" }), tb, { value: "300" }, "red", STR);
T("strict daysBetween", base("daysBetween", { from: { column: "Date", row: 2 }, to: { column: "Date", row: 3 }, dateFormats: ISO }), tb, { value: "5" }, "red", STR);
T("strict daysSince cell", base("daysSince", { cell: { column: "Date", row: 2 }, asOf: "2026-02-01", dateFormats: ISO }), tb, { value: "27" }, "red", STR);
T("strict topN values", base("topN", { column: "Amount", n: 2 }), tb, { values: ["1200.5", 700] }, "red", STR);
T("strict topN values: numbers are green", base("topN", { column: "Amount", n: 2 }), tb, { values: [1200.5, 700] }, "green");
T("strict rows by number keys", rowsNum([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { keys: ["700", 1200.5] }, "red", STR);
T("strict groupTotals total", base("groupTotals", { column: "Amount", groupColumn: "Cat" }), tb, { totals: [{ group: "food", total: "1800.5" }, { group: "rent", total: 300 }, { group: "misc", total: 750 }] }, "red", STR);
T("strict days map values", base("daysSince", { column: "Date", asOf: "2026-02-01", dateFormats: ISO, range: { from: 2, to: 3 } }), tb, { days: { 2: "27", 3: 22 } }, "red", STR);
T("strict days map values: numbers are green", base("daysSince", { column: "Date", asOf: "2026-02-01", dateFormats: ISO, range: { from: 2, to: 3 } }), tb, { days: { 2: 27, 3: 22 } }, "green");
T("strict bands map values must be strings", base("band", { column: "Amount", bands: [{ name: "any", gte: 0 }], range: { from: 2, to: 2 } }), tb, { bands: { 2: 1 } }, "red", STR);
T("strict rows: row numbers as strings are red", rowsOf([{ column: "Amount", cmp: "gt", value: 500 }]), tb, { rows: ["2", "7"] }, "red", STR);
T("strict found: a boolean, not \"true\"", base("found", { column: "Id", needle: "A3" }), tb, { value: "true" }, "red", STR);
T("strict lookup text stays a string; a number is malformed", base("lookup", { column: "Cat", keyColumn: "Id", keyValue: "A7", valueKind: "text" }), tb, { value: 5 }, "red", STR);
T("strict earliest stays a date string; a number is malformed", base("earliest", { column: "Date", dateFormats: ISO }), tb, { value: 20260105 }, "red", STR);
T("strict: a numeric string with a currency symbol or comma is just as red", base("sum", { column: "Amount" }), tb, { value: "2,850.50" }, "red", STR);

// ---- gap order: a table data problem comes BEFORE a claim mismatch ----
const bad2 = { t: mk(H, [["A1", "2026-01-01", "x", "10", "", ""], ["A2", "2026-01-02", "x", "abc", "", ""]]) };
test("gap order: unreadable-cell is gaps[0] even though the claim also mismatches", () => {
  const r = runCheck(base("sum", { column: "Amount" }), bad2, { value: 999 });
  assert.deepEqual(r.gaps.map((g) => g.kind), ["unreadable-cell", "value-mismatch"]);
});
test("gap order: unreadable-cell also precedes a malformed claim", () => {
  const r = runCheck(base("sum", { column: "Amount" }), bad2, { value: "10" });
  assert.deepEqual(r.gaps.map((g) => g.kind), ["unreadable-cell", "claim-malformed"]);
});
test("gap order: no-values first, rows-missing/extra after, and the order within a group is the minted order", () => {
  const r = runCheck(base("average", { column: "Amount" }), { t: mk(H, [["A1", "2026-01-01", "x", "", "", ""]]) }, { value: 5 });
  assert.deepEqual(r.gaps.map((g) => g.kind), ["no-values"]);
  const rows = runCheck(rowsOf([{ column: "Amount", cmp: "gt", value: 5 }]), bad2, { rows: [9] });
  assert.deepEqual(rows.gaps.map((g) => g.kind), ["unreadable-cell", "rows-missing", "rows-extra"]);
});
test("gap order: row math empty-operand precedes row-math-mismatch", () => {
  const t = { t: mk(["A", "B", "R"], [["", "1", "1"], ["2", "2", "9"]]) };
  const r = runCheck({ id: "m", op: "rowMath", table: "t", fn: "add", a: "A", b: "B", result: "R" }, t);
  assert.deepEqual(r.gaps.map((g) => g.kind), ["empty-operand", "row-math-mismatch"]);
});
