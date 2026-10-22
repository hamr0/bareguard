// rubric `cells` / `table` / `diff` rules (docs/product/cells-prd.md, ruling #67).
//
// The caller parses its file and hands TYPED ROWS: `{ header: string[], rows: [{ rowNumber, cells: string[] }] }`
// (every cell a string, rowNumber 2-based and strictly increasing). The signer picks the op, the columns and the
// conditions; the step supplies VALUES only (the claim). bareguard recomputes and compares. No model, no clock, no user
// regex, no formula language (Laws 5, 11). Law 1: a bad or hostile CLAIM is red. Law 10: a broken check or table, or an
// unexpected exception, is `stopped`, never green.
//
// One module owns: the readers (number and date forms are SemVer surface), the op table (drives validation at
// createRubric, the runtime, and `rubricVocabulary`), and the evaluators. Pure; never throws.

import { createHash } from "node:crypto";

// --- constants ---------------------------------------------------------------

/** Cells (rows x columns) one table may hold. Over it = red `table-too-large` (like cited's work cap: deterministic, never a clock). */
export const TABLE_MAX_CELLS = 500_000;
/** UTF-16 units over every cell and header of one table. */
export const TABLE_MAX_CHARS = 16 * 1024 * 1024;
/** Entries of a claim list or map we will walk. */
export const CLAIM_MAX = 100_000;
export const ITEMS = 20; // bound of an `items` list in a gap (= the rubric's MAX_ITEMS)
const EXPECTED_ROWS = 200; // rows of the expected answer kept in `full.expected`
const CLIP = 120;
const MAX_SIGNED = 1000;
const MAX_NAME = 128;
const MAX_CONDS = 20;
const MAX_BANDS = 20;
const MAX_KEYS = 1000; // exceptKeys / columns lists
const MONEY_TOL = 0.005; // default absolute tolerance of a float op: a claim rounded to cents is green, a cent off is red
const FLOAT_SLACK = 1e-9; // relative slack for float noise only

export const DATE_FORMATS = Object.freeze(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "D MMM YYYY"]);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// --- readers (SemVer surface: changing them changes verdicts) ------------------

// Optional sign, then an optional currency symbol glued to the digits ("-$5"; "$-5" is NOT read), "," only in proper
// thousands groups, optional decimals. Refused: 1e3, 12%, .5, 0x10, Infinity, "(500)", a code before the number.
const NUM_RE = /^[+-]?[$€£]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

