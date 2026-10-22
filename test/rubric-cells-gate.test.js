import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Gate, createRubric, checkStep, renderGaps, rubricVocabulary, rubricSha, tableSha } from "../src/index.js";
import { describeRule } from "../src/primitives/rubric.js";
import { readNumber, TABLE_MAX_CELLS, TABLE_MAX_CHARS, CLAIM_MAX } from "../src/primitives/rubric-cells.js";
import { runCheck, mk } from "./_cells-helpers.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

// cells / table / diff at the rubric surface: the number reader, tolerance and cap boundaries, createRubric refusals,
// the vocabulary <-> implementation proof per op, rendering, hostile opts.tables, and the Gate.

// every table a check reads is a signed input (sha256 over tableSha); a diff's AFTER table is not
const inputsOf = (checks, tables) => [...new Set(checks.map((c) => (c.rule === "diff" ? c.before : c.table)).filter((n) => typeof n === "string"))].map((name) => ({ name, sha256: (tables && tableSha(tables[name])) || "a".repeat(64) }));
const rubricOf = (checks, tables) => createRubric({ schema: 1, goal: "g", inputs: inputsOf(checks, tables), checkpoints: { cp: { gating: true, checks } } });
const step = (checks, tables, output) => checkStep(rubricOf(checks, tables), "cp", output ?? { a: 1 }, { tables });
const bad = (check, re) => assert.throws(() => rubricOf([check]), re);
const T1 = mk(["Id", "Amt"], [["a", "10"], ["b", "20"]]);
const sumCheck = (extra = {}) => ({ id: "s", rule: "cells", table: "t", claim: "c", op: "sum", column: "Amt", ...extra });

// --- the number reader (SemVer surface) ---------------------------------------------------------------------

test("readNumber: sign, one glued currency symbol, proper thousands groups, decimals", () => {
  const ok = [["$1,200.50", 1200.5], ["€5", 5], ["£7.25", 7.25], ["1200", 1200], [" 5 ", 5], ["-$5", -5], ["+$5", 5], ["-5", -5], ["+5", 5], ["0.5", 0.5], ["-0", -0], ["1,234,567.89", 1234567.89], ["007", 7], ["-€1,000", -1000]];
  for (const [s, want] of ok) assert.equal(readNumber(s), want, JSON.stringify(s));
  const no = ["1,20", "1,2,3", "12,34", "1e3", "12%", ".5", "5.", "0x10", "Infinity", "NaN", "(500)", "--5", "$-5", "€-5", "$ 5", "USD 5", "5 USD", "US$5", "$$5", "", "  ", "abc", "1 000", "١٢٣", "1,000,", ",100", "$", "-", "5-", "1.2.3", "−5"];
  for (const s of no) assert.equal(readNumber(s), null, JSON.stringify(s));
  assert.equal(readNumber(5), null);
  assert.equal(readNumber(null), null);
  assert.equal(readNumber("9".repeat(400)), null, "not finite = unreadable");
});

test("sign and symbol order: '-$5' is read, '$-5' is NOT (the symbol is glued directly before the digits)", async () => {
  const t = (cell) => mk(["Amt"], [[cell]]);
  assert.equal((await step([sumCheck()], { t: t("-$5") }, { c: { value: -5 } })).verdict, "green");
  const r = await step([sumCheck()], { t: t("$-5") }, { c: { value: -5 } });
  assert.equal(r.verdict, "red");
  assert.ok(r.gaps.some((g) => g.kind === "unreadable-cell" && g.items[0] === "2:Amt"));
});

// --- tolerance boundary -------------------------------------------------------------------------------------------

test("tolerance: exactly 0.005 off is green, just over is red (default for a float op)", () => {
  const t = { t: mk(["Amt"], [["100"]]) };
  const run = (v, extra) => runCheck({ id: "s", op: "sum", table: "t", column: "Amt", ...extra }, t, { value: v }).verdict;
  assert.equal(run(100), "green");
  assert.equal(run(100.005), "green", "0.005 away");
  assert.equal(run(99.995), "green", "0.005 below");
  assert.equal(run(100.0051), "red", "just over");
  assert.equal(run(99.9949), "red");
  assert.equal(run(100.01), "red", "a cent off");
});

test("tolerance: a signed tolerance overrides the default, both ways", () => {
  const t = { t: mk(["Amt"], [["100"]]) };
  const run = (v, tolerance) => runCheck({ id: "s", op: "sum", table: "t", column: "Amt", tolerance }, t, { value: v }).verdict;
  assert.equal(run(100.5, 0.5), "green");
  assert.equal(run(100.51, 0.5), "red");
  assert.equal(run(100.004, 0), "red", "tolerance 0 = exact");
  assert.equal(run(100, 0), "green");
});

test("tolerance: counts, row sets, days and uniqueCount are exact and refuse a tolerance", () => {
  const t = { t: mk(["Amt"], [["1"], ["2"]]) };
  assert.equal(runCheck({ id: "c", op: "count", table: "t", column: "Amt" }, t, { value: 2.004 }).verdict, "red");
  for (const op of ["count", "countEmpty", "uniqueCount", "found"]) {
    assert.equal(runCheck({ id: "c", op, table: "t", column: "Amt", needle: "1", tolerance: 1 }, t, { value: 2 }).stopped?.kind, "check-invalid", op);
  }
});

test("tolerance: float noise is not red (0.1 + 0.2 summed against 0.3)", () => {
  const t = { t: mk(["Amt"], [["0.1"], ["0.2"]]) };
  assert.equal(runCheck({ id: "s", op: "sum", table: "t", column: "Amt", tolerance: 0 }, t, { value: 0.3 }).verdict, "green");
});

// --- size caps ------------------------------------------------------------------------------------------------------------

test("cap: a table AT the cell cap is read, one cell OVER is red table-too-large (cells)", async () => {
  const col = (n) => ({ header: ["A"], rows: Array.from({ length: n }, (_, i) => ({ rowNumber: i + 2, cells: ["1"] })) });
  const chk = { id: "n", rule: "table", table: "t", op: "rowCount", n: TABLE_MAX_CELLS };
  const at = await step([chk], { t: col(TABLE_MAX_CELLS) });
  assert.equal(at.verdict, "green");
  const over = await step([chk], { t: col(TABLE_MAX_CELLS + 1) });
  assert.equal(over.verdict, "red");
  assert.deepEqual(over.gaps.map((g) => [g.kind, g.items, g.measured, g.limit]), [["table-too-large", ["cells"], TABLE_MAX_CELLS + 1, TABLE_MAX_CELLS]]);
  // rows x columns, not rows
  const wide = { header: Array.from({ length: 5 }, (_, i) => `h${i}`), rows: Array.from({ length: TABLE_MAX_CELLS / 5 + 1 }, (_, i) => ({ rowNumber: i + 2, cells: ["1", "1", "1", "1", "1"] })) };
  assert.equal((await step([{ ...chk, n: 1 }], { t: wide })).gaps[0].kind, "table-too-large");
  assert.equal(over.fault, null, "over the cap is red, like cited's source-too-large: not stopped");
});

test("cap: characters AT the cap are read, one OVER is red table-too-large (chars)", async () => {
  const one = (len) => ({ header: ["A"], rows: [{ rowNumber: 2, cells: ["x".repeat(len)] }] });
  const chk = { id: "n", rule: "table", table: "t", op: "rowCount", n: 1 };
  assert.equal((await step([chk], { t: one(TABLE_MAX_CHARS - 1) })).verdict, "green", "1 header char + cap-1 cell chars = cap");
  const over = await step([chk], { t: one(TABLE_MAX_CHARS) });
  assert.deepEqual(over.gaps.map((g) => [g.kind, g.items, g.limit]), [["table-too-large", ["chars"], TABLE_MAX_CHARS]]);
});

test("cap: the cap applies to each table of a diff, and a claim list over CLAIM_MAX is red claim-too-large", async () => {
  const big = { header: ["A"], rows: Array.from({ length: TABLE_MAX_CELLS + 1 }, (_, i) => ({ rowNumber: i + 2, cells: [String(i)] })) };
  const small = mk(["A"], [["0"]]);
  const r = await step([{ id: "d", rule: "diff", before: "b", after: "a", keyColumn: "A", op: "rowsAdded", n: 0 }], { b: small, a: big });
  assert.equal(r.gaps[0].kind, "table-too-large");
  const rows = mk(["A"], [["1"]]);
  const chk = { id: "r", rule: "cells", table: "t", claim: "c", op: "rows", where: [{ column: "A", cmp: "notEmpty" }] };
  assert.equal((await step([chk], { t: rows }, { c: { rows: new Array(CLAIM_MAX).fill(2) } })).gaps[0].kind, "rows-duplicated", "AT the claim cap is read");
  assert.equal((await step([chk], { t: rows }, { c: { rows: new Array(CLAIM_MAX + 1).fill(2) } })).gaps[0].kind, "claim-too-large");
});

test("cap: the worst ops at the cap stay far under a second (timing guard, generous bound)", () => {
  const cols = 10;
  const rowsN = TABLE_MAX_CELLS / cols;
  const mkT = (f) => ({ header: Array.from({ length: cols }, (_, i) => `C${i}`), rows: Array.from({ length: rowsN }, (_, r) => ({ rowNumber: r + 2, cells: Array.from({ length: cols }, (_, c) => f(r, c)) })) });
  const b = mkT((r, c) => (c === 0 ? `K${r}` : `v${r}x${c}`));
  const a = mkT((r, c) => (c === 0 ? `K${r}` : `w${r}y${c}`)); // every non-key cell changed
  const t0 = performance.now();
  const r = runCheck({ id: "d", op: "onlyColumnsChanged", before: "b", after: "a", keyColumn: "C0", columns: [] }, { b, a }, undefined);
  const ms = performance.now() - t0;
  assert.equal(r.verdict, "red");
  assert.ok(ms < 5000, `diff of two ${TABLE_MAX_CELLS}-cell tables took ${ms.toFixed(0)} ms`);
});

// --- createRubric: a bad signed check is refused at drafting ---------------------------------------------------------------

test("createRubric refuses: unknown op, unknown field, op fields that do not apply", () => {
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "evalFormula", column: "A" }, /op must be one of/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "count" }, /column is required for cells op count/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "count", column: "A", where: [{ column: "A", cmp: "empty" }] }, /where is not a recognised field/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "count", column: "A", regex: ".*" }, /regex is not a recognised field/);
  bad({ id: "x", rule: "cells", claim: "c", op: "count", column: "A" }, /table is required/);
  bad({ id: "x", rule: "cells", table: "t", op: "count", column: "A" }, /claim is required/);
  bad({ id: "x", rule: "table", table: "t", claim: "c", op: "noEmpty", column: "A" }, /claim is not a recognised field/);
  bad({ id: "x", rule: "diff", before: "b", after: "a", op: "rowsAdded", n: 0 }, /keyColumn is required for diff/);
  bad({ id: "x", rule: "diff", before: "b", after: "b", keyColumn: "K", op: "rowsAdded", n: 0 }, /different table/);
});