/** @param {any} s @returns {number|null} */
export function readCellNumber(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!NUM_RE.test(t)) return null;
  const n = Number(t.replace(/[$€£,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const isBlank = (s) => s.trim() === "";
const isInt = (n) => Number.isInteger(n);

const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
function daysIn(y, m) {
  return m === 2 ? (leap(y) ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}
/** Days since 1970-01-01 (proleptic Gregorian). Integer arithmetic, no Date object, no time zone. */
function civilDay(y, m, d) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}
function realDay(y, m, d) {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  return civilDay(y, m, d);
}
const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_SLASH = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const RE_DMY = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/;

/**
 * Read ONE date in EXACTLY the signed format, validated against the real calendar; the day number, or null. Never guesses:
 * "03/04/2026" is read only by a signed slash format, "3/4/2026" and "2026-2-3" are never read. `D MMM YYYY` takes a
 * 1- or 2-digit day and the English 3-letter month in any letter case (`22 Oct 2026`, `22 OCT 2026`; "Sept" is not read).
 * @param {any} s @param {string} format
 */
export function readCellDate(s, format) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  let m;
  switch (format) {
    case "YYYY-MM-DD":
      return (m = RE_ISO.exec(t)) ? realDay(+m[1], +m[2], +m[3]) : null;
    case "DD/MM/YYYY":
      return (m = RE_SLASH.exec(t)) ? realDay(+m[3], +m[2], +m[1]) : null;
    case "MM/DD/YYYY":
      return (m = RE_SLASH.exec(t)) ? realDay(+m[3], +m[1], +m[2]) : null;
    case "D MMM YYYY": {
      if (!(m = RE_DMY.exec(t))) return null;
      const mo = MONTHS.indexOf(m[2].toLowerCase());
      return mo < 0 ? null : realDay(+m[3], mo + 1, +m[1]);
    }
    default:
      return null;
  }
}
const readIso = (s) => readCellDate(s, "YYYY-MM-DD");
function dayToIso(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

// --- errors ------------------------------------------------------------------

class Invalid extends Error { // the SIGNED check is malformed (createRubric refuses; at runtime = stopped check-invalid)
  constructor(path, msg) { super(msg); this.path = path; }
}
class Stop extends Error { // the instrument cannot measure: stopped
  constructor(kind, detail) { super(kind); this.kind = kind; this.detail = detail; }
}
class Bad extends Error { // the claim (or a cell the worker produced) is bad: red
  constructor(kind, detail) { super(kind); this.kind = kind; this.detail = detail; }
}
class Big extends Error { // over a size cap: red
  constructor(measured, limit, what) { super("table-too-large"); this.measured = measured; this.limit = limit; this.what = what; }
}

// --- the op table --------------------------------------------------------------
// Per op: `req` / `opt` = signed fields beyond the rule's `table`/`op` (and `claim` for `cells`, `before`/`after`/`keyColumn` for diff),
// `claim` = the claim keys it reads and their shape, `float` = float tolerance applies, `needs` = how date formats are used.

const R = "range";
/** @type {Record<string, Record<string, {req: string[], opt: string[], claim?: string, float?: boolean, summary: string}>>} */
const OPS = {
  cells: {
    count: { req: ["column"], opt: [R], claim: "{ value: integer }", summary: "non-blank cells of column" },
    countEmpty: { req: ["column"], opt: [R], claim: "{ value: integer }", summary: "blank cells of column" },
    countIf: { req: ["where"], opt: [R], claim: "{ value: integer }", summary: "rows matching where" },
    sum: { req: ["column"], opt: [R, "tolerance"], float: true, claim: "{ value: number }", summary: "sum of column (blanks skipped)" },
    sumIf: { req: ["column", "where"], opt: [R, "tolerance"], float: true, claim: "{ value: number }", summary: "sum of column over rows matching where" },
    average: { req: ["column"], opt: [R, "tolerance"], float: true, claim: "{ value: number }", summary: "mean of column (blanks skipped; none = red no-values)" },
    averageIf: { req: ["column", "where"], opt: [R, "tolerance"], float: true, claim: "{ value: number }", summary: "mean of column over rows matching where" },
    median: { req: ["column"], opt: [R, "where", "tolerance"], float: true, claim: "{ value: number }", summary: "median of column (even count: mean of the middle two)" },
    min: { req: ["column"], opt: [R, "where", "tolerance"], float: true, claim: "{ value: number }", summary: "smallest number of column" },
    max: { req: ["column"], opt: [R, "where", "tolerance"], float: true, claim: "{ value: number }", summary: "largest number of column" },
    found: { req: ["column", "needle"], opt: [R, "valueKind"], claim: "{ value: boolean }", summary: "needle is (or is not) a cell of column; valueKind text (exact) or number" },
    lookup: { req: ["column", "keyColumn", "keyValue", "valueKind"], opt: [R, "dateFormats", "tolerance"], float: true, claim: "{ value: string|number }", summary: "the cell of column on the one row whose keyColumn equals keyValue (0 or 2+ matches = red)" },
    rows: { req: ["where"], opt: [R, "keyColumn", "valueKind"], claim: "{ rows: integer[] } or { keys: string[] } (keys needs keyColumn; valueKind text|number, default text)", summary: "the claimed row numbers EQUAL the matching rows: none missing, none extra" },
    topN: { req: ["column", "n"], opt: [R, "where", "order", "ties", "tolerance"], float: true, claim: "{ rows: integer[] } or { values: number[] }", summary: "the n largest (order desc) or smallest (asc); ties any (default) or all" },
    uniqueCount: { req: ["column"], opt: [R, "valueKind"], claim: "{ value: integer }", summary: "distinct non-blank values of column" },
    duplicates: { req: ["column"], opt: [R], claim: "{ values: string[] } and/or { rows: integer[] }", summary: "values (and the rows) that occur more than once in column" },
    groupTotals: { req: ["column", "groupColumn"], opt: [R, "where", "tolerance"], float: true, claim: "{ totals: [{ group: string, total: number }] }", summary: "sum of column per distinct groupColumn value" },
    percentOfTotal: { req: ["column", "where"], opt: [R, "tolerance"], float: true, claim: "{ value: number }", summary: "sum over rows matching where as a percent of the column's total" },
    band: { req: ["column", "bands"], opt: [R, "where", "asOf", "dateFormats", "allowEmpty"], claim: "{ bands: { \"<rowNumber>\": \"<band name>\" } }", summary: "each row's number (or, with asOf, its days since the date column) falls in one signed band" },
    daysBetween: { req: ["from", "to", "dateFormats"], opt: [], claim: "{ value: integer }", summary: "whole days from the date cell `from` to the date cell `to` (signed)" },
    daysSince: { req: ["asOf", "dateFormats"], opt: ["cell", "column", R, "where", "allowEmpty"], claim: "{ value: integer } with `cell`; { days: { \"<rowNumber>\": integer } } with `column` (exactly one of cell, column)", summary: "whole days from a date to the signed asOf date (asOf minus the date)" },
    earliest: { req: ["column", "dateFormats"], opt: [R], claim: "{ value: date in the column's signed format }", summary: "the earliest date of column" },
    latest: { req: ["column", "dateFormats"], opt: [R], claim: "{ value: date in the column's signed format }", summary: "the latest date of column" },
  },
  table: {
    allNumbers: { req: ["column"], opt: [R, "allowEmpty"], summary: "every cell of column reads as a number (a blank is a violation unless allowEmpty)" },
    allDates: { req: ["column", "dateFormats"], opt: [R, "allowEmpty"], summary: "every cell of column reads as a date in the signed format" },
    noEmpty: { req: ["column"], opt: [R], summary: "no blank cell in column" },
    noDuplicates: { req: ["column"], opt: [R], summary: "no value occurs twice in column (blanks ignored)" },
    rowCount: { req: ["n"], opt: [R], summary: "exactly n rows" },
    rowMath: { req: ["fn", "a", "b", "result"], opt: [R, "where", "tolerance", "allowEmpty"], float: true, summary: "on every (matching) row, result = a fn b; b is a column name or { const: number }" },
  },
  diff: {
    onlyColumnsChanged: { req: ["columns"], opt: [], summary: "between before and after (rows aligned by keyColumn) only the listed columns differ; a removed column is always red" },
    untouchedIdentical: { req: [], opt: ["exceptKeys"], summary: "every aligned row is byte-identical in every column, except rows whose key is in exceptKeys; a column added or removed is red" },
    rowsAdded: { req: ["n"], opt: [], summary: "exactly n keys are in after and not in before" },
    rowsDeleted: { req: ["n"], opt: [], summary: "exactly n keys are in before and not in after" },
    newColumnRule: { req: ["fn", "a", "b", "result"], opt: ["where", "tolerance", "allowEmpty"], float: true, summary: "the after table's result column is new or changed and obeys the row-math rule on every (matching) row" },
  },
};
// every op that takes a `where` may use a date condition, which needs the column's signed format
for (const ops of Object.values(OPS)) for (const d of Object.values(ops)) if ([...d.req, ...d.opt].includes("where") && ![...d.req, ...d.opt].includes("dateFormats")) d.opt.push("dateFormats");
const COMMON = { cells: ["table", "claim", "op"], table: ["table", "op"], diff: ["before", "after", "keyColumn", "op"] };
const CMP_NUM = ["gt", "gte", "lt", "lte", "eq", "between"];
const CMP_DATE = ["before", "after", "dateBetween", "dateOn"];
const CMP_ALL = [...CMP_NUM, ...CMP_DATE, "equals", "empty", "notEmpty"];
const FNS = ["add", "sub", "mul", "div", "pct"];

const COL = { type: "string", maxLength: MAX_SIGNED };
/** Field docs for `rubricVocabulary` (one entry per field name; `required` is per op, listed in `ops`). */
export const FIELD_DOCS = {
  table: { type: "name", required: true, maxLength: MAX_NAME, description: "the name of the table the caller passes in opts.tables" },
  claim: { type: "name", required: true, maxLength: MAX_NAME, description: "the output field holding the claim object (shape per op)" },
  before: { type: "name", required: true, maxLength: MAX_NAME, description: "the name of the BEFORE table in opts.tables" },
  after: { type: "name", required: true, maxLength: MAX_NAME, description: "the name of the AFTER table in opts.tables" },
  keyColumn: { ...COL, required: false, description: "diff: REQUIRED, the key column rows are aligned by (blank or repeated keys are red); rows/lookup: the key column" },
  op: { type: "enum", required: true, description: "the operation; the closed list per rule is in `ops`" },
  column: { ...COL, required: false, description: "a column header of the table, exact" },
  groupColumn: { ...COL, required: false, description: "groupTotals: the column whose distinct values are the groups" },
  range: { type: "range", required: false, description: "{ from, to }: integers >= 2, from <= to; only rows with from <= rowNumber <= to are in scope" },
  where: { type: "condition-list", required: false, description: `1-${MAX_CONDS} conditions, ALL must hold (AND only). { column, cmp: ${CMP_ALL.map((c) => JSON.stringify(c)).join(" | ")}, value | lo + hi }. Number cmps (gt gte lt lte eq, between inclusive) take finite numbers; date cmps (before and after strict, dateBetween inclusive, dateOn) take "YYYY-MM-DD" strings and need a dateFormats entry for the column; equals takes an exact string (no trim, no case folding, no wildcard); empty and notEmpty take none. A blank cell never satisfies a number or date condition.` },
  tolerance: { type: "number", required: false, description: "float ops only: absolute tolerance, finite and >= 0; default 0.005 (plus a 1e-9 relative float-noise slack). Counts, row sets, days and uniqueCount are exact and refuse it" },
  allowEmpty: { type: "boolean", required: false, description: "default false: a blank operand (row math, per-row ops) or a blank cell (allNumbers, allDates) is red; true: a blank operand reads as 0 (row math) or is skipped (per-row ops) or is allowed (shape checks)" },
  needle: { type: "string", required: false, maxLength: MAX_SIGNED, description: "found: the signed value to look for" },
  keyValue: { type: "string", required: false, maxLength: MAX_SIGNED, description: "lookup: the signed key value (exact)" },
  valueKind: { type: "enum", required: false, enum: ["text", "number", "date"], description: "found, rows, uniqueCount: text (exact string, default) or number; lookup (required): text, number or date" },
  n: { type: "integer", required: false, min: 0, description: "topN: >= 1; rowCount, rowsAdded, rowsDeleted: >= 0" },
  order: { type: "enum", required: false, enum: ["desc", "asc"], default: "desc", description: "topN direction" },
  ties: { type: "enum", required: false, enum: ["any", "all"], default: "any", description: "topN: any = any valid pick of the tied rows is green; all = every tied row at the cutoff is required" },
  fn: { type: "enum", required: false, enum: FNS, description: "row math: add, sub, mul, div, pct (a as a percent of b)" },
  a: { type: "operand", required: false, description: "row math: the column name of the left operand" },
  b: { type: "operand", required: false, description: "row math: a column name, or { const: finite number }" },
  result: { ...COL, required: false, description: "row math: the column that must hold the result (a blank result is red result-empty)" },
  asOf: { type: "date", required: false, description: 'a signed fixed date "YYYY-MM-DD" (never the clock)' },
  dateFormats: { type: "date-format-list", required: false, description: `[{ column, format }]: the format of every date column the check reads, one entry per column, format one of ${DATE_FORMATS.map((f) => JSON.stringify(f)).join(" | ")}; exactly the date columns the check uses` },
  bands: { type: "band-list", required: false, description: `1-${MAX_BANDS} bands { name, gt | gte, lt | lte } with unique names and no overlap; a row in no band is red no-band` },
  from: { type: "cell", required: false, description: "{ column, row }: a date cell (row >= 2)" },
  to: { type: "cell", required: false, description: "{ column, row }: a date cell (row >= 2)" },
  cell: { type: "cell", required: false, description: "{ column, row }: one date cell (row >= 2)" },
  columns: { type: "string-list", required: false, description: `0-${MAX_KEYS} column headers allowed to change (an empty list = nothing may change)` },
  exceptKeys: { type: "string-list", required: false, description: `0-${MAX_KEYS} key values (of keyColumn) whose rows may differ` },
};
// One worked example per op: the signed check and (cells) the matching step `output` ({ answer: <claim> }), against EXAMPLE_TABLES. Every one runs green
// (test/rubric-cells-gate.test.js), so the vocabulary cannot drift from the code. Key typing to copy: `rows` are integers,
// `value` is a JS number (never "17"), `days` / `bands` are objects with digit-string row keys and number / string values.
const ISO_DUE = [{ column: "Due", format: "YYYY-MM-DD" }];
const BANDS_EX = [{ name: "Current", lte: 0 }, { name: "1-30", gte: 1, lte: 30 }, { name: "31+", gt: 30 }];
const TAX_ROW = { fn: "add", a: "Amount", b: "Tax", result: "Total" };
/** @type {Record<string, Record<string, {check: object, claim?: object}>>} */
const EXAMPLES = {
  cells: {
    count: { check: { column: "Amount" }, claim: { value: 3 } },
    countEmpty: { check: { column: "Tax" }, claim: { value: 1 } },
    countIf: { check: { where: [{ column: "Amount", cmp: "gt", value: 100 }] }, claim: { value: 2 } },
    sum: { check: { column: "Amount" }, claim: { value: 950 } },
    sumIf: { check: { column: "Amount", where: [{ column: "Amount", cmp: "gt", value: 100 }] }, claim: { value: 900 } },
    average: { check: { column: "Amount" }, claim: { value: 316.67 } },
    averageIf: { check: { column: "Amount", where: [{ column: "Amount", cmp: "gt", value: 100 }] }, claim: { value: 450 } },
    median: { check: { column: "Amount" }, claim: { value: 300 } },
    min: { check: { column: "Amount" }, claim: { value: 50 } },
    max: { check: { column: "Amount" }, claim: { value: 600 } },
    found: { check: { column: "Id", needle: "a2" }, claim: { value: true } },
    lookup: { check: { column: "Amount", keyColumn: "Id", keyValue: "a1", valueKind: "number" }, claim: { value: 600 } },
    rows: { check: { where: [{ column: "Amount", cmp: "gt", value: 100 }] }, claim: { rows: [2, 3] } },
    topN: { check: { column: "Amount", n: 1 }, claim: { rows: [2] } },
    uniqueCount: { check: { column: "Cat" }, claim: { value: 2 } },
    duplicates: { check: { column: "Cat" }, claim: { values: ["food"] } },
    groupTotals: { check: { column: "Amount", groupColumn: "Cat" }, claim: { totals: [{ group: "food", total: 650 }, { group: "rent", total: 300 }] } },
    percentOfTotal: { check: { column: "Amount", where: [{ column: "Amount", cmp: "gt", value: 100 }] }, claim: { value: 94.74 } },
    band: { check: { column: "Due", asOf: "2026-10-31", dateFormats: ISO_DUE, bands: BANDS_EX }, claim: { bands: { 2: "1-30", 3: "1-30", 4: "Current" } } },
    daysBetween: { check: { from: { column: "Due", row: 2 }, to: { column: "Due", row: 3 }, dateFormats: ISO_DUE }, claim: { value: 19 } },
    daysSince: { check: { column: "Due", asOf: "2026-10-31", dateFormats: ISO_DUE }, claim: { days: { 2: 30, 3: 11, 4: 0 } } },
    earliest: { check: { column: "Due", dateFormats: ISO_DUE }, claim: { value: "2026-10-01" } },
    latest: { check: { column: "Due", dateFormats: ISO_DUE }, claim: { value: "2026-10-31" } },
  },
  table: {
    allNumbers: { check: { column: "Amount" } },
    allDates: { check: { column: "Due", dateFormats: ISO_DUE } },
    noEmpty: { check: { column: "Id" } },
    noDuplicates: { check: { column: "Id" } },
    rowCount: { check: { n: 3 } },
    rowMath: { check: { ...TAX_ROW, allowEmpty: true } },
  },
  diff: {
    onlyColumnsChanged: { check: { columns: ["Tax", "Total"] } },
    untouchedIdentical: { check: { exceptKeys: ["a2"] } },
    rowsAdded: { check: { n: 0 } },
    rowsDeleted: { check: { n: 0 } },
    newColumnRule: { check: { ...TAX_ROW } },
  },
};
const EX_HEADER = ["Id", "Amount", "Tax", "Due", "Cat", "Total"];
/** The tiny tables every example runs against: `t` (signed as the table / the diff's before) and `a` (a diff's after, unsigned). */
export const EXAMPLE_TABLES = {
  t: { header: EX_HEADER, rows: [
    { rowNumber: 2, cells: ["a1", "600", "60", "2026-10-01", "food", "660"] },
    { rowNumber: 3, cells: ["a2", "300", "", "2026-10-20", "rent", "300"] },
    { rowNumber: 4, cells: ["a3", "50", "5", "2026-10-31", "food", "55"] },
  ] },
  a: { header: EX_HEADER, rows: [
    { rowNumber: 2, cells: ["a1", "600", "60", "2026-10-01", "food", "660"] },
    { rowNumber: 3, cells: ["a2", "300", "30", "2026-10-20", "rent", "330"] },
    { rowNumber: 4, cells: ["a3", "50", "5", "2026-10-31", "food", "55"] },
  ] },
};
function example(rule, op) {
  const e = EXAMPLES[rule][op];
  const base = rule === "cells" ? { table: "t", claim: "answer" } : rule === "table" ? { table: "t" } : { before: "t", after: "a", keyColumn: "Id" };
  // `output` is the FULL step output a cells check reads: the claim sits under the signed `claim` field name ("answer")
  return { check: { id: `ex-${op}`, rule, ...base, op, ...e.check }, ...(e.claim ? { output: { answer: e.claim } } : {}) };
}

export const VOCAB_OPS = Object.fromEntries(
  Object.entries(OPS).map(([rule, ops]) => [
    rule,
    Object.fromEntries(Object.entries(ops).map(([op, d]) => [op, { summary: d.summary, requires: d.req, allows: d.opt, ...(d.claim ? { claim: d.claim } : {}), example: example(rule, op) }])),
  ]),
);
/** The field names a rule accepts (for the unknown-field refusal and the rule table). */
export function ruleFieldNames(rule) {
  const s = new Set(COMMON[rule]);
  for (const d of Object.values(OPS[rule])) for (const k of [...d.req, ...d.opt]) s.add(k);
  return [...s];
}
export const CELLS_RULES = Object.freeze(Object.keys(OPS));

// --- validating the SIGNED check (createRubric refuses; at runtime an Invalid = stopped check-invalid) ---

const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function onlyKeys(o, allowed, path) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Invalid(path ? `${path}.${k}` : k, "is not a recognised field");
}
function nameStr(v, path, max = MAX_SIGNED) {
  if (typeof v !== "string" || v.trim() === "") throw new Invalid(path, "must be a non-blank string");
  if (v.length > max) throw new Invalid(path, `must be at most ${max} characters`);
}
function finite(v, path) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Invalid(path, "must be a finite number");
}
function isoDate(v, path) {
  if (typeof v !== "string" || readIso(v) === null) throw new Invalid(path, 'must be one real date string "YYYY-MM-DD"');
}
function cellAddr(v, path) {
  if (!plain(v)) throw new Invalid(path, "must be { column, row }");
  onlyKeys(v, ["column", "row"], path);
  nameStr(v.column, `${path}.column`);
  if (!isInt(v.row) || v.row < 2) throw new Invalid(`${path}.row`, "must be an integer >= 2");
}
function stringList(v, path, minItems) {
  if (!Array.isArray(v) || v.length < minItems || v.length > MAX_KEYS) throw new Invalid(path, `must be a list of ${minItems}-${MAX_KEYS} strings`);
  v.forEach((s, i) => nameStr(s, `${path}[${i}]`));
  if (new Set(v).size !== v.length) throw new Invalid(path, "must not contain duplicates");
}
/** The number columns a `where` reads as dates (cmp before/after/dateBetween/dateOn). */
function condDateColumns(where) {
  return Array.isArray(where) ? where.filter((c) => CMP_DATE.includes(c.cmp)).map((c) => c.column) : [];
}
function checkConds(v, path) {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_CONDS) throw new Invalid(path, `must be a list of 1-${MAX_CONDS} conditions`);
  v.forEach((c, i) => {
    const p = `${path}[${i}]`;
    if (!plain(c)) throw new Invalid(p, "must be an object");
    if (!CMP_ALL.includes(c.cmp)) throw new Invalid(`${p}.cmp`, `must be one of ${CMP_ALL.map((x) => JSON.stringify(x)).join(", ")}`);
    nameStr(c.column, `${p}.column`);
    const between = c.cmp === "between" || c.cmp === "dateBetween";
    const valued = !between && c.cmp !== "empty" && c.cmp !== "notEmpty";
    onlyKeys(c, ["column", "cmp", ...(between ? ["lo", "hi"] : valued ? ["value"] : [])], p);
    const chk = CMP_NUM.includes(c.cmp) ? finite : CMP_DATE.includes(c.cmp) ? isoDate : (x, q) => nameStr(x, q);
    if (between) {
      chk(c.lo, `${p}.lo`);
      chk(c.hi, `${p}.hi`);
      const [lo, hi] = c.cmp === "between" ? [c.lo, c.hi] : [readIso(c.lo), readIso(c.hi)];
      if (lo > hi) throw new Invalid(`${p}.lo`, "must be <= hi");
    } else if (valued) chk(c.value, `${p}.value`);
  });
}
function checkBands(v, path) {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_BANDS) throw new Invalid(path, `must be a list of 1-${MAX_BANDS} bands`);
  const iv = v.map((b, i) => {
    const p = `${path}[${i}]`;
    if (!plain(b)) throw new Invalid(p, "must be an object");
    onlyKeys(b, ["name", "gt", "gte", "lt", "lte"], p);
    nameStr(b.name, `${p}.name`, MAX_NAME);
    for (const k of ["gt", "gte", "lt", "lte"]) if (b[k] !== undefined) finite(b[k], `${p}.${k}`);
    if (b.gt !== undefined && b.gte !== undefined) throw new Invalid(p, "takes at most one lower bound (gt or gte)");
    if (b.lt !== undefined && b.lte !== undefined) throw new Invalid(p, "takes at most one upper bound (lt or lte)");
    const lo = b.gt !== undefined ? { v: b.gt, inc: false } : b.gte !== undefined ? { v: b.gte, inc: true } : { v: -Infinity, inc: false };
    const hi = b.lt !== undefined ? { v: b.lt, inc: false } : b.lte !== undefined ? { v: b.lte, inc: true } : { v: Infinity, inc: false };
    if (lo.v > hi.v || (lo.v === hi.v && !(lo.inc && hi.inc))) throw new Invalid(p, "is an empty band");
    return { lo, hi };
  });
  if (new Set(v.map((b) => b.name)).size !== v.length) throw new Invalid(path, "band names must be unique");
  const overlap = (a, b) => {
    const lo = a.lo.v > b.lo.v || (a.lo.v === b.lo.v && !a.lo.inc) ? a.lo : b.lo; // the tighter lower bound
    const hi = a.hi.v < b.hi.v || (a.hi.v === b.hi.v && !a.hi.inc) ? a.hi : b.hi;
    return lo.v < hi.v || (lo.v === hi.v && lo.inc && hi.inc);
  };
  for (let i = 0; i < iv.length; i++) for (let j = i + 1; j < iv.length; j++) if (overlap(iv[i], iv[j])) throw new Invalid(path, `bands ${i} and ${j} overlap`);
}
function checkOperand(v, path, allowConst) {
  if (allowConst && plain(v)) {
    onlyKeys(v, ["const"], path);
    return finite(v.const, `${path}.const`);
  }
  nameStr(v, path);
}
function checkDateFormats(v, path) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 50) throw new Invalid(path, "must be a list of 1-50 { column, format }");
  v.forEach((e, i) => {
    const p = `${path}[${i}]`;
    if (!plain(e)) throw new Invalid(p, "must be { column, format }");
    onlyKeys(e, ["column", "format"], p);
    nameStr(e.column, `${p}.column`);
    if (!DATE_FORMATS.includes(e.format)) throw new Invalid(`${p}.format`, `must be one of ${DATE_FORMATS.map((f) => JSON.stringify(f)).join(", ")}`);
  });
  if (new Set(v.map((e) => e.column)).size !== v.length) throw new Invalid(path, "must hold one entry per column");
}

/**
 * Validate a signed cells/table/diff check. Throws Invalid(path, msg). Pure; reads only own data of a plain object.
 * @param {"cells"|"table"|"diff"} rule @param {any} c
 */
export function validateSigned(rule, c) {
  if (!plain(c)) throw new Invalid("", "must be an object");
  const ops = OPS[rule];
  if (typeof c.op !== "string" || !Object.hasOwn(ops, c.op)) throw new Invalid("op", `must be one of ${Object.keys(ops).map((o) => JSON.stringify(o)).join(", ")}`);
  const def = ops[c.op];
  const op = c.op;
  onlyKeys(c, ["id", "rule", "text", ...COMMON[rule], ...def.req, ...def.opt], "");
  for (const k of COMMON[rule]) if (k !== "op" && c[k] === undefined) throw new Invalid(k, `is required for ${rule}`);
  for (const k of def.req) if (c[k] === undefined) throw new Invalid(k, `is required for ${rule} op ${op}`);
  for (const k of ["table", "claim", "before", "after"]) if (COMMON[rule].includes(k)) nameStr(c[k], k, MAX_NAME);
  if (rule === "diff") {
    nameStr(c.keyColumn, "keyColumn");
    if (c.before === c.after) throw new Invalid("after", "must name a different table than before");
  }
  for (const k of ["column", "groupColumn", "result", "needle", "keyValue"]) if (c[k] !== undefined) nameStr(c[k], k);
  if (rule !== "diff" && c.keyColumn !== undefined) nameStr(c.keyColumn, "keyColumn");
  if (c.range !== undefined) {
    if (!plain(c.range)) throw new Invalid("range", "must be { from, to }");
    onlyKeys(c.range, ["from", "to"], "range");
    if (!isInt(c.range.from) || c.range.from < 2) throw new Invalid("range.from", "must be an integer >= 2");
    if (!isInt(c.range.to) || c.range.to < c.range.from) throw new Invalid("range.to", "must be an integer >= from");
  }
  if (c.where !== undefined) checkConds(c.where, "where");
  if (c.tolerance !== undefined) {
    if (!def.float) throw new Invalid("tolerance", `is refused on op ${op}: counts, row sets, days and uniqueCount are exact`);
    if (typeof c.tolerance !== "number" || !Number.isFinite(c.tolerance) || c.tolerance < 0) throw new Invalid("tolerance", "must be a finite number >= 0");
  }
  if (c.tolerance !== undefined && op === "lookup" && c.valueKind !== "number") throw new Invalid("tolerance", "applies only to lookup with valueKind number");
  if (c.allowEmpty !== undefined && typeof c.allowEmpty !== "boolean") throw new Invalid("allowEmpty", "must be a boolean");
  if (c.valueKind !== undefined) {
    const allowed = op === "lookup" ? ["text", "number", "date"] : ["text", "number"];
    if (!allowed.includes(c.valueKind)) throw new Invalid("valueKind", `must be one of ${allowed.map((x) => JSON.stringify(x)).join(", ")} for op ${op}`);
  }
  if (c.n !== undefined) {
    const min = op === "topN" ? 1 : 0;
    if (!isInt(c.n) || c.n < min) throw new Invalid("n", `must be an integer >= ${min}`);
  }
  /** @type {[string, string[]][]} */
  const enums = [["order", ["desc", "asc"]], ["ties", ["any", "all"]], ["fn", FNS]];
  for (const [k, vals] of enums) {
    if (c[k] !== undefined && !vals.includes(c[k])) throw new Invalid(k, `must be one of ${vals.map((x) => JSON.stringify(x)).join(", ")}`);
  }
  if (c.asOf !== undefined) isoDate(c.asOf, "asOf");
  if (c.bands !== undefined) checkBands(c.bands, "bands");
  if (c.a !== undefined) checkOperand(c.a, "a", false);
  if (c.b !== undefined) checkOperand(c.b, "b", true);
  for (const k of ["from", "to", "cell"]) if (c[k] !== undefined) cellAddr(c[k], k);
  if (c.dateFormats !== undefined) checkDateFormats(c.dateFormats, "dateFormats");
  if (c.columns !== undefined) stringList(c.columns, "columns", 0);
  if (c.exceptKeys !== undefined) stringList(c.exceptKeys, "exceptKeys", 0);
  if (c.text !== undefined && typeof c.text !== "string") throw new Invalid("text", "must be a string (the signer's explanation)");

  // op-specific conditions
  if (op === "found" && c.valueKind === "number" && readCellNumber(c.needle) === null) throw new Invalid("needle", "must read as a number when valueKind is number");
  if (op === "rows" && c.valueKind !== undefined && c.keyColumn === undefined) throw new Invalid("valueKind", "applies to the keys form: sign a keyColumn");
  if (op === "daysSince") {
    if ((c.cell === undefined) === (c.column === undefined)) throw new Invalid("cell", "daysSince needs exactly one of cell, column");
    if (c.cell !== undefined && (c.where !== undefined || c.range !== undefined || c.allowEmpty !== undefined)) throw new Invalid("cell", "a single-cell daysSince refuses where, range and allowEmpty");
  }
  if (op === "band" && c.asOf !== undefined && c.dateFormats === undefined) throw new Invalid("dateFormats", "is required with asOf (the column is then a date column)");
  if (op === "band" && c.asOf === undefined && c.dateFormats !== undefined && condDateColumns(c.where).length === 0) throw new Invalid("dateFormats", "applies only with asOf or a date condition");
  if (op === "rowMath" || op === "newColumnRule") {
    if (typeof c.a !== "string") throw new Invalid("a", "must be a column name");
  }
  // every date column the check reads needs exactly one dateFormats entry, and every entry must be used
  const used = new Set(condDateColumns(c.where));
  if (op === "earliest" || op === "latest" || op === "allDates") used.add(c.column);
  if (op === "lookup" && c.valueKind === "date") used.add(c.column);
  if (op === "band" && c.asOf !== undefined) used.add(c.column);
  if (op === "daysSince") used.add(c.cell !== undefined ? c.cell.column : c.column);
  if (op === "daysBetween") {
    used.add(c.from.column);
    used.add(c.to.column);
  }
  const have = new Set((c.dateFormats ?? []).map((e) => e.column));
  for (const col of used) if (!have.has(col)) throw new Invalid("dateFormats", `has no entry for date column ${JSON.stringify(col.length > 60 ? `${col.slice(0, 60)}...` : col)}`);
  for (const col of have) if (!used.has(col)) throw new Invalid("dateFormats", `has an entry for column ${JSON.stringify(col.length > 60 ? `${col.slice(0, 60)}...` : col)}, which the check does not read as a date`);
}