test("createRubric refuses: conditions (cmp, typed values, OR, size)", () => {
  const c = (where) => ({ id: "x", rule: "cells", table: "t", claim: "c", op: "countIf", where });
  bad(c([{ column: "A", cmp: "matches", value: "x" }]), /cmp must be one of/);
  bad(c([{ column: "A", cmp: "gt", value: "5" }]), /value must be a finite number/);
  bad(c([{ column: "A", cmp: "gt", value: Infinity }]), /finite number/);
  bad(c([{ column: "A", cmp: "between", lo: 5, hi: 1 }]), /lo must be <= hi/);
  bad(c([{ column: "A", cmp: "empty", value: 1 }]), /value is not a recognised field/);
  bad(c([{ column: "A", cmp: "equals", value: "x", or: [] }]), /or is not a recognised field/);
  bad(c([{ column: "A", cmp: "before", value: "2026-02-30" }]), /real date string/);
  bad(c([{ column: "A", cmp: "before", value: "22/10/2026" }]), /YYYY-MM-DD/);
  bad(c([]), /1-20 conditions/);
  bad(c(Array.from({ length: 21 }, () => ({ column: "A", cmp: "empty" }))), /1-20 conditions/);
  assert.doesNotThrow(() => rubricOf([c([{ column: "A", cmp: "gt", value: 5 }, { column: "B", cmp: "equals", value: "x" }, { column: "C", cmp: "empty" }])]));
});

test("createRubric refuses: date formats are a closed list, one entry per date column, exactly the columns read as dates", () => {
  const e = (dateFormats, extra = {}) => ({ id: "x", rule: "cells", table: "t", claim: "c", op: "earliest", column: "D", dateFormats, ...extra });
  assert.doesNotThrow(() => rubricOf([e([{ column: "D", format: "D MMM YYYY" }])]));
  for (const f of ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]) assert.doesNotThrow(() => rubricOf([e([{ column: "D", format: f }])]));
  bad(e([{ column: "D", format: "YYYY/MM/DD" }]), /format must be one of/);
  bad(e([{ column: "D", format: "dd/mm/yyyy" }]), /format must be one of/);
  bad(e([{ column: "D", format: "D MMMM YYYY" }]), /format must be one of/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "earliest", column: "D" }, /dateFormats is required/);
  bad(e([{ column: "D", format: "YYYY-MM-DD" }, { column: "D", format: "DD/MM/YYYY" }]), /one entry per column/);
  bad(e([{ column: "X", format: "YYYY-MM-DD" }]), /no entry for date column "D"/);
  bad(e([{ column: "D", format: "YYYY-MM-DD" }, { column: "X", format: "YYYY-MM-DD" }]), /entry for column "X", which the check does not read as a date/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "sum", column: "D", dateFormats: [{ column: "D", format: "YYYY-MM-DD" }] }, /dateFormats is not a recognised field|does not read as a date/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "daysSince", column: "D", cell: { column: "D", row: 2 }, asOf: "2026-01-01", dateFormats: [{ column: "D", format: "YYYY-MM-DD" }] }, /exactly one of cell, column/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "daysSince", column: "D", asOf: "01/01/2026", dateFormats: [{ column: "D", format: "DD/MM/YYYY" }] }, /asOf must be one real date string "YYYY-MM-DD"/);
});

test("createRubric refuses: tolerance (negative, non-number, on an exact op), allowEmpty type, bad n, bad bands", () => {
  bad(sumCheck({ tolerance: -0.01 }), /tolerance must be a finite number >= 0/);
  bad(sumCheck({ tolerance: "1" }), /tolerance must be a finite number >= 0/);
  bad(sumCheck({ tolerance: NaN }), /tolerance|finite/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "count", column: "A", tolerance: 1 }, /tolerance is not a recognised field|exact/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "daysBetween", from: { column: "D", row: 2 }, to: { column: "D", row: 3 }, tolerance: 1, dateFormats: [{ column: "D", format: "YYYY-MM-DD" }] }, /tolerance is not a recognised field|exact/);
  assert.doesNotThrow(() => rubricOf([sumCheck({ tolerance: 0 })]));
  bad({ id: "x", rule: "table", table: "t", op: "allNumbers", column: "A", allowEmpty: "yes" }, /allowEmpty must be a boolean/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "topN", column: "A", n: 0 }, /n must be an integer >= 1/);
  bad({ id: "x", rule: "table", table: "t", op: "rowCount", n: -1 }, /n must be an integer >= 0/);
  const band = (bands) => ({ id: "x", rule: "cells", table: "t", claim: "c", op: "band", column: "A", bands });
  bad(band([{ name: "a", lte: 0 }, { name: "b", lte: 10 }]), /bands 0 and 1 overlap/);
  bad(band([{ name: "a", lte: 10 }, { name: "b", gte: 10 }]), /overlap/);
  bad(band([{ name: "a", lt: 10 }, { name: "a", gte: 10 }]), /unique/);
  bad(band([{ name: "a", gt: 5, lt: 5 }]), /empty band/);
  bad(band([{ name: "a", gte: 5, gt: 4 }]), /at most one lower bound/);
  bad(band([{ name: "a", lte: "0" }]), /finite number/);
  bad(band([]), /1-20 bands/);
  assert.doesNotThrow(() => rubricOf([band([{ name: "a", lt: 10 }, { name: "b", gte: 10 }])]), "touching but not overlapping");
  assert.doesNotThrow(() => rubricOf([band([{ name: "a", lte: 10 }, { name: "b", gt: 10 }])]));
  assert.doesNotThrow(() => rubricOf([band([{ name: "only", gte: 5, lte: 5 }])]), "a single-value band is fine");
});

test("createRubric refuses: row math operands and the diff lists", () => {
  const rm = (extra) => ({ id: "x", rule: "table", table: "t", op: "rowMath", fn: "add", a: "A", b: "B", result: "R", ...extra });
  assert.doesNotThrow(() => rubricOf([rm({}), { ...rm({ b: { const: 0.1 } }), id: "y" }]));
  bad(rm({ fn: "pow" }), /fn must be one of/);
  bad(rm({ a: { const: 1 } }), /a must be a non-blank string/);
  bad(rm({ b: { const: "1" } }), /b.const must be a finite number/);
  bad(rm({ b: { const: 1, extra: 1 } }), /b.extra is not a recognised field/);
  bad({ id: "x", rule: "diff", before: "b", after: "a", keyColumn: "K", op: "onlyColumnsChanged", columns: "A" }, /columns must be a list/);
  bad({ id: "x", rule: "diff", before: "b", after: "a", keyColumn: "K", op: "onlyColumnsChanged", columns: ["A", "A"] }, /duplicates/);
  assert.doesNotThrow(() => rubricOf([{ id: "x", rule: "diff", before: "b", after: "a", keyColumn: "K", op: "onlyColumnsChanged", columns: [] }]), "an empty list = nothing may change");
  bad({ id: "x", rule: "diff", before: "b", after: "a", keyColumn: "K", op: "rowsAdded" }, /n is required/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "found", column: "A", needle: "x", valueKind: "number" }, /needle must read as a number/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "range" }, /op must be one of/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "sum", column: "A", range: { from: 1, to: 5 } }, /range.from must be an integer >= 2/);
  bad({ id: "x", rule: "cells", table: "t", claim: "c", op: "sum", column: "A", range: { from: 5, to: 3 } }, /range.to/);
});

test("the signed check is part of the signature: changing a tolerance, a format or a band changes rubricSha", () => {
  const sha = (checks) => rubricSha({ schema: 1, goal: "g", inputs: inputsOf(checks), checkpoints: { cp: { gating: true, checks } } });
  assert.notEqual(sha([sumCheck()]), sha([sumCheck({ tolerance: 0.01 })]));
  const e = (format) => ({ id: "x", rule: "cells", table: "t", claim: "c", op: "earliest", column: "D", dateFormats: [{ column: "D", format }] });
  assert.notEqual(sha([e("DD/MM/YYYY")]), sha([e("MM/DD/YYYY")]));
});

// --- vocabulary <-> implementation, per op, both directions ---------------------------------------------------------------

const SAMPLE = {
  column: "A", groupColumn: "G", keyColumn: "K", keyValue: "k", needle: "n", valueKind: "text", n: 1, where: [{ column: "A", cmp: "gt", value: 1 }],
  tolerance: 0.5, allowEmpty: true, range: { from: 2, to: 9 }, asOf: "2026-01-31", fn: "add", a: "A", b: "B", result: "R", order: "asc", ties: "all",
  bands: [{ name: "lo", lte: 5 }, { name: "hi", gt: 5 }], from: { column: "D", row: 2 }, to: { column: "D", row: 3 }, cell: { column: "D", row: 2 },
  columns: ["A"], exceptKeys: ["k"], dateFormats: [{ column: "D", format: "YYYY-MM-DD" }],
};
const RULE_BASE = { cells: { table: "t", claim: "c" }, table: { table: "t" }, diff: { before: "b", after: "a", keyColumn: "K" } };
/** A minimal valid check for an op: the vocabulary's `requires` only (plus what a date op needs to be consistent). */
function minimal(rule, op, def) {
  const c = { id: "x", rule, ...RULE_BASE[rule], op };
  for (const k of def.requires) c[k] = k === "dateFormats" ? SAMPLE.dateFormats : SAMPLE[k];
  if (op === "lookup") c.valueKind = "text";
  if (op === "earliest" || op === "latest" || op === "allDates") c.column = "D";
  if (op === "daysSince") { c.cell = SAMPLE.cell; }
  if (op === "band") delete c.dateFormats;
  return c;
}
for (const rule of ["cells", "table", "diff"]) {
  const v = rubricVocabulary.rules[rule];
  for (const [op, def] of Object.entries(v.ops)) {
    test(`vocabulary <-> implementation: ${rule}.${op}`, async () => {
      assert.ok(v.fields.op.enum.includes(op), "listed in the op enum");
      // vocab -> implemented: its minimal check is accepted and dispatch runs (no exception fault)
      const ok = minimal(rule, op, def);
      const r = await step([ok], { t: mk(["A", "K", "G", "D", "B", "R"], [["1", "k", "g", "2026-01-01", "1", "2"]]), b: mk(["K"], [["k"]]), a: mk(["K"], [["k"]]) }, { c: {} });
      assert.notEqual(r.fault?.kind, "exception", `${rule}.${op}: ${r.fault?.detail}`);
      // every REQUIRED field the vocabulary lists is really required
      for (const k of def.requires) {
        const { [k]: _d, ...without } = ok;
        assert.throws(() => rubricOf([without]), new RegExp(`${k} is required|requires|dateFormats`), `${rule}.${op}.${k}`);
      }
      // implemented -> vocab: a field it does not list for this op is refused
      const unlisted = Object.keys(v.fields).find((k) => !def.requires.includes(k) && !def.allows.includes(k) && !["table", "claim", "before", "after", "op", "text", "keyColumn"].includes(k));
      if (unlisted) assert.throws(() => rubricOf([{ ...ok, [unlisted]: SAMPLE[unlisted] }]), /not a recognised field|exact|only/, `${rule}.${op} refuses ${unlisted}`);
      assert.throws(() => rubricOf([{ ...ok, notInVocab: 1 }]), /not a recognised field/);
    });
  }
}