/**
 * The draft-time refusal of a signed cells/table/diff check: null when valid, else `{ path, message }` (path relative to the check).
 * @param {"cells"|"table"|"diff"} rule @param {any} c
 */
export function signedProblem(rule, c) {
  try {
    validateSigned(rule, c);
    return null;
  } catch (e) {
    if (e instanceof Invalid) return { path: e.path, message: e.message };
    return { path: "", message: "could not be read" };
  }
}

// --- tables ------------------------------------------------------------------

/**
 * Copy a caller table ONCE into a plain frozen-shape snapshot (a hostile getter, Proxy or later mutation cannot change what
 * the check reads). Structural trouble = Stop table-invalid; over the size caps = Big (red).
 * @returns {{header: string[], rows: {rowNumber:number, cells:string[]}[], byRow: Map<number, any>}}
 */
export function snapshotTable(raw, name) {
  try {
    if (!plain(raw)) throw new Stop("table-invalid", `table ${clip(name)} is missing or not an object`);
    const header = raw.header;
    const rows = raw.rows;
    if (!Array.isArray(header) || !Array.isArray(rows)) throw new Stop("table-invalid", `table ${clip(name)} needs header and rows arrays`);
    const hl = header.length;
    const rl = rows.length;
    if (hl === 0) throw new Stop("table-invalid", `table ${clip(name)} has no header`);
    if (hl > TABLE_MAX_CELLS || hl * rl > TABLE_MAX_CELLS) throw new Big(hl * rl, TABLE_MAX_CELLS, "cells");
    let chars = 0;
    const h = new Array(hl);
    for (let i = 0; i < hl; i++) {
      const s = header[i];
      if (typeof s !== "string") throw new Stop("table-invalid", `table ${clip(name)}: header ${i} is not a string`);
      chars += s.length;
      h[i] = s;
    }
    if (new Set(h).size !== hl) throw new Stop("table-invalid", `table ${clip(name)} has a duplicate header`);
    const out = new Array(rl);
    const byRow = new Map();
    let last = 1;
    for (let r = 0; r < rl; r++) {
      const row = rows[r];
      if (!plain(row)) throw new Stop("table-invalid", `table ${clip(name)}: row ${r} is not an object`);
      const rn = row.rowNumber;
      const cs = row.cells;
      if (!isInt(rn) || rn < 2 || rn <= last) throw new Stop("table-invalid", `table ${clip(name)}: row ${r} rowNumber must be an integer >= 2, strictly increasing`);
      if (!Array.isArray(cs) || cs.length !== hl) throw new Stop("table-invalid", `table ${clip(name)}: row ${rn} is ragged (needs ${hl} cells)`);
      const cells = new Array(hl);
      for (let i = 0; i < hl; i++) {
        const s = cs[i];
        if (typeof s !== "string") throw new Stop("table-invalid", `table ${clip(name)}: row ${rn} cell ${i} is not a string`);
        chars += s.length;
        cells[i] = s;
      }
      if (chars > TABLE_MAX_CHARS) throw new Big(chars, TABLE_MAX_CHARS, "chars");
      last = rn;
      const e = { rowNumber: rn, cells };
      out[r] = e;
      byRow.set(rn, e);
    }
    return { header: h, rows: out, byRow };
  } catch (e) {
    if (e instanceof Stop || e instanceof Big) throw e;
    throw new Stop("table-invalid", `table ${clip(name)} is unreadable`);
  }
}

function clip(s, n = CLIP) {
  const t = typeof s === "string" ? s : String(s);
  return t.length > n ? `${t.slice(0, n)}...` : t;
}
function colIdx(t, name) {
  const i = t.header.indexOf(name);
  if (i < 0) throw new Stop("check-invalid", `column ${JSON.stringify(clip(name))} is not in the table`);
  return i;
}
const own = (o, k) => (o !== null && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : undefined);

// --- run context -------------------------------------------------------------