test("vocabulary: cells, table and diff list their ops with requires, allows and (cells) the claim shape; description is generated", () => {
  const v = rubricVocabulary.rules;
  assert.deepEqual(Object.keys(v.cells.ops), ["count", "countEmpty", "countIf", "sum", "sumIf", "average", "averageIf", "median", "min", "max", "found", "lookup", "rows", "topN", "uniqueCount", "duplicates", "groupTotals", "percentOfTotal", "band", "daysBetween", "daysSince", "earliest", "latest"]);
  assert.deepEqual(Object.keys(v.table.ops), ["allNumbers", "allDates", "noEmpty", "noDuplicates", "rowCount", "rowMath"]);
  assert.deepEqual(Object.keys(v.diff.ops), ["onlyColumnsChanged", "untouchedIdentical", "rowsAdded", "rowsDeleted", "newColumnRule"]);
  for (const [op, d] of Object.entries(v.cells.ops)) assert.equal(typeof d.claim, "string", `cells.${op} describes its claim shape`);
  for (const rule of ["cells", "table", "diff"]) for (const [op, d] of Object.entries(v[rule].ops)) {
    assert.ok(d.summary && Array.isArray(d.requires) && Array.isArray(d.allows), `${rule}.${op}`);
    assert.ok(v[rule].description.includes(op), `${rule} description names ${op}`);
  }
  assert.equal(v.cells.description, describeRule("cells"));
  assert.deepEqual(rubricVocabulary.cells.dateFormats, ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "D MMM YYYY"]);
  assert.equal(rubricVocabulary.cells.tableMaxCells, TABLE_MAX_CELLS);
  assert.equal(rubricVocabulary.cells.tableMaxChars, TABLE_MAX_CHARS);
  assert.equal(rubricVocabulary.cells.claimMaxEntries, CLAIM_MAX);
  assert.equal(v.diff.fields.keyColumn.required, true);
  assert.equal(v.cells.fields.tolerance.required, false);
  assert.ok(Object.isFrozen(v.cells.ops.count));
});

// --- checkStep: tables come in via opts.tables ---------------------------------------------------------------------------------

test("checkStep: no opts.tables, a missing table, a malformed table -> stopped (table-invalid), never green, never a crash", async () => {
  const chk = sumCheck();
  const r1 = await checkStep(rubricOf([chk], { t: T1 }), "cp", { c: { value: 30 } });
  assert.equal(r1.verdict, "stopped");
  assert.equal(r1.fault.kind, "table-invalid");
  assert.deepEqual(r1.gaps, []);
  const r2 = await step([chk], { other: T1 }, { c: { value: 30 } });
  assert.equal(r2.fault.kind, "table-invalid");
  const r3 = await step([chk], { t: { header: ["Amt"], rows: [{ rowNumber: 2, cells: [5] }] } }, { c: { value: 5 } });
  assert.equal(r3.verdict, "stopped");
  const r4 = await step([chk], { t: mk(["Amt"], [["5"]]) }, { c: { value: 5 } });
  assert.equal(r4.verdict, "green");
});

test("checkStep: a throwing opts.tables getter and a Proxy tables object are stopped, not a throw", async () => {
  const rubric = rubricOf([sumCheck()], { t: T1 });
  const getter = await checkStep(rubric, "cp", { c: { value: 1 } }, { get tables() { throw new Error("boom"); } });
  assert.equal(getter.verdict, "stopped");
  const px = new Proxy({}, { get() { throw new Error("t"); }, has() { throw new Error("t"); }, getOwnPropertyDescriptor() { throw new Error("t"); }, ownKeys() { throw new Error("t"); } });
  const r = await checkStep(rubric, "cp", { c: { value: 1 } }, { tables: px });
  assert.equal(r.verdict, "stopped");
});

test("checkStep: stopped outranks red (a broken table in one check, a bad claim in another)", async () => {
  const r = await step([sumCheck({ id: "ok" }), sumCheck({ id: "broken", table: "nope" })], { t: T1 }, { c: { value: 999 } });
  assert.equal(r.verdict, "stopped");
  assert.equal(r.fault.id, "broken");
  assert.deepEqual(r.gaps, []);
  assert.equal(r.full.gaps.length, 1, "the red stays in full only");
});

test("checkStep: the claim field is read from the output: missing, wrong type, a string output", async () => {
  const chk = sumCheck({ claim: "answer" });
  assert.equal((await step([chk], { t: T1 }, { other: 1 })).gaps[0].kind, "claim-missing");
  assert.equal((await step([chk], { t: T1 }, { answer: 30 })).gaps[0].kind, "claim-malformed");
  assert.equal((await step([chk], { t: T1 }, "30")).gaps[0].kind, "claim-missing");
  assert.equal((await step([sumCheck({ claim: "text" })], { t: T1 }, "30")).gaps[0].kind, "claim-malformed", "a string output is the single field `text`: not a claim object");
  assert.equal((await step([chk], { t: T1 }, { answer: { value: 30 } })).verdict, "green");
});

test("checkStep: a table shared by several checks is read once per step (a later mutation does not change the verdict)", async () => {
  const t = mk(["Amt"], [["10"], ["20"]]);
  const rubric = rubricOf([sumCheck({ id: "one" }), sumCheck({ id: "two", op: "average" })], { t });
  let reads = 0;
  const tables = { get t() { reads++; return t; } };
  const r = await checkStep(rubric, "cp", { c: { value: 30 } }, { tables });
  assert.equal(reads, 1, "snapshotted once");
  assert.deepEqual(r.gaps.map((g) => g.id), ["two"], "30 is the sum, not the average (15)");
});

test("checkStep: the result is deep-frozen and full.expected only appears for these rules", async () => {
  const r = await step([sumCheck()], { t: T1 }, { c: { value: 30 } });
  assert.ok(Object.isFrozen(r.full.expected) && Object.isFrozen(r.full.expected[0]));
  assert.deepEqual(r.full.expected, [{ check: "s", value: 30 }]);
  const plain = await checkStep(createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "w", rule: "maxWords", field: "text", value: 5 }] } } }), "cp", "one two");
  assert.equal("expected" in plain.full, false);
});

test("checkStep: a hostile claim object never crashes a table check run (getter, Proxy, __proto__ key)", async () => {
  const chk = sumCheck();
  const getter = await step([chk], { t: T1 }, { c: { get value() { throw new Error("x"); } } });
  assert.equal(getter.gaps[0].kind, "claim-unreadable");
  const px = new Proxy({}, { get() { throw new Error("t"); }, has() { throw new Error("t"); }, getOwnPropertyDescriptor() { throw new Error("t"); }, ownKeys() { throw new Error("t"); } });
  assert.equal((await step([chk], { t: T1 }, { c: px })).gaps[0].kind, "claim-unreadable");
  const proto = await step([chk], { t: T1 }, { c: JSON.parse('{"__proto__": {"value": 30}}') });
  assert.equal(proto.gaps[0].kind, "claim-missing");
  assert.equal({}.value, undefined, "Object.prototype untouched");
});

// --- rendering --------------------------------------------------------------------------------------------------------------------

test("renderGaps: every cells/table/diff gap renders as a sentence, with ' and N more' when items were cut", async () => {
  const many = mk(["V"], Array.from({ length: 30 }, () => ["x"]));
  const r = await step([{ id: "dup", rule: "table", table: "t", op: "noDuplicates", column: "V" }, { id: "num", rule: "table", table: "t", op: "allNumbers", column: "V" }], { t: many });
  assert.equal(r.verdict, "red");
  const s = renderGaps(r.gaps);
  assert.ok(s.startsWith("dup: rows sharing a value: 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21 and 10 more; num: cells that are not numbers: 2, "), s);
  assert.ok(s.endsWith(" and 10 more"));
  assert.equal(renderGaps(r.gaps), renderGaps(r.gaps), "deterministic");
  const m = await step([sumCheck()], { t: T1 }, { c: { value: 31 } });
  assert.equal(renderGaps(m.gaps), "s: claimed value does not match (31)");
  const c = await step([{ id: "n", rule: "table", table: "t", op: "rowCount", n: 5 }], { t: T1 });
  assert.equal(renderGaps(c.gaps), "n: wrong row count (2 vs 5)");
  const w = await step([sumCheck()], { t: T1 }, { c: {} });
  assert.equal(renderGaps(w.gaps), "s: claim field is missing: value");
});

test("renderGaps: a cells gap with a hostile field falls back, never throws", () => {
  const g = { get kind() { return "value-mismatch"; }, get id() { throw new Error("x"); } };
  assert.doesNotThrow(() => renderGaps([g]));
  assert.equal(renderGaps([{ kind: "value-mismatch", id: 5 }]).startsWith("[null,null,\"value-mismatch\""), true);
});

// --- the Gate --------------------------------------------------------------------------------------------------------------------

test("Gate: gate.checkStep passes opts.tables through; red and stopped are audited; a stopped verdict denies advance", async (t) => {
  const dir = await makeTmpDir();
  t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const spec = { schema: 1, goal: "g", inputs: [{ name: "t", sha256: tableSha(T1) }], checkpoints: { sums: { gating: true, checks: [sumCheck()] } } };
  const gate = new Gate({ audit: { path: auditPath }, rubric: { spec, sha256: rubricSha(spec), advanceOn: ["done"] }, runId });
  await gate.init();
  const red = await gate.checkStep("sums", { c: { value: 31 } }, { tables: { t: T1 } });
  assert.equal(red.verdict, "red");
  const green = await gate.checkStep("sums", { c: { value: 30 } }, { tables: { t: T1 } });
  assert.equal(green.verdict, "green");
  const stopped = await gate.checkStep("sums", { c: { value: 30 } }, { tables: {} });
  assert.equal(stopped.verdict, "stopped");
  const lines = fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.phase === "rubric");
  assert.deepEqual(lines.map((l) => l.verdict), ["red", "green", "stopped"]);
  assert.equal(lines[0].gaps[0].kind, "value-mismatch");
  assert.ok(!JSON.stringify(lines[0]).includes('"expected"'), "the expected answer is not in the audit line");
});

// --- tables are LOCKED by a signed sha256 (hamr 2026-10-22), like a cited source ----------------------------------------------

const LOCK = mk(["Id", "Amt"], [["a", "10"], ["b", "20"], ["c", "30"]]);
const lockRubric = (extra = {}) => createRubric({ schema: 1, goal: "g", inputs: [{ name: "t", sha256: tableSha(LOCK) }], checkpoints: { cp: { gating: true, checks: [{ id: "n", rule: "cells", table: "t", claim: "c", op: "count", column: "Amt", ...extra }] } } });
const lockRun = (tables, claim = 3) => checkStep(lockRubric(), "cp", { c: { value: claim } }, { tables });
const clone = (t) => JSON.parse(JSON.stringify(t));

test("lock: a table that hashes to its signed sha256 is read (green and red as before)", async () => {
  assert.equal((await lockRun({ t: LOCK })).verdict, "green");
  assert.equal((await lockRun({ t: clone(LOCK) })).verdict, "green", "a fresh copy of the same rows");
  assert.equal((await lockRun({ t: LOCK }, 4)).verdict, "red");
  assert.match(tableSha(LOCK), /^[0-9a-f]{64}$/);
  assert.equal(tableSha(clone(LOCK)), tableSha(LOCK));
});

test("lock: the swapped-table probe: a signed count over t, a different 1-row table passed in -> stopped, not green", async () => {
  const other = mk(["Id", "Amt"], [["z", "1"]]);
  const r = await lockRun({ t: other }, 1);
  assert.equal(r.verdict, "stopped");
  assert.equal(r.fault.kind, "missing-measurement", "same fault kind as a cited input that does not match its sha256");
  assert.match(r.fault.detail, /table t does not match its signed sha256/);
  assert.deepEqual(r.gaps, []);
});