function mkCtx() {
  return { gaps: /** @type {any[]} */ ([]), unreadable: new Set(), expected: null };
}
const UNREAD_KEEP = 100_000; // unreadable cells remembered per check (the gap shows 20; past this itemsTotal is a floor)
function unread(ctx, cell) {
  if (ctx.unreadable.size < UNREAD_KEEP) ctx.unreadable.add(cell);
}
function gap(ctx, kind, items, more = {}) {
  /** @type {any} */
  const g = { kind, ...more };
  if (items !== undefined) {
    const arr = items.map((x) => (typeof x === "string" ? x : String(x)));
    g.items = arr.slice(0, ITEMS);
    if (arr.length > ITEMS) g.itemsTotal = arr.length;
  }
  ctx.gaps.push(g);
}
function expect(ctx, key, v) {
  (ctx.expected ??= {})[key] = v;
}
function expectRows(ctx, key, rows) {
  expect(ctx, key, rows.slice(0, EXPECTED_ROWS));
  if (rows.length > EXPECTED_ROWS) expect(ctx, `${key}Total`, rows.length);
}

// --- conditions (AND only) -------------------------------------------------------

function fmtOf(plan, column) {
  const e = (plan.dateFormats ?? []).find((x) => x.column === column);
  if (!e) throw new Stop("check-invalid", `no dateFormats entry for column ${JSON.stringify(clip(column))}`);
  return e.format;
}
function compileConds(t, plan) {
  return (plan.where ?? []).map((c) => {
    const o = { i: colIdx(t, c.column), cmp: c.cmp, col: c.column, value: c.value, lo: c.lo, hi: c.hi };
    if (CMP_DATE.includes(c.cmp)) {
      o.fmt = fmtOf(plan, c.column);
      if (c.cmp === "dateBetween") { o.lo = readIso(c.lo); o.hi = readIso(c.hi); } else o.value = readIso(c.value);
    }
    return o;
  });
}
function matchRow(row, conds, ctx) {
  for (const c of conds) {
    const s = row.cells[c.i];
    let ok;
    if (c.cmp === "empty") ok = isBlank(s);
    else if (c.cmp === "notEmpty") ok = !isBlank(s);
    else if (c.cmp === "equals") ok = s === c.value; // exact: no trim, no case folding, no wildcards
    else if (isBlank(s)) ok = false; // a blank never satisfies a number or date condition
    else if (CMP_NUM.includes(c.cmp)) {
      const n = readCellNumber(s);
      if (n === null) { unread(ctx, `${row.rowNumber}:${c.col}`); ok = false; }
      else ok = c.cmp === "gt" ? n > c.value : c.cmp === "gte" ? n >= c.value : c.cmp === "lt" ? n < c.value : c.cmp === "lte" ? n <= c.value : c.cmp === "eq" ? n === c.value : n >= c.lo && n <= c.hi;
    } else {
      const d = readCellDate(s, c.fmt);
      if (d === null) { unread(ctx, `${row.rowNumber}:${c.col}`); ok = false; }
      else ok = c.cmp === "before" ? d < c.value : c.cmp === "after" ? d > c.value : c.cmp === "dateOn" ? d === c.value : d >= c.lo && d <= c.hi;
    }
    if (!ok) return false;
  }
  return true;
}
function scoped(t, plan) {
  const r = plan.range;
  return r === undefined ? t.rows : t.rows.filter((x) => x.rowNumber >= r.from && x.rowNumber <= r.to);
}
/** Non-blank numbers of column over rows; a non-blank non-number is recorded as unreadable (red). */
function numbers(rows, i, col, ctx) {
  const out = [];
  for (const r of rows) {
    const s = r.cells[i];
    if (isBlank(s)) continue;
    const v = readCellNumber(s);
    if (v === null) unread(ctx, `${r.rowNumber}:${col}`);
    else out.push({ row: r.rowNumber, v });
  }
  return out;
}
const sumOf = (a) => {
  let s = 0;
  for (const x of a) s += x;
  return s;
};

// --- tolerance -----------------------------------------------------------------

const tolOf = (plan, def) => (def.float ? (plan.tolerance ?? MONEY_TOL) : 0);
const close = (a, b, tol, float) => (float ? Math.abs(a - b) <= tol + FLOAT_SLACK * Math.max(1, Math.abs(a), Math.abs(b)) : a === b);

// --- claim reading: ANY throw while touching the claim is red (Law 1) ---------------

const BADV = Symbol("bad");
const prim = (v) => (typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : BADV);
function copyList(v, k) {
  if (!Array.isArray(v)) throw new Bad("claim-malformed", k);
  const len = v.length;
  if (len > CLAIM_MAX) throw new Bad("claim-too-large", k);
  const out = new Array(len);
  for (let j = 0; j < len; j++) out[j] = prim(v[j]);
  return out;
}
function copyPairs(v, k) {
  if (!Array.isArray(v)) throw new Bad("claim-malformed", k);
  const len = v.length;
  if (len > CLAIM_MAX) throw new Bad("claim-too-large", k);
  const out = new Array(len);
  for (let j = 0; j < len; j++) {
    const e = v[j];
    out[j] = plain(e) ? { group: prim(own(e, "group")), total: prim(own(e, "total")) } : { group: BADV, total: BADV };
  }
  return out;
}
const ROW_KEY = /^[1-9][0-9]*$/;
function copyRowMap(v, k) {
  if (!plain(v)) throw new Bad("claim-malformed", k);
  const keys = Object.keys(v);
  if (keys.length > CLAIM_MAX) throw new Bad("claim-too-large", k);
  const out = new Map();
  for (const key of keys) {
    if (!ROW_KEY.test(key)) throw new Bad("claim-malformed", k);
    out.set(+key, prim(v[key]));
  }
  return out;
}
const CLAIM_KEYS = { value: "p", rows: "list", keys: "list", values: "list", totals: "pairs", days: "map", bands: "map" };

function readClaim(raw, keys, field) {
  if (raw.missing) throw new Bad("claim-missing", field);
  if (raw.unreadable) throw new Bad("claim-unreadable", field);
  try {
    const v = raw.value;
    if (!plain(v)) throw new Bad("claim-malformed", field);
    const out = Object.create(null);
    for (const k of keys) {
      const x = own(v, k);
      if (x === undefined) continue;
      const kind = CLAIM_KEYS[k];
      out[k] = kind === "p" ? prim(x) : kind === "list" ? copyList(x, k) : kind === "pairs" ? copyPairs(x, k) : copyRowMap(x, k);
    }
    return out;
  } catch (e) {
    throw e instanceof Bad ? e : new Bad("claim-unreadable", field);
  }
}
function need(claim, k) {
  if (claim[k] === undefined) throw new Bad("claim-missing", k);
  return claim[k];
}
// STRICT claim types (hamr 2026-10-22, strict for spreadsheets): a claimed number is a finite JS number, never a numeric string
// ({value: "17"} is red claim-malformed). Text claims are strings, date claims are strings in the column's format, row lists are
// integers, row-keyed map keys are digit strings (JSON object keys) and their values are numbers (days) or strings (bands).
function claimNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new Bad("claim-malformed", "number");
}
function claimRowList(list, k) {
  for (const r of list) if (!isInt(r) || r < 2) throw new Bad("claim-malformed", k);
  return list;
}

// --- comparisons that fill gaps ----------------------------------------------------

function compareScalar(ctx, claimed, actual, tol, float) {
  expect(ctx, "value", actual);
  if (!close(claimed, actual, tol, float)) gap(ctx, "value-mismatch", undefined, { measured: claimed });
}
function compareRowSets(ctx, claimedRows, trueRows) {
  const seen = new Set();
  const dup = [];
  for (const r of claimedRows) {
    if (seen.has(r)) dup.push(r);
    seen.add(r);
  }
  const truth = new Set(trueRows);
  const missing = trueRows.filter((r) => !seen.has(r));
  const extra = [...seen].filter((r) => !truth.has(r));
  if (missing.length) gap(ctx, "rows-missing", missing);
  if (extra.length) gap(ctx, "rows-extra", extra);
  if (dup.length) gap(ctx, "rows-duplicated", dup);
}

// --- the cells ops ---------------------------------------------------------------------