test("lock: ONE changed cell, a changed rowNumber, a reordered row, a changed header, an added or dropped row each -> stopped", async () => {
  const cell = clone(LOCK); cell.rows[1].cells[1] = "21";
  const rn = clone(LOCK); rn.rows[2].rowNumber = 5;
  const order = clone(LOCK); [order.rows[0], order.rows[1]] = [order.rows[1], order.rows[0]]; // rowNumbers now out of order too
  const orderOnly = clone(LOCK); orderOnly.rows[0].cells = LOCK.rows[1].cells.slice(); orderOnly.rows[1].cells = LOCK.rows[0].cells.slice(); // same rowNumbers, rows swapped
  const head = clone(LOCK); head.header[1] = "Amount";
  const added = clone(LOCK); added.rows.push({ rowNumber: 5, cells: ["d", "40"] });
  const dropped = clone(LOCK); dropped.rows.pop();
  const ws = clone(LOCK); ws.rows[0].cells[0] = "a ";
  for (const [name, t] of Object.entries({ cell, rn, order, orderOnly, head, added, dropped, ws })) {
    const r = await lockRun({ t });
    assert.equal(r.verdict, "stopped", name);
    assert.notEqual(tableSha(t), tableSha(LOCK), name);
  }
  assert.equal((await lockRun({ t: clone(LOCK) })).verdict, "green");
});

test("lock: the sha is injective over the canonical form (a cell holding a delimiter-looking string does not collide)", () => {
  const a = mk(["A", "B"], [["x", "y"]]);
  const b = mk(["A", "B"], [['x","y', ""]]);
  const c = mk(["A,B"], [["x"]]);
  assert.equal(new Set([tableSha(a), tableSha(b), tableSha(c), tableSha(mk(["A", "B"], []))]).size, 4);
});

test("lock: tableSha never throws; a malformed or hostile table returns null, which createRubric refuses as an input sha256", () => {
  const px = new Proxy({}, { get() { throw new Error("t"); }, has() { throw new Error("t"); }, getOwnPropertyDescriptor() { throw new Error("t"); }, ownKeys() { throw new Error("t"); } });
  const hostile = [undefined, null, 5, "t", [], {}, { header: [], rows: [] }, { header: ["A"] }, { header: ["A", "A"], rows: [] }, { header: ["A"], rows: [{ rowNumber: 2, cells: [5] }] },
    { header: ["A"], rows: [{ rowNumber: 2, cells: ["1", "2"] }] }, { header: ["A"], rows: [{ rowNumber: 1, cells: ["1"] }] }, { header: ["A"], rows: [{ rowNumber: 3, cells: ["1"] }, { rowNumber: 3, cells: ["1"] }] },
    { get header() { throw new Error("x"); }, rows: [] }, { header: ["A"], rows: new Proxy([], { get() { throw new Error("t"); } }) }, px, JSON.parse('{"__proto__": {"x": 1}, "header": ["A"], "rows": []}')];
  for (const h of hostile.slice(0, -1)) assert.equal(tableSha(h), null);
  assert.equal(typeof tableSha(hostile.at(-1)), "string", "a __proto__ own key on the table object is ignored, not followed");
  assert.equal(tableSha({ header: ["A"], rows: Array.from({ length: TABLE_MAX_CELLS + 1 }, (_, i) => ({ rowNumber: i + 2, cells: ["1"] })) }), null, "over the size cap cannot be signed");
  assert.throws(() => createRubric({ schema: 1, goal: "g", inputs: [{ name: "t", sha256: tableSha(null) }], checkpoints: { cp: { gating: true, checks: [sumCheck()] } } }), /sha256/);
});

test("lock: createRubric refuses a table that is not a signed input (cells, table, and a diff's BEFORE)", () => {
  const cp = (checks, inputs) => ({ schema: 1, goal: "g", ...(inputs ? { inputs } : {}), checkpoints: { cp: { gating: true, checks } } });
  const sig = (name) => ({ name, sha256: "a".repeat(64) });
  assert.throws(() => createRubric(cp([sumCheck()])), /checks\[0\]\.table names table "t", which is not in spec.inputs/);
  assert.throws(() => createRubric(cp([sumCheck()], [sig("other")])), /not in spec.inputs/);
  assert.throws(() => createRubric(cp([{ id: "x", rule: "table", table: "t", op: "rowCount", n: 1 }])), /not in spec.inputs/);
  const d = { id: "x", rule: "diff", before: "b", after: "a", keyColumn: "K", op: "rowsAdded", n: 0 };
  assert.throws(() => createRubric(cp([d], [sig("a")])), /\.before names table "b", which is not in spec.inputs/, "signing only the AFTER table is not enough");
  assert.doesNotThrow(() => createRubric(cp([sumCheck()], [sig("t")])));
  assert.doesNotThrow(() => createRubric(cp([d], [sig("b")])), "only the BEFORE table is signed; the AFTER table is the artifact being checked");
});

test("lock: a diff's BEFORE table is locked, its AFTER table is not (it comes via opts.tables, unsigned)", async () => {
  const before = mk(["K", "V"], [["k1", "1"], ["k2", "2"]]);
  const after = mk(["K", "V"], [["k1", "1"], ["k2", "9"]]);
  const rubric = createRubric({ schema: 1, goal: "g", inputs: [{ name: "b", sha256: tableSha(before) }], checkpoints: { cp: { gating: true, checks: [{ id: "d", rule: "diff", before: "b", after: "a", keyColumn: "K", op: "onlyColumnsChanged", columns: ["V"] }] } } });
  assert.equal((await checkStep(rubric, "cp", { a: 1 }, { tables: { b: before, a: after } })).verdict, "green");
  const fake = mk(["K", "V"], [["k1", "5"], ["k2", "9"]]); // the agent hands in an edited BEFORE: caught
  const r = await checkStep(rubric, "cp", { a: 1 }, { tables: { b: fake, a: after } });
  assert.equal(r.verdict, "stopped");
  assert.match(r.fault.detail, /table b does not match/);
  const changedAfter = mk(["K", "V"], [["k1", "7"], ["k2", "9"]]);
  assert.equal((await checkStep(rubric, "cp", { a: 1 }, { tables: { b: before, a: changedAfter } })).verdict, "green", "any AFTER is read; the check judges it");
});

test("lock: a missing table is still stopped table-invalid (not a sha mismatch)", async () => {
  const r = await lockRun({});
  assert.equal(r.verdict, "stopped");
  assert.equal(r.fault.kind, "table-invalid");
});

test("lock: the signed sha is part of rubricSha, and a hostile table never crashes the lock", async () => {
  const sha = (t) => rubricSha({ schema: 1, goal: "g", inputs: [{ name: "t", sha256: tableSha(t) }], checkpoints: { cp: { gating: true, checks: [sumCheck()] } } });
  assert.notEqual(sha(LOCK), sha(mk(["Id", "Amt"], [["a", "11"]])));
  const px = new Proxy({}, { get() { throw new Error("t"); }, has() { throw new Error("t"); }, getOwnPropertyDescriptor() { throw new Error("t"); }, ownKeys() { throw new Error("t"); } });
  for (const t of [px, null, { header: ["Id", "Amt"], rows: [{ rowNumber: 2, cells: [1, 2] }] }]) assert.equal((await lockRun({ t })).verdict, "stopped");
});

// --- vocabulary examples stay honest ----------------------------------------------------------------------------------------------

test("vocabulary: every op has a worked example (signed check + claim) and every one runs GREEN through checkStep", async () => {
  const T = rubricVocabulary.cells.exampleTables;
  const rubricFor = (check) => createRubric({ schema: 1, goal: "g", inputs: [{ name: "t", sha256: tableSha(T.t) }], checkpoints: { cp: { gating: true, checks: [check] } } });
  let n = 0;
  for (const rule of ["cells", "table", "diff"]) {
    for (const [op, d] of Object.entries(rubricVocabulary.rules[rule].ops)) {
      assert.ok(d.example && d.example.check, `${rule}.${op} has an example`);
      assert.equal(d.example.check.rule, rule);
      assert.equal(d.example.check.op, op);
      assert.equal(rule === "cells", d.example.output !== undefined, `${rule}.${op}: an output exactly for cells`);
      assert.equal(d.example.claim, undefined, "one form: output");
      if (rule === "cells") assert.deepEqual(Object.keys(d.example.output), [d.example.check.claim], "the claim sits under the signed claim field");
      const r = await checkStep(rubricFor({ ...d.example.check }), "cp", d.example.output ?? { unused: 1 }, { tables: T });
      assert.equal(r.verdict, "green", `${rule}.${op}: ${JSON.stringify(r.gaps)} ${JSON.stringify(r.fault)}`);
      n++;
    }
  }
  assert.equal(n, 34);
});

test("vocabulary examples are mutation-sensitive: a wrong claim on each cells example is red, not green", async () => {
  const T = rubricVocabulary.cells.exampleTables;
  for (const [op, d] of Object.entries(rubricVocabulary.rules.cells.ops)) {
    const mutate = (v) => {
      if (typeof v === "number") return v + 1000;
      if (typeof v === "boolean") return !v;
      if (typeof v === "string") return /^\d{4}-/.test(v) ? "1999-01-01" : `${v}!`;
      if (Array.isArray(v)) return [...v, typeof v[0] === "number" ? 99 : typeof v[0] === "string" ? "zz" : { group: "zz", total: 1 }];
      return Object.fromEntries(Object.entries(v).map(([a, b]) => [a, mutate(b)]));
    };
    const wrong = JSON.parse(JSON.stringify(d.example.output.answer));
    const k = Object.keys(wrong)[0];
    wrong[k] = mutate(wrong[k]);
    const rubric = createRubric({ schema: 1, goal: "g", inputs: [{ name: "t", sha256: tableSha(T.t) }], checkpoints: { cp: { gating: true, checks: [d.example.check] } } });
    const r = await checkStep(rubric, "cp", { answer: wrong }, { tables: T });
    assert.equal(r.verdict, "red", `${op} with a wrong claim`);
  }
});

test("vocabulary examples: the key typing a drafter should copy", () => {
  const ex = rubricVocabulary.rules.cells.ops;
  assert.ok(ex.rows.example.output.answer.rows.every(Number.isInteger));
  assert.equal(typeof ex.count.example.output.answer.value, "number");
  assert.deepEqual(Object.keys(ex.daysSince.example.output.answer.days), ["2", "3", "4"], "digit-string row keys");
  assert.ok(Object.values(ex.daysSince.example.output.answer.days).every((v) => typeof v === "number"));
  assert.ok(Object.values(ex.band.example.output.answer.bands).every((v) => typeof v === "string"));
  assert.equal(typeof ex.earliest.example.output.answer.value, "string");
  assert.ok(Object.isFrozen(ex.count.example.output.answer));
});

test("vocabulary examples: the *If ops use a NUMERIC condition and the output wrapper is the full step output", () => {
  const ex = rubricVocabulary.rules.cells.ops;
  for (const op of ["countIf", "sumIf", "averageIf", "percentOfTotal"]) {
    assert.deepEqual(ex[op].example.check.where, [{ column: "Amount", cmp: "gt", value: 100 }], op);
  }
  assert.deepEqual(ex.count.example.output, { answer: { value: 3 } });
});