function runCells(plan, env, ctx) {
  const t = env.table(plan.table);
  const op = plan.op;
  const def = OPS.cells[op];
  const claimOf = (keys) => readClaim(env.claim(), keys, plan.claim);
  const col = () => colIdx(t, plan.column);
  const rows = scoped(t, plan);
  const tol = tolOf(plan, def);
  const scalar = (claim) => claimNumber(need(claim, "value"));
  const matched = (conds) => rows.filter((r) => matchRow(r, conds, ctx));

  switch (op) {
    case "count": case "countEmpty": {
      const i = col();
      const claim = claimOf(["value"]);
      const a = rows.filter((r) => isBlank(r.cells[i]) === (op === "countEmpty")).length;
      compareScalar(ctx, scalar(claim), a, 0, false);
      return;
    }
    case "countIf": {
      const conds = compileConds(t, plan);
      const claim = claimOf(["value"]);
      compareScalar(ctx, scalar(claim), matched(conds).length, 0, false);
      return;
    }
    case "sum": case "sumIf": case "average": case "averageIf": case "median": case "min": case "max": {
      const i = col();
      const conds = compileConds(t, plan);
      const claim = claimOf(["value"]);
      const vs = numbers(conds.length ? matched(conds) : rows, i, plan.column, ctx).map((x) => x.v);
      const c = scalar(claim);
      if (op === "sum" || op === "sumIf") return compareScalar(ctx, c, sumOf(vs), tol, true);
      if (!vs.length) return gap(ctx, "no-values");
      let a;
      if (op === "average" || op === "averageIf") a = sumOf(vs) / vs.length;
      else if (op === "min") a = vs.reduce((x, y) => (y < x ? y : x));
      else if (op === "max") a = vs.reduce((x, y) => (y > x ? y : x));
      else {
        const s = Float64Array.from(vs).sort();
        a = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
      }
      return compareScalar(ctx, c, a, tol, true);
    }
    case "found": {
      const i = col();
      const claim = claimOf(["value"]);
      const kind = plan.valueKind ?? "text";
      const want = kind === "number" ? readCellNumber(plan.needle) : null;
      let hit = false;
      for (const r of rows) {
        const s = r.cells[i];
        if (kind === "number" ? readCellNumber(s) === want : s === plan.needle) { hit = true; break; }
      }
      const c = need(claim, "value");
      if (typeof c !== "boolean") throw new Bad("claim-malformed", "value");
      expect(ctx, "value", hit);
      if (c !== hit) gap(ctx, "value-mismatch", undefined, { measured: String(c) });
      return;
    }
    case "lookup": {
      const i = col();
      const k = colIdx(t, plan.keyColumn);
      const kind = plan.valueKind;
      const fmt = kind === "date" ? fmtOf(plan, plan.column) : null;
      const claim = claimOf(["value"]);
      const hits = rows.filter((r) => r.cells[k] === plan.keyValue);
      if (hits.length !== 1) return gap(ctx, "lookup-not-unique", undefined, { measured: hits.length });
      const cell = hits[0].cells[i];
      const c = need(claim, "value");
      if (kind === "number") {
        const n = readCellNumber(cell);
        if (n === null) return gap(ctx, "lookup-unreadable", [hits[0].rowNumber]);
        return compareScalar(ctx, claimNumber(c), n, tol, true);
      }
      if (kind === "date") {
        const d = readCellDate(cell, fmt);
        if (d === null) return gap(ctx, "lookup-unreadable", [hits[0].rowNumber]);
        const cd = readCellDate(c, fmt);
        if (cd === null) throw new Bad("claim-malformed", "date");
        expect(ctx, "value", cell);
        if (cd !== d) gap(ctx, "value-mismatch", undefined, { measured: clip(String(c)) });
        return;
      }
      if (typeof c !== "string") throw new Bad("claim-malformed", "value");
      expect(ctx, "value", cell);
      if (c !== cell) gap(ctx, "value-mismatch", undefined, { measured: clip(c) });
      return;
    }
    case "rows": {
      const conds = compileConds(t, plan);
      const kcol = plan.keyColumn !== undefined ? colIdx(t, plan.keyColumn) : -1;
      const claim = claimOf(["rows", "keys"]);
      const trueRows = matched(conds);
      const nums = trueRows.map((r) => r.rowNumber);
      expectRows(ctx, "rows", nums);
      if (claim.rows !== undefined) return compareRowSets(ctx, claimRowList(claim.rows, "rows"), nums);
      if (claim.keys === undefined) throw new Bad("claim-missing", "rows|keys");
      if (kcol < 0) throw new Bad("claim-malformed", "keys");
      const number = plan.valueKind === "number";
      const pool = new Map(); // key -> count among the true rows
      const poolRows = new Map();
      for (const r of trueRows) {
        const s = r.cells[kcol];
        const key = number ? readCellNumber(s) : s;
        if (key === null) { unread(ctx, `${r.rowNumber}:${plan.keyColumn}`); continue; }
        pool.set(key, (pool.get(key) ?? 0) + 1);
        (poolRows.get(key) ?? poolRows.set(key, []).get(key)).push(r.rowNumber);
      }
      const extra = [];
      for (const k of claim.keys) {
        const key = number ? claimNumber(k) : k;
        if (!number && typeof key !== "string") throw new Bad("claim-malformed", "keys");
        const n = pool.get(key) ?? 0;
        if (n > 0) pool.set(key, n - 1);
        else extra.push(clip(String(key)));
      }
      const missing = [];
      for (const [key, n] of pool) {
        if (n <= 0) continue;
        const rs = poolRows.get(key);
        for (let j = rs.length - n; j < rs.length; j++) missing.push(rs[j]);
      }
      missing.sort((a, b) => a - b);
      if (missing.length) gap(ctx, "rows-missing", missing);
      if (extra.length) gap(ctx, "keys-extra", extra);
      return;
    }
    case "topN": {
      const i = col();
      const conds = compileConds(t, plan);
      const n = plan.n;
      const order = plan.order ?? "desc";
      const ties = plan.ties ?? "any";
      const claim = claimOf(["rows", "values"]);
      const vs = numbers(conds.length ? matched(conds) : rows, i, plan.column, ctx);
      vs.sort((a, b) => (order === "desc" ? b.v - a.v : a.v - b.v));
      if (vs.length < n) return gap(ctx, "fewer-than-n", undefined, { measured: vs.length });
      const cut = vs[n - 1].v;
      const better = vs.filter((x) => (order === "desc" ? x.v > cut : x.v < cut)).map((x) => x.row);
      const tied = vs.filter((x) => x.v === cut).map((x) => x.row);
      const need2 = n - better.length; // how many of the tied pool belong
      expectRows(ctx, "rows", better);
      expect(ctx, "tied", tied.length > need2 ? { rows: tied.slice(0, EXPECTED_ROWS), take: need2 } : null);
      if (claim.values !== undefined) {
        const cv = claim.values.map(claimNumber).sort((a, b) => (order === "desc" ? b - a : a - b));
        const tv = vs.slice(0, n).map((x) => x.v);
        if (cv.length !== n || cv.some((x, j) => !close(x, tv[j], tol, true))) gap(ctx, "topn-values-mismatch", undefined, { measured: cv.length, limit: n });
        return;
      }
      if (claim.rows === undefined) throw new Bad("claim-missing", "rows|values");
      const cr = claimRowList(claim.rows, "rows");
      const S = new Set(cr);
      const B = new Set(better);
      const T = new Set(tied);
      if (S.size !== cr.length) {
        const seenRows = new Set();
        const dupRows = [];
        for (const r of cr) {
          if (seenRows.has(r)) dupRows.push(r);
          seenRows.add(r);
        }
        gap(ctx, "rows-duplicated", dupRows);
      }
      const miss = better.filter((r) => !S.has(r));
      const other = [...S].filter((r) => !B.has(r) && !T.has(r));
      const tiedIn = tied.filter((r) => S.has(r));
      if (miss.length) gap(ctx, "rows-missing", miss);
      if (other.length) gap(ctx, "rows-extra", other);
      if (ties === "all") {
        const mt = tied.filter((r) => !S.has(r));
        if (mt.length) gap(ctx, "tied-rows-missing", mt);
      } else if (tiedIn.length < need2) gap(ctx, "tied-rows-missing", undefined, { measured: tiedIn.length, limit: need2 });
      else if (tiedIn.length > need2) gap(ctx, "rows-extra", tiedIn.slice(need2));
      return;
    }
    case "uniqueCount": {
      const i = col();
      const claim = claimOf(["value"]);
      const number = plan.valueKind === "number";
      const set = new Set();
      for (const r of rows) {
        const s = r.cells[i];
        if (isBlank(s)) continue;
        if (number) {
          const n = readCellNumber(s);
          if (n === null) unread(ctx, `${r.rowNumber}:${plan.column}`);
          else set.add(n);
        } else set.add(s);
      }
      compareScalar(ctx, scalar(claim), set.size, 0, false);
      return;
    }
    case "duplicates": {
      const i = col();
      const claim = claimOf(["values", "rows"]);
      const m = new Map();
      for (const r of rows) {
        const s = r.cells[i];
        if (isBlank(s)) continue;
        (m.get(s) ?? m.set(s, []).get(s)).push(r.rowNumber);
      }
      const groups = [...m].filter(([, rs]) => rs.length > 1);
      if (claim.values === undefined && claim.rows === undefined) throw new Bad("claim-missing", "values|rows");
      if (claim.values !== undefined) {
        if (claim.values.some((v) => typeof v !== "string")) throw new Bad("claim-malformed", "values");
        const T = new Set(groups.map(([v]) => v));
        const C = new Set(claim.values);
        const miss = [...T].filter((v) => !C.has(v));
        const ex = [...C].filter((v) => !T.has(v));
        if (miss.length) gap(ctx, "values-missing", miss.map((v) => clip(v)));
        if (ex.length) gap(ctx, "values-extra", ex.map((v) => clip(v)));
        expect(ctx, "values", groups.map(([v]) => v).slice(0, EXPECTED_ROWS));
      }
      if (claim.rows !== undefined) {
        const all = groups.flatMap(([, rs]) => rs).sort((a, b) => a - b);
        expectRows(ctx, "rows", all);
        compareRowSets(ctx, claimRowList(claim.rows, "rows"), all);
      }
      return;
    }
    case "groupTotals": {
      const i = col();
      const g = colIdx(t, plan.groupColumn);
      const conds = compileConds(t, plan);
      const claim = claimOf(["totals"]);
      const base = conds.length ? matched(conds) : rows;
      const tot = new Map();
      for (const r of base) {
        const s = r.cells[i];
        if (isBlank(s)) continue;
        const n = readCellNumber(s);
        if (n === null) { unread(ctx, `${r.rowNumber}:${plan.column}`); continue; }
        const key = r.cells[g];
        tot.set(key, (tot.get(key) ?? 0) + n);
      }
      expect(ctx, "totals", [...tot].slice(0, EXPECTED_ROWS).map(([group, total]) => ({ group, total })));
      const ct = new Map();
      const dups = [];
      for (const e of need(claim, "totals")) {
        if (typeof e.group !== "string") throw new Bad("claim-malformed", "totals");
        const total = claimNumber(e.total);
        if (ct.has(e.group)) dups.push(clip(e.group));
        ct.set(e.group, total);
      }
      const miss = [...tot.keys()].filter((k) => !ct.has(k));
      const ex = [...ct.keys()].filter((k) => !tot.has(k));
      const wrong = [...ct].filter(([k, v]) => tot.has(k) && !close(v, tot.get(k), tol, true)).map(([k]) => k);
      if (miss.length) gap(ctx, "groups-missing", miss.map((v) => clip(v)));
      if (ex.length) gap(ctx, "groups-extra", ex.map((v) => clip(v)));
      if (dups.length) gap(ctx, "groups-duplicated", dups);
      if (wrong.length) gap(ctx, "group-total-mismatch", wrong.map((v) => clip(v)));
      return;
    }
    case "percentOfTotal": {
      const i = col();
      const conds = compileConds(t, plan);
      const claim = claimOf(["value"]);
      const all = sumOf(numbers(rows, i, plan.column, ctx).map((x) => x.v));
      const part = sumOf(numbers(matched(conds), i, plan.column, ctx).map((x) => x.v));
      if (all === 0) return gap(ctx, "no-values");
      compareScalar(ctx, scalar(claim), (part / all) * 100, tol, true);
      return;
    }
    case "band": case "daysSince": {
      if (op === "daysSince" && plan.cell !== undefined) return runDaysSinceCell(plan, env, ctx, t);
      return runPerRow(plan, env, ctx, t, rows);
    }
    case "daysBetween": {
      const addr = (a) => {
        const r = t.byRow.get(a.row);
        if (!r) throw new Stop("check-invalid", `row ${a.row} is not in the table`);
        const s = r.cells[colIdx(t, a.column)];
        const d = readCellDate(s, fmtOf(plan, a.column));
        if (d === null) unread(ctx, `${a.row}:${a.column}`);
        return d;
      };
      const a = addr(plan.from);
      const b = addr(plan.to);
      const claim = claimOf(["value"]);
      if (a === null || b === null) return;
      compareScalar(ctx, scalar(claim), b - a, 0, false);
      return;
    }
    case "earliest": case "latest": {
      const i = col();
      const fmt = fmtOf(plan, plan.column);
      const claim = claimOf(["value"]);
      let best = null;
      for (const r of rows) {
        const s = r.cells[i];
        if (isBlank(s)) continue;
        const d = readCellDate(s, fmt);
        if (d === null) { unread(ctx, `${r.rowNumber}:${plan.column}`); continue; }
        if (best === null || (op === "earliest" ? d < best : d > best)) best = d;
      }
      if (best === null) return gap(ctx, "no-values");
      const c = need(claim, "value");
      const cd = readCellDate(c, fmt);
      if (cd === null) throw new Bad("claim-malformed", "date");
      expect(ctx, "value", dayToIso(best));
      if (cd !== best) gap(ctx, "value-mismatch", undefined, { measured: clip(String(c)) });
      return;
    }
    default:
      throw new Stop("check-invalid", `unknown op ${JSON.stringify(clip(String(op)))}`);
  }
}

function runDaysSinceCell(plan, env, ctx, t) {
  const r = t.byRow.get(plan.cell.row);
  if (!r) throw new Stop("check-invalid", `row ${plan.cell.row} is not in the table`);
  const s = r.cells[colIdx(t, plan.cell.column)];
  const claim = readClaim(env.claim(), ["value"], plan.claim);
  const d = readCellDate(s, fmtOf(plan, plan.cell.column));
  if (d === null) { unread(ctx, `${plan.cell.row}:${plan.cell.column}`); return; }
  compareScalar(ctx, claimNumber(need(claim, "value")), /** @type {number} */ (readIso(plan.asOf)) - d, 0, false);
}

/** `band` and per-row `daysSince`: one number per in-scope row (the cell, or with asOf the days since the date cell). */
function runPerRow(plan, env, ctx, t, rows) {
  const i = colIdx(t, plan.column);
  const conds = compileConds(t, plan);
  const isBand = plan.op === "band";
  const fmt = plan.asOf !== undefined ? fmtOf(plan, plan.column) : null;
  const asOf = plan.asOf !== undefined ? readIso(plan.asOf) : null;
  const claim = readClaim(env.claim(), [isBand ? "bands" : "days"], plan.claim);
  const claimed = need(claim, isBand ? "bands" : "days");
  for (const v of claimed.values()) {
    if (isBand ? typeof v !== "string" : typeof v !== "number" || !Number.isFinite(v)) throw new Bad("claim-malformed", isBand ? "bands" : "days");
  }
  const inScope = conds.length ? rows.filter((r) => matchRow(r, conds, ctx)) : rows;
  const empties = [];
  const expectedAt = new Map(); // row -> expected number
  for (const r of inScope) {
    const s = r.cells[i];
    if (isBlank(s)) { if (plan.allowEmpty !== true) empties.push(`${r.rowNumber}:${plan.column}`); continue; }
    let v;
    if (fmt !== null) {
      const d = readCellDate(s, fmt);
      v = d === null ? null : /** @type {number} */ (asOf) - d;
    } else v = readCellNumber(s);
    if (v === null) unread(ctx, `${r.rowNumber}:${plan.column}`);
    else expectedAt.set(r.rowNumber, v);
  }
  if (empties.length) gap(ctx, "empty-operand", empties);
  const rowsExp = [...expectedAt.keys()];
  const nameOf = (v) => {
    for (const b of plan.bands) {
      if (b.gt !== undefined ? v <= b.gt : b.gte !== undefined && v < b.gte) continue;
      if (b.lt !== undefined ? v >= b.lt : b.lte !== undefined && v > b.lte) continue;
      return b.name;
    }
    return null;
  };
  const wrong = [];
  const noBand = [];
  const exp = [];
  for (const [row, v] of expectedAt) {
    const want = isBand ? nameOf(v) : v;
    if (want === null) { noBand.push(row); continue; }
    exp.push([row, want]);
    if (!claimed.has(row)) continue;
    const c = claimed.get(row);
    if (c !== want) wrong.push(row);
  }
  expect(ctx, isBand ? "bands" : "days", exp.slice(0, EXPECTED_ROWS).map(([row, v]) => ({ row, [isBand ? "band" : "days"]: v })));
  if (exp.length > EXPECTED_ROWS) expect(ctx, isBand ? "bandsTotal" : "daysTotal", exp.length);
  if (noBand.length) gap(ctx, "no-band", noBand);
  const expectedSet = new Set(exp.map(([r]) => r));
  const missing = rowsExp.filter((r) => expectedSet.has(r) && !claimed.has(r));
  const extra = [...claimed.keys()].filter((r) => !expectedSet.has(r));
  if (missing.length) gap(ctx, "rows-missing", missing);
  if (extra.length) gap(ctx, "rows-extra", extra);
  if (wrong.length) gap(ctx, isBand ? "band-mismatch" : "days-mismatch", wrong);
}

// --- row math (table.rowMath and diff.newColumnRule) ------------------------------------

function rowMath(ctx, t, plan, rows) {
  const ia = colIdx(t, plan.a);
  const ir = colIdx(t, plan.result);
  const bConst = plain(plan.b);
  const ib = bConst ? -1 : colIdx(t, plan.b);
  const conds = compileConds(t, plan);
  const tol = plan.tolerance ?? MONEY_TOL;
  const allow = plan.allowEmpty === true;
  const bad = [], empties = [], divz = [], noResult = [];
  let checked = 0;
  const rd = (r, i, name) => {
    const s = r.cells[i];
    if (isBlank(s)) {
      if (allow) return 0;
      empties.push(`${r.rowNumber}:${name}`);
      return null;
    }
    const n = readCellNumber(s);
    if (n === null) unread(ctx, `${r.rowNumber}:${name}`);
    return n;
  };
  for (const r of rows) {
    if (!matchRow(r, conds, ctx)) continue;
    checked++;
    const a = rd(r, ia, plan.a);
    const b = bConst ? plan.b.const : rd(r, ib, plan.b);
    if (a === null || b === null) continue;
    let exp;
    if (plan.fn === "add") exp = a + b;
    else if (plan.fn === "sub") exp = a - b;
    else if (plan.fn === "mul") exp = a * b;
    else {
      if (b === 0) { divz.push(r.rowNumber); continue; }
      exp = plan.fn === "div" ? a / b : (a / b) * 100; // pct: a as a percent of b
    }
    const rs = r.cells[ir];
    if (isBlank(rs)) { noResult.push(r.rowNumber); continue; }
    const got = readCellNumber(rs);
    if (got === null) { unread(ctx, `${r.rowNumber}:${plan.result}`); continue; }
    if (!close(got, exp, tol, true)) bad.push(r.rowNumber);
  }
  if (checked === 0) gap(ctx, "no-rows-checked");
  if (empties.length) gap(ctx, "empty-operand", empties);
  if (bad.length) gap(ctx, "row-math-mismatch", bad);
  if (noResult.length) gap(ctx, "result-empty", noResult);
  if (divz.length) gap(ctx, "div-zero", divz);
}

// --- table (no claim) ---------------------------------------------------------------------

function runTable(plan, env, ctx) {
  const t = env.table(plan.table);
  const rows = scoped(t, plan);
  const op = plan.op;
  if (op === "rowCount") {
    if (rows.length !== plan.n) gap(ctx, "row-count", undefined, { measured: rows.length, limit: plan.n });
    return;
  }
  if (op === "rowMath") return rowMath(ctx, t, plan, rows);
  const i = colIdx(t, plan.column);
  const allow = plan.allowEmpty === true;
  if (op === "noEmpty") {
    const e = rows.filter((r) => isBlank(r.cells[i])).map((r) => r.rowNumber);
    if (e.length) gap(ctx, "empty-cells", e);
  } else if (op === "noDuplicates") {
    const seen = new Map();
    const d = new Set();
    for (const r of rows) {
      const s = r.cells[i];
      if (isBlank(s)) continue;
      if (seen.has(s)) { d.add(seen.get(s)); d.add(r.rowNumber); } else seen.set(s, r.rowNumber);
    }
    if (d.size) gap(ctx, "duplicate-values", [...d].sort((a, b) => a - b));
  } else {
    const fmt = op === "allDates" ? fmtOf(plan, plan.column) : null;
    const bad = [];
    for (const r of rows) {
      const s = r.cells[i];
      if (isBlank(s)) { if (!allow) bad.push(r.rowNumber); continue; }
      if ((fmt === null ? readCellNumber(s) : readCellDate(s, fmt)) === null) bad.push(r.rowNumber);
    }
    if (bad.length) gap(ctx, op === "allNumbers" ? "not-number" : "not-date", bad);
  }
}

// --- diff (before vs after, aligned by a signed key) ----------------------------------------

function keyed(t, k, label, ctx) {
  const m = new Map();
  const bad = [];
  for (const r of t.rows) {
    const v = r.cells[k];
    if (isBlank(v) || m.has(v)) bad.push(`${label}:${r.rowNumber}`);
    else m.set(v, r);
  }
  if (bad.length) { gap(ctx, "key-not-unique", bad); return null; }
  return m;
}
function runDiff(plan, env, ctx) {
  const before = env.table(plan.before);
  const after = env.table(plan.after);
  const kb = colIdx(before, plan.keyColumn);
  const ka = colIdx(after, plan.keyColumn);
  const op = plan.op;
  if (op === "newColumnRule") {
    colIdx(after, plan.result);
  }
  const mb = keyed(before, kb, "before", ctx);
  const ma = keyed(after, ka, "after", ctx);
  if (!mb || !ma) return;
  const added = [...ma.keys()].filter((k) => !mb.has(k));
  const deleted = [...mb.keys()].filter((k) => !ma.has(k));
  if (op === "rowsAdded" || op === "rowsDeleted") {
    const got = op === "rowsAdded" ? added : deleted;
    if (got.length !== plan.n) gap(ctx, op === "rowsAdded" ? "rows-added-count" : "rows-deleted-count", got.map((k) => clip(k)), { measured: got.length, limit: plan.n });
    return;
  }
  const bset = new Set(before.header);
  const aset = new Set(after.header);
  const newCols = after.header.filter((h) => !bset.has(h));
  const goneCols = before.header.filter((h) => !aset.has(h));
  const afterIdx = before.header.map((h) => after.header.indexOf(h));
  const changed = new Map(); // column -> [before row numbers]
  const changedKeys = new Map(); // key -> true
  for (const [key, rb] of mb) {
    const ra = ma.get(key);
    if (!ra) continue;
    before.header.forEach((h, i) => {
      if (afterIdx[i] >= 0 && rb.cells[i] !== ra.cells[afterIdx[i]]) {
        (changed.get(h) ?? changed.set(h, []).get(h)).push({ row: rb.rowNumber, key });
        changedKeys.set(key, true);
      }
    });
  }
  if (op === "onlyColumnsChanged") {
    const allowed = new Set(plan.columns);
    if (goneCols.length) gap(ctx, "column-removed", goneCols);
    const viol = [...changed].filter(([h]) => !allowed.has(h)).map(([h, rs]) => `${h}:${rs.map((x) => x.row).slice(0, 5).join(",")}${rs.length > 5 ? `,... (${rs.length} rows)` : ""}`);
    if (viol.length) gap(ctx, "column-changed", viol);
    const badNew = newCols.filter((c) => !allowed.has(c));
    if (badNew.length) gap(ctx, "column-added", badNew);
  } else if (op === "untouchedIdentical") {
    const except = new Set(plan.exceptKeys ?? []);
    if (goneCols.length) gap(ctx, "column-removed", goneCols);
    if (newCols.length) gap(ctx, "column-added", newCols);
    const cells = [];
    for (const [h, rs] of changed) for (const x of rs) if (!except.has(x.key)) cells.push(`${x.row}:${h}`);
    if (cells.length) gap(ctx, "untouched-cell-changed", cells);
  } else if (op === "newColumnRule") {
    const rc = plan.result;
    if (bset.has(rc) && !changed.has(rc)) gap(ctx, "column-not-new-or-changed", [rc]);
    rowMath(ctx, after, plan, after.rows);
  }
}

// --- entry ---------------------------------------------------------------------------------------

/** sha256 (hex) over the canonical form of a table snapshot: the header, then each row's rowNumber and cells (JSON, so it is injective). */
export function canonTableSha(t) {
  const canon = JSON.stringify([t.header, t.rows.map((r) => [r.rowNumber, r.cells])]);
  return createHash("sha256").update(canon, "utf8").digest("hex");
}
/** The sha256 of a typed table, or null when it is not a valid typed table (malformed, hostile, or over the size caps). Never throws. */
export function tableShaOf(raw) {
  try {
    return canonTableSha(snapshotTable(raw, "table"));
  } catch {
    return null;
  }
}

/**
 * Build the environment `evaluate` reads: tables come from `getTables()` (the caller's `opts.tables`), snapshotted ONCE per
 * name into `cache` (so every check of a checkpoint sees the same copy); the claim from `readClaimField()`.
 */
export function makeEnv(cache, getTables, readClaimField, signedSha) {
  return {
    table(name) {
      let hit = cache.get(name);
      if (hit === undefined) {
        try {
          let tables;
          try {
            tables = getTables();
          } catch {
            throw new Stop("table-invalid", "opts.tables is unreadable");
          }
          let raw;
          try {
            raw = plain(tables) && Object.hasOwn(tables, name) ? tables[name] : undefined;
          } catch {
            throw new Stop("table-invalid", `table ${clip(name)} is unreadable`);
          }
          hit = { t: snapshotTable(raw, name) };
          const want = signedSha ? signedSha(name) : undefined;
          // a table the spec signed (spec.inputs) must hash to its sha256, like a cited source: else the instrument cannot trust it
          if (want !== undefined && canonTableSha(hit.t) !== want) throw new Stop("missing-measurement", `table ${clip(name)} does not match its signed sha256`);
        } catch (e) {
          hit = { e };
        }
        cache.set(name, hit);
      }
      if (hit.e) throw hit.e;
      return hit.t;
    },
    claim: readClaimField,
  };
}

/**
 * Evaluate one signed `cells` / `table` / `diff` check. Never throws.
 * @param {"cells"|"table"|"diff"} rule
 * @param {any} check the signed check
 * @param {{ table: (name: string) => any, claim: () => {value?: any, missing?: true, unreadable?: true} }} env `table(name)` returns a snapshot or throws Stop/Big; `claim()` reads the claim field
 * @returns {{ stopped: {kind: string, detail: string}|null, gaps: object[], expected: object|null }}
 */
export function evaluate(rule, check, env) {
  const ctx = mkCtx();
  let stopped = null;
  try {
    try {
      validateSigned(rule, check);
    } catch (e) {
      if (e instanceof Invalid) throw new Stop("check-invalid", `${e.path || "check"} ${e.message}`);
      throw e;
    }
    if (rule === "cells") runCells(check, env, ctx);
    else if (rule === "table") runTable(check, env, ctx);
    else runDiff(check, env, ctx);
  } catch (e) {
    if (e instanceof Bad) gap(ctx, e.kind, [clip(String(e.detail))]);
    else if (e instanceof Big) gap(ctx, "table-too-large", [e.what], { measured: e.measured, limit: e.limit });
    else if (e instanceof Stop) stopped = { kind: e.kind, detail: e.detail };
    else stopped = { kind: "exception", detail: clip(e instanceof Error ? e.message : "unexpected error", 200) };
  }
  if (stopped) return { stopped, gaps: [], expected: null };
  if (ctx.unreadable.size) {
    gap(ctx, "unreadable-cell", [...ctx.unreadable]);
  }
  // a data problem in the table is listed BEFORE a claim problem, so gaps[0] shows it (stable within each group)
  const data = ctx.gaps.filter((g) => DATA_KINDS.has(g.kind));
  const gaps = data.length && data.length < ctx.gaps.length ? [...data, ...ctx.gaps.filter((g) => !DATA_KINDS.has(g.kind))] : ctx.gaps;
  return { stopped: null, gaps, expected: ctx.expected };
}

/** Gap kinds that say the TABLE (not the claim) is the problem; they sort first. */
const DATA_KINDS = new Set(["unreadable-cell", "empty-operand", "result-empty", "div-zero", "no-values", "no-rows-checked", "no-band", "lookup-unreadable", "lookup-not-unique", "key-not-unique", "fewer-than-n", "table-too-large"]);

/** Gap kinds minted by this module (the renderer's list; each has its own name, Law 12). */
export const CELLS_GAP_KINDS = Object.freeze({
  "value-mismatch": "claimed value does not match",
  "rows-missing": "claim omits rows",
  "rows-extra": "claim names rows that do not qualify",
  "rows-duplicated": "claim lists rows twice",
  "keys-extra": "claim names keys that do not qualify",
  "tied-rows-missing": "claim omits tied rows",
  "topn-values-mismatch": "claimed values do not match",
  "fewer-than-n": "fewer qualifying rows than n",
  "values-missing": "claim omits values",
  "values-extra": "claim names values that do not qualify",
  "groups-missing": "claim omits groups",
  "groups-extra": "claim names groups that do not exist",
  "groups-duplicated": "claim lists groups twice",
  "group-total-mismatch": "claimed group totals do not match",
  "lookup-not-unique": "lookup key does not match exactly one row",
  "lookup-unreadable": "lookup cell is unreadable",
  "no-values": "no values to compute over",
  "unreadable-cell": "unreadable cells",
  "empty-operand": "blank operands",
  "result-empty": "blank result cells",
  "div-zero": "division by zero",
  "row-math-mismatch": "rows where the result is wrong",
  "no-rows-checked": "no rows were checked",
  "band-mismatch": "claimed band is wrong",
  "days-mismatch": "claimed days are wrong",
  "no-band": "rows in no band",
  "not-number": "cells that are not numbers",
  "not-date": "cells that are not dates",
  "empty-cells": "blank cells",
  "duplicate-values": "rows sharing a value",
  "row-count": "wrong row count",
  "column-changed": "columns that changed",
  "column-added": "columns that were added",
  "column-removed": "columns that were removed",
  "untouched-cell-changed": "cells that must not change but did",
  "rows-added-count": "wrong number of rows added",
  "rows-deleted-count": "wrong number of rows deleted",
  "key-not-unique": "blank or repeated keys",
  "column-not-new-or-changed": "result column is neither new nor changed",
  "table-too-large": "table is over the size cap",
  "claim-missing": "claim field is missing",
  "claim-malformed": "claim is malformed",
  "claim-unreadable": "claim is unreadable",
  "claim-too-large": "claim is too large",
});
