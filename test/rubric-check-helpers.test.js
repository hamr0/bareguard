import test from "node:test";
import assert from "node:assert/strict";
import { createRubric, checkStep, tableSha, rubricVocabulary, checkTables, checkSchema, claimSchema } from "../src/index.js";
import { FIELD_DOCS, COLUMN_FIELDS, CMP_LIST, CMP_KINDS, CLAIM_KEYS_BY_OP, signedProblem, TABLE_MAX_CELLS } from "../src/primitives/rubric-cells.js";
import { validate } from "./_json-schema.js";

// Ruling #82 (docs/product/cells-prd.md §11): columnAt / cmps in the vocabulary, the structured claim table, checkTables, checkSchema,
// claimSchema. Every positive case has a negative twin; every never-throws function is fed hostile input.

const V = rubricVocabulary;
const EX = V.cells.exampleTables; // { t, a }
const HEADER = EX.t.header;
const clone = (x) => JSON.parse(JSON.stringify(x));
const examples = [];
for (const rule of ["cells", "table", "diff"]) for (const [op, d] of Object.entries(V.rules[rule].ops)) examples.push({ rule, op, check: clone(d.example.check), output: d.example.output });
const specOf = (checks, inputs) => ({ schema: 1, goal: "g", inputs: inputs ?? [{ name: "t", sha256: tableSha(EX.t) }], checkpoints: { cp: { gating: true, checks } } });
const tabs = (extra = {}) => ({ t: EX.t, a: EX.a, ...extra });
const kinds = (ps) => ps.map((p) => p.kind);
const SENTINEL = "NoSuchCol";

// ---- helpers over a check's column-bearing paths --------------------------------------------------------------

/** every marked column path of a check: [{ field, get(), set(v) }] ("each" = the diff-only `columns` list is skipped) */
function colPaths(check) {
  const out = [];
  for (const [k, at] of Object.entries(COLUMN_FIELDS)) {
    const v = check[k];
    if (v === undefined) continue;
    if (at === "self" && typeof v === "string") out.push({ field: k, get: () => check[k], set: (x) => { check[k] = x; } });
    else if (at === "self.column") out.push({ field: `${k}.column`, get: () => check[k].column, set: (x) => { check[k].column = x; } });
    else if (at === "each.column") v.forEach((e, i) => out.push({ field: `${k}[${i}].column`, get: () => check[k][i].column, set: (x) => { check[k][i].column = x; } }));
  }
  return out;
}

// ---- 11.1 columnAt and cmps -----------------------------------------------------------------------------------

// every string-ish field that is NOT a column: a VALUE or a name (the explicit decision list: a new field must be added to one side or the other)
const NOT_A_COLUMN = new Set(["table", "claim", "before", "after", "op", "range", "tolerance", "allowEmpty", "needle", "keyValue", "valueKind", "n", "order", "ties", "fn", "bands", "asOf", "exceptKeys"]);

test("columnAt: every marked field is documented, and every FIELD_DOCS field is marked or on the explicit not-a-column list", () => {
  for (const k of Object.keys(COLUMN_FIELDS)) assert.ok(Object.hasOwn(FIELD_DOCS, k), `${k} is marked but undocumented`);
  for (const k of Object.keys(FIELD_DOCS)) assert.ok(Object.hasOwn(COLUMN_FIELDS, k) !== NOT_A_COLUMN.has(k), `${k} must be exactly one of: marked columnAt, on the not-a-column list`);
  const expected = { column: "self", keyColumn: "self", groupColumn: "self", result: "self", a: "self", b: "self", from: "self.column", to: "self.column", cell: "self.column", where: "each.column", dateFormats: "each.column", columns: "each" };
  assert.deepEqual({ ...COLUMN_FIELDS }, expected);
  // the vocabulary carries it on every rule that has the field, and ONLY on those fields
  for (const rule of ["cells", "table", "diff"]) {
    for (const [name, d] of Object.entries(V.rules[rule].fields)) assert.equal(d.columnAt, COLUMN_FIELDS[name], `${rule}.${name}`);
  }
});

test("columnAt: a sentinel column in every marked path is not-a-column AND a stopped check-invalid; the same sentinel in a NON-marked string field is neither", async () => {
  let positives = 0;
  for (const { rule, op, check, output } of examples) {
    const claim = output ?? { answer: {} };
    for (const target of colPaths(check)) {
      const c = clone(check);
      const original = target.get();
      for (const p of colPaths(c)) if (p.get() === original) p.set(SENTINEL); // consistent: a date column's dateFormats entry follows its where
      const ps = checkTables(specOf([c]), tabs());
      const hit = ps.filter((p) => p.kind === "not-a-column" && p.field === target.field);
      assert.equal(hit.length, 1, `${rule}.${op} ${target.field}: ${JSON.stringify(ps)}`);
      assert.equal(hit[0].column, SENTINEL);
      assert.equal(ps.some((p) => p.kind === "refused"), false, `${rule}.${op} ${target.field} was refused: ${JSON.stringify(ps)}`);
      const r = await checkStep(createRubric(specOf([c])), "cp", claim, { tables: tabs() });
      assert.equal(r.verdict, "stopped", `${rule}.${op} ${target.field}`);
      assert.equal(r.fault.kind, "check-invalid");
      positives++;
    }
    // the same sentinel in a field that is NOT a column: never a column problem
    const c2 = clone(check);
    if (c2.needle !== undefined) c2.needle = SENTINEL;
    if (c2.keyValue !== undefined) c2.keyValue = SENTINEL;
    if (c2.exceptKeys !== undefined) c2.exceptKeys = [SENTINEL];
    if (c2.bands !== undefined) c2.bands[0].name = SENTINEL;
    if (c2.columns !== undefined) c2.columns = [SENTINEL]; // diff-only; the engine reads no header for it
    c2.text = SENTINEL;
    const ps2 = checkTables(specOf([c2]), tabs());
    assert.deepEqual(ps2.filter((p) => p.kind === "not-a-column" || p.kind === "refused"), [], `${rule}.${op}`);
    const r2 = await checkStep(createRubric(specOf([c2])), "cp", claim, { tables: tabs() });
    assert.notEqual(r2.fault?.kind, "check-invalid", `${rule}.${op} read a non-column as a column`);
  }
  assert.ok(positives >= 40, `only ${positives} marked paths exercised`);
});

test("where.cmps equals the validator's list; cmpKinds partitions it and each member is accepted in its stated shape and refused in another", () => {
  assert.deepEqual([...V.rules.cells.fields.where.cmps], [...CMP_LIST]);
  assert.deepEqual([...V.rules.table.fields.where.cmps], [...CMP_LIST]);
  assert.deepEqual([...V.rules.diff.fields.where.cmps], [...CMP_LIST]);
  assert.deepEqual(CMP_LIST, ["gt", "gte", "lt", "lte", "eq", "between", "before", "after", "dateBetween", "dateOn", "equals", "empty", "notEmpty"]);
  const kinds = V.rules.cells.fields.where.cmpKinds;
  assert.deepEqual(kinds, { number: ["gt", "gte", "lt", "lte", "eq", "between"], date: ["before", "after", "dateBetween", "dateOn"], text: ["equals"], none: ["empty", "notEmpty"] });
  assert.deepEqual(kinds, JSON.parse(JSON.stringify(CMP_KINDS)));
  assert.deepEqual(Object.values(kinds).flat().sort(), [...CMP_LIST].sort(), "the kinds partition the list exactly");
  const fmt = [{ column: "Due", format: "YYYY-MM-DD" }];
  const mk = (cond, withFmt) => ({ id: "c", rule: "cells", table: "t", claim: "c", op: "countIf", where: [cond], ...(withFmt ? { dateFormats: fmt } : {}) });
  const shape = (cmp, kind) => {
    const between = cmp === "between" || cmp === "dateBetween";
    if (kind === "none") return { column: "Id", cmp };
    if (kind === "text") return { column: "Id", cmp, value: "a" };
    if (kind === "number") return between ? { column: "Amount", cmp, lo: 1, hi: 2 } : { column: "Amount", cmp, value: 1 };
    return between ? { column: "Due", cmp, lo: "2026-01-01", hi: "2026-02-01" } : { column: "Due", cmp, value: "2026-01-01" };
  };
  for (const [kind, list] of Object.entries(kinds)) {
    for (const cmp of list) {
      assert.equal(signedProblem("cells", mk(shape(cmp, kind), kind === "date")), null, `${cmp} in its shape`);
      // a wrong-typed literal is refused: a number cmp with a string, a date cmp with a number, a none cmp with a value
      const wrong = kind === "none" ? { ...shape(cmp, "none"), value: 1 } : kind === "number" ? { ...shape(cmp, kind), ...(cmp === "between" ? { lo: "1" } : { value: "1" }) } : kind === "date" ? { ...shape(cmp, kind), ...(cmp === "dateBetween" ? { lo: 5 } : { value: 5 }) } : { ...shape(cmp, kind), value: 5 };
      assert.notEqual(signedProblem("cells", mk(wrong, kind === "date")), null, `${cmp} with a wrong-typed literal`);
    }
  }
});

test("the vocabulary stays deep-frozen and JSON-round-trippable with the new fields", () => {
  assert.ok(Object.isFrozen(V.rules.cells.fields.where.cmps) && Object.isFrozen(V.rules.cells.fields.where.cmpKinds.number));
  assert.ok(Object.isFrozen(V.rules.cells.fields.column));
  assert.deepEqual(JSON.parse(JSON.stringify(V)), V);
  assert.throws(() => { "use strict"; V.rules.cells.fields.where.cmps.push("x"); }, TypeError);
});

// ---- 11.5 the structured claim table -----------------------------------------------------------------------------

// The vocabulary's prose `claim` strings as they were hand-written BEFORE the structured table (git 879b7df, rubric-cells.js OPS): the
// generated strings must stay byte-identical.
const CLAIM_PROSE = {
  count: "{ value: integer }", countEmpty: "{ value: integer }", countIf: "{ value: integer }",
  sum: "{ value: number }", sumIf: "{ value: number }", average: "{ value: number }", averageIf: "{ value: number }", median: "{ value: number }", min: "{ value: number }", max: "{ value: number }",
  found: "{ value: boolean }",
  lookup: "{ value: string|number }",
  rows: "{ rows: integer[] } or { keys: string[] } (keys needs keyColumn; valueKind text|number, default text)",
  topN: "{ rows: integer[] } or { values: number[] }",
  uniqueCount: "{ value: integer }",
  duplicates: "{ values: string[] } and/or { rows: integer[] }",
  groupTotals: "{ totals: [{ group: string, total: number }] }",
  percentOfTotal: "{ value: number }",
  band: '{ bands: { "<rowNumber>": "<band name>" } }',
  daysBetween: "{ value: integer }",
  daysSince: '{ value: integer } with `cell`; { days: { "<rowNumber>": integer } } with `column` (exactly one of cell, column)',
  earliest: "{ value: date in the column's signed format }", latest: "{ value: date in the column's signed format }",
};

test("the vocabulary's claim prose is byte-identical to the strings written before the structured table", () => {
  const ops = V.rules.cells.ops;
  assert.deepEqual(Object.keys(ops).sort(), Object.keys(CLAIM_PROSE).sort());
  for (const [op, want] of Object.entries(CLAIM_PROSE)) assert.equal(ops[op].claim, want, op);
  assert.deepEqual(Object.keys(CLAIM_KEYS_BY_OP).sort(), Object.keys(CLAIM_PROSE).sort());
  // table rules and diff rules carry no claim prose
  for (const d of [...Object.values(V.rules.table.ops), ...Object.values(V.rules.diff.ops)]) assert.equal(d.claim, undefined);
});

// ---- 11.5 claimSchema --------------------------------------------------------------------------------------------

const cellsExamples = examples.filter((e) => e.rule === "cells");

test("claimSchema: every cells op example's claim validates, and the claim keys are exactly the structured table's", () => {
  assert.equal(cellsExamples.length, 23);
  for (const { op, check, output } of cellsExamples) {
    const s = claimSchema(check);
    assert.ok(s, op);
    assert.deepEqual(validate(s, output.answer), [], op);
    assert.deepEqual(Object.keys(output.answer).filter((k) => !CLAIM_KEYS_BY_OP[op].includes(k)), [], `${op}: claim key the table does not know`);
    for (const k of Object.keys(s.properties)) assert.ok(CLAIM_KEYS_BY_OP[op].includes(k), `${op}: schema key ${k} is not in the table`);
  }
});

/** every single-leaf mutation of a claim: a number as a string, a half step, the integer 1, a string as a number, a bad map key */
function mutations(claim) {
  const out = [];
  const walk = (node, path) => {
    if (typeof node === "number") {
      out.push({ path, v: String(node), tag: "string" }, { path, v: node + 0.5, tag: "float" }, { path, v: 1, tag: "one" });
    } else if (typeof node === "string") out.push({ path, v: 1, tag: "number" });
    else if (typeof node === "boolean") out.push({ path, v: "true", tag: "string" });
    else if (Array.isArray(node)) node.forEach((x, i) => walk(x, [...path, i]));
    else if (node && typeof node === "object") {
      for (const [k, x] of Object.entries(node)) walk(x, [...path, k]);
      if (path.length > 0 && Object.keys(node).every((k) => /^\d+$/.test(k))) for (const bad of ["0", "01", "x"]) out.push({ path, rename: bad, tag: "key" });
    }
  };
  walk(claim, []);
  return out.map((m) => {
    const c = clone(claim);
    let parent = c;
    for (const p of m.path.slice(0, -1)) parent = parent[p];
    if (m.rename) { // rename the first key of the map at m.path
      const target = m.path.reduce((n, p) => n[p], c);
      const [k0] = Object.keys(target);
      target[m.rename] = target[k0];
      delete target[k0];
    } else if (m.path.length === 0) return null;
    else parent[m.path[m.path.length - 1]] = m.v;
    return { claim: c, tag: m.tag, path: m.path.join(".") };
  }).filter(Boolean);
}

test("claimSchema vs the reader: every claim the schema rejects is red claim-malformed (value-mismatch for a half step); nothing drifts", async () => {
  let rejected = 0;
  let accepted = 0;
  for (const { op, check, output } of cellsExamples) {
    const s = claimSchema(check);
    const rubric = createRubric(specOf([check]));
    for (const m of mutations(output.answer)) {
      const errs = validate(s, m.claim);
      const r = await checkStep(rubric, "cp", { answer: m.claim }, { tables: tabs() });
      if (errs.length === 0) { accepted++; continue; } // not a violation of the schema (a float for a number, the integer 1 for a value)
      rejected++;
      assert.equal(r.verdict, "red", `${op} ${m.tag} ${m.path}: the schema rejects it, so checkStep must not be green: ${JSON.stringify(r.gaps)}`);
      const kinds = r.full.gaps.map((g) => g.kind);
      if (m.tag === "string" || m.tag === "number" || m.tag === "key") assert.ok(kinds.includes("claim-malformed"), `${op} ${m.tag} ${m.path}: wanted claim-malformed, got ${kinds}`);
    }
  }
  assert.ok(rejected >= 40 && accepted >= 5, `${rejected} rejected, ${accepted} accepted: the corpus must exercise both sides`);
});

test("claimSchema: the exact schemas of the integer / number / boolean / map shapes (so a changed type is a visible diff)", () => {
  const c = (op, extra) => claimSchema({ id: "x", rule: "cells", table: "t", claim: "answer", op, ...extra });
  assert.deepEqual(c("count", { column: "Id" }), { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false });
  assert.deepEqual(c("sum", { column: "Amount" }), { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false });
  assert.deepEqual(c("found", { column: "Id", needle: "a" }).properties.value, { type: "boolean" });
  assert.deepEqual(c("groupTotals", { column: "Amount", groupColumn: "Cat" }).properties.totals.items.required, ["group", "total"]);
  const bands = c("band", { column: "Amount", bands: [{ name: "x", gte: 0 }] });
  assert.deepEqual(bands.properties.bands, { type: "object", propertyNames: { pattern: "^[1-9][0-9]*$" }, additionalProperties: { type: "string" } });
  const days = c("daysSince", { column: "Due", asOf: "2026-10-31", dateFormats: [{ column: "Due", format: "YYYY-MM-DD" }] });
  assert.deepEqual(days.properties.days.additionalProperties, { type: "integer" });
  assert.deepEqual(days.required, ["days"]);
  const cell = c("daysSince", { cell: { column: "Due", row: 2 }, asOf: "2026-10-31", dateFormats: [{ column: "Due", format: "YYYY-MM-DD" }] });
  assert.deepEqual(Object.keys(cell.properties), ["value"]);
  for (const op of ["topN", "duplicates"]) assert.equal(claimSchema(cellsExamples.find((e) => e.op === op).check).minProperties, 1);
});

test("claimSchema: ops with alternative keys require at least one (anyOf, never oneOf): an empty box is rejected, each single-key box accepted", () => {
  const c = (op, extra) => ({ id: "x", rule: "cells", table: "t", claim: "answer", op, ...extra });
  const cases = [
    [c("rows", { where: [{ column: "Amount", cmp: "gt", value: 1 }], keyColumn: "Id" }), [{ rows: [2] }, { keys: ["a1"] }]],
    [c("topN", { column: "Amount", n: 1 }), [{ rows: [2] }, { values: [600] }]],
    [c("duplicates", { column: "Cat" }), [{ values: ["food"] }, { rows: [2, 4] }]],
  ];
  for (const [check, singles] of cases) {
    const s = claimSchema(check);
    assert.ok(Array.isArray(s.anyOf), `${check.op}: anyOf present`);
    assert.equal(s.anyOf.length, 2, check.op);
    assert.ok(!JSON.stringify(s).includes("oneOf"));
    assert.notEqual(validate(s, {}).length, 0, `${check.op}: empty box`);
    for (const one of singles) assert.deepEqual(validate(s, one), [], `${check.op} ${JSON.stringify(one)}`);
    assert.deepEqual(validate(s, Object.assign({}, ...singles)), [], `${check.op}: both together stay schema-valid`);
  }
  // every other op is single-form: a required key, so {} is rejected too
  for (const e of cellsExamples) assert.notEqual(validate(claimSchema(e.check), {}).length, 0, `${e.op}: {} must not pass`);
  // rows without keyColumn offers one key only: that key is required (no anyOf, no minProperties), {} rejected
  const only = claimSchema(c("rows", { where: [{ column: "Amount", cmp: "gt", value: 1 }] }));
  assert.equal(only.anyOf, undefined);
  assert.equal(only.minProperties, undefined);
  assert.deepEqual(only.required, ["rows"]);
  assert.notEqual(validate(only, {}).length, 0);
  assert.deepEqual(validate(only, { rows: [2] }), []);
  // an unknown field (a caller's own covers) makes the check unreadable to bareguard: null
  assert.equal(claimSchema(c("sum", { column: "Amount", covers: [1] })), null);
});

test("claimSchema: lookup is typed by the check's signed valueKind; rows keys follow keyColumn and valueKind", () => {
  const lk = (valueKind, extra = {}) => claimSchema({ id: "x", rule: "cells", table: "t", claim: "answer", op: "lookup", column: "Amount", keyColumn: "Id", keyValue: "a1", valueKind, ...extra });
  assert.equal(lk("number").properties.value.type, "number");
  assert.equal(lk("text").properties.value.type, "string");
  const d = lk("date", { column: "Due", dateFormats: [{ column: "Due", format: "DD/MM/YYYY" }] });
  assert.equal(d.properties.value.type, "string");
  assert.match(d.properties.value.description, /DD\/MM\/YYYY/);
  const rows = (extra) => claimSchema({ id: "x", rule: "cells", table: "t", claim: "answer", op: "rows", where: [{ column: "Amount", cmp: "gt", value: 1 }], ...extra });
  assert.deepEqual(Object.keys(rows({}).properties), ["rows"], "no keyColumn signed: keys is not offered");
  assert.equal(rows({ keyColumn: "Id" }).properties.keys.items.type, "string");
  assert.equal(rows({ keyColumn: "Id", valueKind: "number" }).properties.keys.items.type, "number");
  // rows and keys together: the schema allows it (no oneOf), checkStep keeps it red
  assert.deepEqual(validate(rows({ keyColumn: "Id" }), { rows: [2], keys: ["a1"] }), []);
});

test("claimSchema: rows + keys together is red claim-malformed at checkStep (the schema cannot say it)", async () => {
  const check = { id: "r", rule: "cells", table: "t", claim: "answer", op: "rows", where: [{ column: "Amount", cmp: "gt", value: 100 }], keyColumn: "Id" };
  const r = await checkStep(createRubric(specOf([check])), "cp", { answer: { rows: [2, 3], keys: ["a1", "a2"] } }, { tables: tabs() });
  assert.equal(r.verdict, "red");
  assert.ok(r.full.gaps.some((g) => g.kind === "claim-malformed"));
});

test("claimSchema: null for table and diff checks, non-checks, unknown ops, invalid and hostile input; never throws", () => {
  const tableCheck = examples.find((e) => e.rule === "table").check;
  const diffCheck = examples.find((e) => e.rule === "diff").check;
  assert.equal(claimSchema(tableCheck), null);
  assert.equal(claimSchema(diffCheck), null);
  for (const bad of [null, undefined, 5, "x", [], true, () => 1, Symbol("s"), {}, { rule: "cells" }, { id: "x", rule: "cells", table: "t", claim: "c", op: "nope", column: "Id" }, { id: "x", rule: "cells", table: "t", claim: "c", op: "sum" }, { id: "x", rule: "cells", table: "t", claim: "c", op: "sum", column: "Id", extra: 1 }]) {
    assert.equal(claimSchema(bad), null, String(JSON.stringify(bad)));
  }
  const hostile = { id: "x", rule: "cells", table: "t", claim: "c", op: "sum", get column() { throw new Error("boom"); } };
  assert.equal(claimSchema(hostile), null);
  assert.equal(claimSchema(new Proxy({}, { get() { throw new Error("proxy"); }, ownKeys() { throw new Error("proxy"); } })), null);
  assert.equal(claimSchema(JSON.parse('{"__proto__": {"x": 1}, "id": "x", "rule": "cells", "table": "t", "claim": "c", "op": "sum", "column": "Id"}')), null);
  const cyc = { id: "x", rule: "cells", table: "t", claim: "c", op: "sum", column: "Id" };
  cyc.self = cyc;
  assert.equal(claimSchema(cyc), null);
});

test("claimSchema: two checks sharing a claim name each get their own schema; a fresh object per call; the check is not mutated", () => {
  const a = { id: "a", rule: "cells", table: "t", claim: "shared", op: "count", column: "Id" };
  const b = { id: "b", rule: "cells", table: "t", claim: "shared", op: "sum", column: "Amount" };
  const before = JSON.stringify([a, b]);
  assert.equal(claimSchema(a).properties.value.type, "integer");
  assert.equal(claimSchema(b).properties.value.type, "number");
  const s1 = claimSchema(a);
  s1.properties.value.type = "string";
  s1.required.push("zzz");
  assert.deepEqual(claimSchema(a), { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false });
  assert.equal(JSON.stringify([a, b]), before);
  assert.notEqual(claimSchema(a), claimSchema(a));
});

// ---- 11.4 checkSchema --------------------------------------------------------------------------------------------

test("checkSchema: every vocabulary field of the rules is a property; column enums equal the columns; table enum equals the tables", () => {
  for (const rules of [["cells"], ["table"], ["cells", "table"]]) {
    const s = checkSchema({ rules, columns: HEADER, tables: ["t"] });
    assert.equal(s.additionalProperties, false);
    const want = new Set(["id", "rule"]);
    for (const r of rules) for (const k of Object.keys(V.rules[r].fields)) want.add(k);
    assert.deepEqual(new Set(Object.keys(s.properties)), want, rules.join("+"));
    assert.deepEqual(s.properties.table.enum, ["t"]);
    assert.deepEqual(s.properties.rule.enum, rules);
    for (const [name, at] of Object.entries(COLUMN_FIELDS)) {
      const p = s.properties[name];
      if (p === undefined) continue; // `columns` is diff-only
      const enums = [];
      const dig = (n) => { if (n && typeof n === "object") { if (Array.isArray(n.enum) && n === n) enums.push(n.enum); for (const v of Object.values(n)) dig(v); } };
      dig(p);
      assert.ok(enums.some((e) => JSON.stringify(e) === JSON.stringify(HEADER)), `${name} (${at}) has no enum of the header`);
    }
    // required
    assert.deepEqual(s.required, rules.length === 1 && rules[0] === "cells" ? ["id", "rule", "table", "op", "claim"] : ["id", "rule", "table", "op"]);
    // every property carries the vocabulary description
    for (const [name, p] of Object.entries(s.properties)) {
      if (name === "id" || name === "rule" || name === "text") continue;
      const vd = Object.values(V.rules).map((r) => r.fields?.[name]?.description).find((x) => x !== undefined);
      if (vd !== undefined) assert.equal(p.description, vd, name);
    }
  }
  const cellsOps = Object.keys(V.rules.cells.ops);
  const tableOps = Object.keys(V.rules.table.ops);
  assert.deepEqual(checkSchema({ rules: ["cells", "table"], columns: HEADER, tables: ["t"] }).properties.op.enum, [...cellsOps, ...tableOps]);
  assert.ok(!JSON.stringify(checkSchema({ rules: ["cells", "table"], columns: HEADER, tables: ["t"] })).includes("oneOf"));
});

test("checkSchema: 'amount' is invalid when the header is 'Amount'; a real header is valid; wrong shapes are invalid", () => {
  const s = checkSchema({ rules: ["cells"], columns: HEADER, tables: ["t"] });
  const ok = { id: "x", rule: "cells", table: "t", claim: "c", op: "sum", column: "Amount" };
  assert.deepEqual(validate(s, ok), []);
  assert.notEqual(validate(s, { ...ok, column: "amount" }).length, 0);
  assert.notEqual(validate(s, { ...ok, table: "u" }).length, 0);
  assert.notEqual(validate(s, { ...ok, extra: 1 }).length, 0);
  const { claim, ...noClaim } = ok;
  assert.notEqual(validate(s, noClaim).length, 0, "claim is required for cells alone");
  assert.notEqual(validate(s, { ...ok, where: [{ column: "Nope", cmp: "gt", value: 1 }] }).length, 0);
  assert.notEqual(validate(s, { ...ok, from: { column: "Id", row: 1 } }).length, 0, "row >= 2");
  assert.deepEqual(validate(s, { ...ok, where: [{ column: "Amount", cmp: "between", lo: 1, hi: 2 }] }), []);
  assert.notEqual(validate(s, { ...ok, where: Array.from({ length: 21 }, () => ({ column: "Id", cmp: "empty" })) }).length, 0, "21 conditions");
  assert.deepEqual(validate(s, { ...ok, where: Array.from({ length: 20 }, () => ({ column: "Id", cmp: "empty" })) }), [], "20 conditions");
  // a table-only schema has no claim, a cells + table schema offers it optionally
  assert.equal(checkSchema({ rules: ["table"], columns: HEADER, tables: ["t"] }).properties.claim, undefined);
  assert.equal(checkSchema({ rules: ["cells", "table"], columns: HEADER, tables: ["t"] }).required.includes("claim"), false);
});

test("checkSchema: every op's worked example validates under the schema AND createRubric accepts it", () => {
  for (const rule of ["cells", "table"]) {
    for (const rules of [[rule], ["cells", "table"]]) {
      const s = checkSchema({ rules, columns: HEADER, tables: ["t"] });
      for (const e of examples.filter((x) => x.rule === rule)) {
        assert.deepEqual(validate(s, e.check), [], `${rules.join("+")} ${e.op}`);
        createRubric(specOf([e.check])); // accepted
      }
    }
  }
});

test("checkSchema: deterministic, JSON-round-trippable, fresh per call", () => {
  const args = { rules: ["cells", "table"], columns: ["B", "A", "B"], tables: ["t", "u"] };
  const s1 = checkSchema(args);
  assert.equal(JSON.stringify(s1), JSON.stringify(checkSchema(args)));
  assert.deepEqual(JSON.parse(JSON.stringify(s1)), s1);
  assert.deepEqual(s1.properties.column.enum, ["B", "A"], "de-duplicated, order kept");
  assert.deepEqual(args.columns, ["B", "A", "B"], "the argument is not mutated");
  s1.properties.column.enum.push("zzz");
  s1.required.length = 0;
  assert.deepEqual(checkSchema(args).properties.column.enum, ["B", "A"]);
  assert.equal(checkSchema(args).required.length, 4);
  assert.notEqual(checkSchema(args), checkSchema(args));
});

test("checkSchema: TypeError only for caller misuse; null for empty columns or tables; hostile header strings are plain data", () => {
  const ok = { rules: ["cells"], columns: ["A"], tables: ["t"] };
  for (const bad of [undefined, null, 5, "x", [], { ...ok, rules: [] }, { ...ok, rules: ["diff"] }, { ...ok, rules: ["cells", "x"] }, { ...ok, rules: "cells" }, { ...ok, rules: undefined }, { ...ok, columns: "A" }, { ...ok, columns: undefined }, { ...ok, columns: ["A", 1] }, { ...ok, columns: [null] }, { ...ok, tables: "t" }, { ...ok, tables: [{}] }, { rules: ["cells"], columns: ["A"] }]) {
    assert.throws(() => checkSchema(bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => checkSchema({ get rules() { throw new Error("boom"); }, columns: ["A"], tables: ["t"] }), TypeError);
  assert.equal(checkSchema({ ...ok, columns: [] }), null);
  assert.equal(checkSchema({ ...ok, tables: [] }), null);
  const evil = ["__proto__", "", "x".repeat(1000), "constructor", "toString"];
  const s = checkSchema({ ...ok, columns: evil });
  assert.deepEqual(s.properties.column.enum, evil);
  assert.equal(Object.getPrototypeOf(s.properties.column.enum), Array.prototype);
  assert.equal(({}).polluted, undefined);
  const big = Array.from({ length: 100_000 }, (_, i) => `c${i}`);
  assert.equal(checkSchema({ ...ok, columns: big }).properties.column.enum.length, 100_000);
});

// ---- 11.2 checkTables --------------------------------------------------------------------------------------------

const cellsCheck = (extra = {}) => ({ id: "c", rule: "cells", table: "t", claim: "a", op: "sum", column: "Amount", ...extra });

test("checkTables: a clean spec over matching tables is []; every op example is clean over the example tables", () => {
  for (const e of examples) assert.deepEqual(checkTables(specOf([e.check]), tabs()), [], `${e.rule}.${e.op}`);
});

test("checkTables: no-table (carries the locator and table), only for tables a check reads; a diff's after is silent when absent", () => {
  const spec = specOf([cellsCheck()]);
  assert.deepEqual(checkTables(spec, {}), [{ kind: "no-table", checkpoint: "cp", index: 0, id: "c", table: "t" }]);
  assert.deepEqual(checkTables(spec, { other: EX.t }), [{ kind: "no-table", checkpoint: "cp", index: 0, id: "c", table: "t" }], "a table nobody reads is not reported");
  const diff = { id: "d", rule: "diff", before: "t", after: "a", keyColumn: "Id", op: "rowsAdded", n: 0 };
  assert.deepEqual(checkTables(specOf([diff]), { t: EX.t }), [], "after is the artifact checked later: absent is silent");
  assert.deepEqual(checkTables(specOf([diff]), {}), [{ kind: "no-table", checkpoint: "cp", index: 0, id: "d", table: "t" }]);
});

test("checkTables: unreadable-table for malformed, duplicate or empty header lists, ragged rows, non-strings, and an unreadable diff after", () => {
  const spec = specOf([cellsCheck()], [{ name: "t", sha256: "0".repeat(64) }]);
  const unreadable = [
    { header: [], rows: [] }, { header: ["A", "A"], rows: [] }, { header: ["", ""], rows: [] }, { header: ["A"], rows: [{ rowNumber: 2, cells: ["1", "2"] }] }, { header: ["A"], rows: [{ rowNumber: 2, cells: [1] }] },
    { header: ["A"], rows: [{ rowNumber: 3, cells: ["x"] }, { rowNumber: 3, cells: ["y"] }] }, { header: "A", rows: [] }, null, 5, "x", [],
  ];
  for (const t of unreadable) assert.deepEqual(checkTables(spec, { t }), [{ kind: "unreadable-table", table: "t" }], JSON.stringify(t));
  // a single empty-string header name is a valid unique header
  const one = { header: [""], rows: [{ rowNumber: 2, cells: ["1"] }] };
  assert.deepEqual(checkTables(specOf([cellsCheck({ column: "" })].map((c) => c), [{ name: "t", sha256: tableSha(one) }]), { t: one }), [{ kind: "refused", checkpoint: "cp", index: 0, id: "c", path: "spec.checkpoints.cp.checks[0].column", message: "invalid rubric: spec.checkpoints.cp.checks[0].column must be a non-blank string" }], "a blank column NAME in a check is refused; the header itself reads");
  const diff = { id: "d", rule: "diff", before: "t", after: "a", keyColumn: "Id", op: "rowsAdded", n: 0 };
  assert.deepEqual(checkTables(specOf([diff]), { t: EX.t, a: { header: [] } }), [{ kind: "unreadable-table", table: "a" }]);
});

test("checkTables: not-a-column carries table, clipped column, field path and the check locator; compared by exact string", () => {
  const long = "x".repeat(500);
  const c = cellsCheck({ op: "sumIf", column: "amount", where: [{ column: "Id", cmp: "empty" }, { column: long, cmp: "empty" }] });
  const ps = checkTables(specOf([c]), tabs());
  assert.deepEqual(ps.map((p) => [p.kind, p.field]), [["not-a-column", "column"], ["not-a-column", "where[1].column"]]);
  assert.equal(ps[0].column, "amount");
  assert.equal(ps[1].column.length, 120, "clipped");
  assert.deepEqual({ ...ps[0] }, { kind: "not-a-column", checkpoint: "cp", index: 0, id: "c", table: "t", column: "amount", field: "column" });
  // exact string: a trailing space, a different case, are not the column
  for (const col of ["Amount ", "AMOUNT", " Amount"]) assert.equal(checkTables(specOf([cellsCheck({ column: col })]), tabs()).length, 1, JSON.stringify(col));
  // row-math operands: a is a name, b a name or { const }; result a name
  const rm = (b) => ({ id: "m", rule: "table", table: "t", op: "rowMath", fn: "add", a: "Amount", b, result: "Total" });
  assert.deepEqual(checkTables(specOf([rm("Tax")]), tabs()), []);
  assert.deepEqual(checkTables(specOf([rm({ const: 5 })]), tabs()), [], "a const is not a column");
  assert.deepEqual(checkTables(specOf([rm("Nope")]), tabs()).map((p) => p.field), ["b"]);
  assert.deepEqual(checkTables(specOf([{ ...rm("Tax"), a: "Nope", result: "Nada" }]), tabs()).map((p) => p.field), ["result", "a"], "COLUMN_FIELDS order");
  // a cell address
  const dd = { id: "dd", rule: "cells", table: "t", claim: "a", op: "daysBetween", from: { column: "Due", row: 2 }, to: { column: "Gone", row: 3 }, dateFormats: [{ column: "Due", format: "YYYY-MM-DD" }, { column: "Gone", format: "YYYY-MM-DD" }] };
  assert.deepEqual(checkTables(specOf([dd]), tabs()).map((p) => p.field), ["to.column", "dateFormats[1].column"]);
});

test("checkTables: diff columns are read in the header runDiff reads them in (keyColumn both; newColumnRule fields in AFTER; columns in neither)", () => {
  const beforeOnly = { header: ["Id", "Amount", "OldOnly"], rows: [{ rowNumber: 2, cells: ["a", "1", "z"] }] };
  const afterOnly = { header: ["Id", "Amount", "NewOnly"], rows: [{ rowNumber: 2, cells: ["a", "1", "z"] }] };
  const diff = (extra) => ({ id: "d", rule: "diff", before: "t", after: "a", keyColumn: "Id", ...extra });
  const run = (check, before, after) => checkTables(specOf([check], [{ name: "t", sha256: tableSha(before) }]), after === undefined ? { t: before } : { t: before, a: after });
  assert.deepEqual(run(diff({ op: "rowsAdded", n: 0 }), beforeOnly, afterOnly), []);
  assert.deepEqual(run(diff({ op: "rowsAdded", n: 0, keyColumn: "OldOnly" }), beforeOnly, afterOnly).map((p) => [p.field, p.table]), [["keyColumn", "a"]], "key must be in BOTH");
  assert.deepEqual(run(diff({ op: "rowsAdded", n: 0, keyColumn: "NewOnly" }), beforeOnly, afterOnly).map((p) => [p.field, p.table]), [["keyColumn", "t"]]);
  assert.deepEqual(run(diff({ op: "rowsAdded", n: 0, keyColumn: "Nope" }), beforeOnly, afterOnly).map((p) => [p.field, p.table]), [["keyColumn", "t"]], "one problem per field");
  assert.deepEqual(run(diff({ op: "rowsAdded", n: 0, keyColumn: "OldOnly" }), beforeOnly), [], "after not given: nothing to check it against");
  // columns may name a column that exists only in after, or in neither
  assert.deepEqual(run(diff({ op: "onlyColumnsChanged", columns: ["NewOnly", "Nowhere"] }), beforeOnly, afterOnly), []);
  // newColumnRule: a, b, result, where, dateFormats are read in AFTER
  const ncr = diff({ op: "newColumnRule", fn: "add", a: "Amount", b: "NewOnly", result: "NewOnly", where: [{ column: "NewOnly", cmp: "notEmpty" }] });
  assert.deepEqual(run(ncr, beforeOnly, afterOnly), []);
  assert.deepEqual(run({ ...ncr, a: "OldOnly" }, beforeOnly, afterOnly).map((p) => [p.field, p.table]), [["a", "a"]]);
  assert.deepEqual(run({ ...ncr, where: [{ column: "OldOnly", cmp: "notEmpty" }] }, beforeOnly, afterOnly).map((p) => p.field), ["where[0].column"]);
});

test("checkTables: sha-mismatch (one cell off), also for a table nobody reads; a null hash is unreadable-table, not a mismatch", () => {
  const changed = { header: EX.t.header, rows: EX.t.rows.map((r, i) => (i === 2 ? { rowNumber: r.rowNumber, cells: r.cells.map((c, j) => (j === 1 ? "51" : c)) } : r)) };
  assert.deepEqual(checkTables(specOf([cellsCheck()]), { t: changed }), [{ kind: "sha-mismatch", table: "t" }]);
  const spec = specOf([cellsCheck()], [{ name: "t", sha256: tableSha(EX.t) }, { name: "extra", sha256: tableSha(EX.a) }]);
  assert.deepEqual(checkTables(spec, { t: EX.t, extra: changed }), [{ kind: "sha-mismatch", table: "extra" }]);
  assert.deepEqual(checkTables(spec, { t: EX.t, extra: { header: [] } }), [{ kind: "unreadable-table", table: "extra" }]);
  assert.deepEqual(checkTables(spec, { t: EX.t }), [], "an input that is not given and not read is silent");
});

test("checkTables: refused is every failing check, with createRubric's path and message", () => {
  const bad1 = { id: "b1", rule: "cells", table: "t", claim: "a", op: "bogus", column: "Amount" };
  const bad2 = { id: "b2", rule: "table", table: "t", op: "rowCount" }; // n missing
  const ok = cellsCheck({ id: "ok" });
  const spec = specOf([bad1, ok, bad2]);
  const ps = checkTables(spec, tabs());
  assert.deepEqual(ps.map((p) => [p.kind, p.index, p.id]), [["refused", 0, "b1"], ["refused", 2, "b2"]]);
  for (const p of ps) {
    let thrown;
    try { createRubric(specOf([p.id === "b1" ? bad1 : bad2])); } catch (e) { thrown = e; }
    assert.ok(thrown);
    assert.equal(p.message.replace(/checks\[\d+\]/, "checks[0]"), thrown.message);
    assert.equal(p.path.replace(/checks\[\d+\]/, "checks[0]"), thrown.path);
  }
  // a check naming a table that is not in spec.inputs is a cells-family refusal too
  const stray = checkTables(specOf([cellsCheck({ table: "ghost" })]), tabs());
  assert.deepEqual(stray.map((p) => [p.kind, p.path]), [["refused", "spec.checkpoints.cp.checks[0].table"]]);
  // a refused check gets no table or column problems
  assert.deepEqual(checkTables(specOf([{ ...bad1, column: "Nope" }]), tabs()).map((p) => p.kind), ["refused"]);
  // a refusal elsewhere (a non-cells check) is reported once, located; with a cells refusal present it is not added
  const other = { id: "w", rule: "maxWords", field: "text", value: 0 };
  const one = checkTables(specOf([other, cellsCheck({ column: "nope" })]), tabs());
  assert.deepEqual(one.map((p) => [p.kind, p.index]), [["refused", 0], ["not-a-column", 1]], "located at its check, the valid cells check still gets its problems");
  assert.equal(one[0].id, "w");
  const both = checkTables(specOf([other, bad1]), tabs());
  assert.deepEqual(both.map((p) => [p.kind, p.index, p.id]), [["refused", 0, "w"], ["refused", 1, "b1"]], "a non-cells refusal is reported next to a cells-family one");
  assert.equal(both[0].path, "spec.checkpoints.cp.checks[0].value");
  assert.ok(both[0].message.includes("checks[0].value"));
  // a valid non-cells check next to a refused cells one is NOT reported
  const fine = { id: "v", rule: "maxWords", field: "text", value: 5 };
  assert.deepEqual(checkTables(specOf([fine, bad1]), tabs()).map((p) => [p.kind, p.index]), [["refused", 1]]);
  // a spec-level refusal comes first and has no locator
  const noGoal = checkTables({ ...specOf([cellsCheck()]), goal: "" }, tabs());
  assert.deepEqual(noGoal, [{ kind: "refused", path: "spec.goal", message: "invalid rubric: spec.goal must be a non-blank string" }]);
});

test("checkTables: all five kinds in one spec, in the documented order (table-level, then by check)", () => {
  const changed = { header: EX.t.header, rows: [{ rowNumber: 2, cells: ["a1", "1", "", "", "", ""] }] };
  const spec = {
    schema: 1, goal: "g",
    inputs: [{ name: "t", sha256: tableSha(EX.t) }, { name: "w", sha256: tableSha(EX.t) }, { name: "u", sha256: tableSha(EX.a) }],
    checkpoints: { cp: { gating: true, checks: [
      cellsCheck({ id: "c0", column: "nope" }),
      cellsCheck({ id: "c1", table: "w" }),
      { id: "c2", rule: "table", table: "u", op: "noEmpty", column: "Id" },
      { id: "c3", rule: "cells", table: "t", claim: "a", op: "bogus", column: "Id" },
    ] } },
  };
  const ps = checkTables(spec, { t: changed, u: { header: [], rows: [] } });
  assert.deepEqual(ps.map((p) => [p.kind, p.kind === "sha-mismatch" || p.kind === "unreadable-table" ? p.table : p.id]), [["sha-mismatch", "t"], ["unreadable-table", "u"], ["not-a-column", "c0"], ["no-table", "c1"], ["refused", "c3"]]);
  assert.deepEqual(new Set(kinds(ps)), new Set(["no-table", "unreadable-table", "not-a-column", "sha-mismatch", "refused"]));
});

test("checkTables: boundaries (name 1000 vs 1001 chars, 20 vs 21 conditions, 0 columns)", () => {
  const col = (n) => "c".repeat(n);
  const mkT = (name) => ({ header: ["Id", name], rows: [{ rowNumber: 2, cells: ["a", "1"] }] });
  const at = checkTables(specOf([cellsCheck({ column: col(1000) })], [{ name: "t", sha256: tableSha(mkT(col(1000))) }]), { t: mkT(col(1000)) });
  assert.deepEqual(at, []);
  const over = checkTables(specOf([cellsCheck({ column: col(1001) })], [{ name: "t", sha256: tableSha(mkT(col(1001))) }]), { t: mkT(col(1001)) });
  assert.deepEqual(over.map((p) => [p.kind, p.path]), [["refused", "spec.checkpoints.cp.checks[0].column"]]);
  const conds = (n) => Array.from({ length: n }, () => ({ column: "Id", cmp: "empty" }));
  assert.deepEqual(checkTables(specOf([{ id: "w", rule: "cells", table: "t", claim: "a", op: "countIf", where: conds(20) }]), tabs()), []);
  assert.deepEqual(checkTables(specOf([{ id: "w", rule: "cells", table: "t", claim: "a", op: "countIf", where: conds(21) }]), tabs()).map((p) => [p.kind, p.path]), [["refused", "spec.checkpoints.cp.checks[0].where"]]);
  assert.deepEqual(checkTables(specOf([cellsCheck()]), { t: { header: [], rows: [] } }).map((p) => p.kind), ["unreadable-table"]);
});

test("checkTables: the table caps (500,000 cells reads, 500,001 is unreadable)", () => {
  const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ rowNumber: i + 2, cells: ["1"] }));
  const atCap = { header: ["Amount"], rows: rowsOf(TABLE_MAX_CELLS) };
  assert.deepEqual(checkTables(specOf([cellsCheck()], [{ name: "t", sha256: tableSha(atCap) }]), { t: atCap }), []);
  const over = { header: ["Amount"], rows: rowsOf(TABLE_MAX_CELLS + 1) };
  assert.deepEqual(checkTables(specOf([cellsCheck()], [{ name: "t", sha256: "0".repeat(64) }]), { t: over }), [{ kind: "unreadable-table", table: "t" }]);
});

test("checkTables: never throws on hostile spec, tables or arguments; own keys only; fresh results; inputs untouched", () => {
  const spec = specOf([cellsCheck()]);
  const args = [[null, null], [undefined, undefined], [5, "x"], [[], []], [spec, null], [spec, 5], [spec, []], [spec, "str"], [() => 1, {}], [Symbol("s"), {}]];
  for (const [s, t] of args) assert.ok(Array.isArray(checkTables(s, t)));
  assert.deepEqual(checkTables(spec, null).map((p) => p.kind), ["no-table"]);
  // throwing getters and Proxies everywhere
  const boom = () => { throw new Error("boom"); };
  const hostileSpec = { schema: 1, goal: "g", get checkpoints() { boom(); } };
  assert.deepEqual(checkTables(hostileSpec, tabs()).map((p) => p.kind), ["refused"]);
  const proxySpec = new Proxy({}, { get: boom, ownKeys: boom, getPrototypeOf: boom, has: boom });
  assert.deepEqual(checkTables(proxySpec, tabs()).map((p) => p.kind), ["refused"]);
  assert.deepEqual(checkTables(spec, new Proxy({}, { get: boom, ownKeys: boom, has: boom, getOwnPropertyDescriptor: boom })).map((p) => p.kind), ["unreadable-table"]);
  const getterTables = { get t() { boom(); } };
  assert.deepEqual(checkTables(spec, getterTables).map((p) => p.kind), ["unreadable-table"]);
  const rowGetter = { header: ["Amount"], rows: [{ rowNumber: 2, get cells() { boom(); } }] };
  assert.deepEqual(checkTables(spec, { t: rowGetter }).map((p) => p.kind), ["unreadable-table"]);
  const cyc = { header: ["A"], rows: [] };
  cyc.rows.push(cyc);
  assert.deepEqual(checkTables(spec, { t: cyc }).map((p) => p.kind), ["unreadable-table"]);
  const cycSpec = { schema: 1, goal: "g" };
  cycSpec.checkpoints = cycSpec;
  assert.deepEqual(checkTables(cycSpec, tabs()).map((p) => p.kind), ["refused"]);
  // __proto__ / constructor keys in the spec: refused like createRubric, not followed
  assert.deepEqual(checkTables(JSON.parse('{"schema":1,"goal":"g","__proto__":{"x":1},"checkpoints":{}}'), tabs()).map((p) => p.kind), ["refused"]);
  // null-proto lookups: a table named like a prototype member is absent; an own __proto__ table key is a table of that name only
  const protoSpec = specOf([cellsCheck({ table: "toString" })], [{ name: "toString", sha256: tableSha(EX.t) }]);
  assert.deepEqual(checkTables(protoSpec, { t: EX.t }).map((p) => p.kind), ["no-table"]);
  assert.deepEqual(checkTables(protoSpec, {}).map((p) => p.kind), ["no-table"]);
  const own = JSON.parse('{"__proto__": {"header": ["Amount"], "rows": []}}');
  assert.deepEqual(checkTables(specOf([cellsCheck({ table: "constructor" })], [{ name: "constructor", sha256: tableSha(EX.t) }]), own).map((p) => p.kind), ["no-table"]);
  assert.equal(({}).header, undefined);
  // fresh result, inputs neither mutated nor frozen
  const specCopy = clone(spec);
  const tablesCopy = clone(tabs());
  const a = checkTables(spec, { ...tabs(), t: { header: ["Id"], rows: [] } });
  a.push("junk");
  a[0].kind = "mutated";
  const b = checkTables(spec, { ...tabs(), t: { header: ["Id"], rows: [] } });
  assert.deepEqual(b.map((p) => p.kind), ["sha-mismatch", "not-a-column"]);
  assert.deepEqual(spec, specCopy);
  assert.deepEqual(tabs(), tablesCopy);
  assert.equal(Object.isFrozen(spec), false);
});

test("checkTables vs createRubric + checkStep: a clean answer means no table or column fault at step time (differential over the op examples and their damage)", async () => {
  const damages = [
    ["clean", (c) => c],
    ["column", (c) => { const x = clone(c); const ps = colPaths(x); for (const p of ps) if (p.get() === ps[0]?.get()) p.set(SENTINEL); return x; }],
  ];
  const tableDamage = [
    ["plain", (t) => t],
    ["dropT", (t) => ({ a: t.a })],
    ["tampered", (t) => ({ ...t, t: { header: t.t.header, rows: t.t.rows.map((r, i) => (i === 0 ? { rowNumber: r.rowNumber, cells: r.cells.map((c, j) => (j === 1 ? "999" : c)) } : r)) } })],
    ["ragged", (t) => ({ ...t, t: { header: t.t.header, rows: [{ rowNumber: 2, cells: ["x"] }] } })],
  ];
  let clean = 0;
  let broken = 0;
  for (const e of examples) {
    for (const [dn, dmg] of damages) {
      for (const [tn, tdm] of tableDamage) {
        const check = dmg(e.check);
        const tables = tdm(tabs());
        const ps = checkTables(specOf([check]), tables);
        let rubric;
        try {
          rubric = createRubric(specOf([check]));
        } catch {
          assert.ok(ps.some((p) => p.kind === "refused"), `${e.rule}.${e.op} ${dn}/${tn}: createRubric refuses but checkTables does not: ${JSON.stringify(ps)}`);
          broken++;
          continue;
        }
        const r = await checkStep(rubric, "cp", e.output ?? { answer: {} }, { tables });
        const faulty = r.verdict === "stopped" && ["check-invalid", "table-invalid", "missing-measurement"].includes(r.fault.kind);
        if (ps.length === 0) { clean++; assert.equal(faulty, false, `${e.rule}.${e.op} ${dn}/${tn}: checkTables said ok but checkStep faulted: ${JSON.stringify(r.fault)}`); }
        else { broken++; assert.equal(faulty, true, `${e.rule}.${e.op} ${dn}/${tn}: checkTables found ${JSON.stringify(ps)} but checkStep did not fault (${r.verdict})`); }
      }
    }
  }
  assert.ok(clean >= 20 && broken >= 100, `${clean} clean, ${broken} broken`);
});

test("claimSchema: every op example's box has required keys, or an anyOf of required keys when two or more are offered", () => {
  for (const e of cellsExamples) {
    const s = claimSchema(e.check);
    const keys = Object.keys(s.properties);
    if (keys.length === 1) {
      assert.deepEqual(s.required, keys, `${e.op}: one offered key is required`);
      assert.equal(s.anyOf, undefined, `${e.op}: no anyOf for one key`);
    } else if (s.required !== undefined) {
      assert.deepEqual(s.required, keys, `${e.op}`);
    } else {
      assert.ok(keys.length >= 2, `${e.op}`);
      assert.deepEqual(s.anyOf, keys.map((k) => ({ required: [k] })), `${e.op}: anyOf of requireds`);
    }
    assert.ok(s.required !== undefined || (Array.isArray(s.anyOf) && s.anyOf.every((a) => Array.isArray(a.required))), `${e.op}: required or anyOf of required`);
  }
  assert.equal(cellsExamples.length, 23);
});

// The documented keyword lists (claimSchema JSDoc, cells-prd 11.5): a caller with a strict structured-output provider reads them.
const keywordsOf = (schema) => {
  const out = new Set();
  const walk = (s) => {
    if (Array.isArray(s)) return s.forEach(walk);
    if (s === null || typeof s !== "object") return;
    for (const [k, v] of Object.entries(s)) {
      if (k === "properties") Object.values(v).forEach(walk);
      else {
        out.add(k);
        if (["items", "additionalProperties", "anyOf", "propertyNames"].includes(k)) walk(v);
      }
    }
  };
  walk(schema);
  return [...out].sort();
};

test("claimSchema / checkSchema: the JSON-schema keywords they emit are exactly the documented ones", () => {
  const claimKw = new Set();
  for (const e of cellsExamples) keywordsOf(claimSchema(e.check)).forEach((k) => claimKw.add(k));
  assert.deepEqual([...claimKw].sort(), ["additionalProperties", "anyOf", "description", "items", "minProperties", "minimum", "propertyNames", "pattern", "required", "type"].sort());
  const checkKw = new Set();
  for (const rules of [["cells"], ["table"], ["cells", "table"]]) keywordsOf(checkSchema({ rules, columns: HEADER, tables: ["t", "a"] })).forEach((k) => checkKw.add(k));
  assert.deepEqual([...checkKw].sort(), ["additionalProperties", "anyOf", "description", "enum", "items", "maxItems", "maxLength", "minItems", "minLength", "minimum", "required", "type"]);
});

test("checkTables: every refused check is surfaced in one call, non-cells and non-object entries included, in check order", () => {
  const bad = { id: "w", rule: "maxWords", field: "text", value: 0 };
  const ps = checkTables(specOf([null, 5, "x", [], { rule: "cells" }, bad]), {});
  assert.deepEqual(ps.filter((p) => p.kind === "refused").map((p) => p.index), [0, 1, 2, 3, 4, 5]);
  for (const p of ps.slice(0, 4)) assert.equal(p.path, `spec.checkpoints.cp.checks[${p.index}]`);
  assert.ok(ps.every((p) => !/checks\[0\]/.test(p.message) || p.index === 0), "messages name the real index, not the isolated one");
  assert.equal(ps[5].id, "w");
  // a spec-level refusal is still one front entry, and never throws
  assert.doesNotThrow(() => checkTables({ ...specOf([null, 5]), goal: "" }, {}));
});

// ---- checkTables: remove-and-retry on the real spec ------------------------------------------------------------------

const rr = (checkpoints, inputs) => ({ schema: 1, goal: "g", inputs: inputs ?? [{ name: "page", sha256: "a".repeat(64) }], checkpoints });
const citedOk = (id = "c1") => ({ id, rule: "cited", claims: "claims", source: "page" });
const badRule = (id) => ({ id, rule: "nope" });
const refusedAt = (ps) => ps.filter((p) => p.kind === "refused").map((p) => `${p.checkpoint}[${p.index}]`);

test("checkTables remove-and-retry: a check that is sound in its real spec is never refused for lacking context", () => {
  const spec = rr({ a: { gating: true, checks: [citedOk(), badRule("bad")] } });
  assert.doesNotThrow(() => createRubric(rr({ a: { gating: true, checks: [citedOk()] } })), "the cited check is valid in its real spec");
  const ps = checkTables(spec, {});
  assert.deepEqual(refusedAt(ps), ["a[1]"]);
  assert.equal(ps.find((p) => p.kind === "refused").id, "bad");
  // across two checkpoints: the valid cited check is never reported, both bad ones are, paths and messages carry the real index
  const two = checkTables(rr({ a: { gating: true, checks: [badRule("b1"), citedOk("c1")] }, b: { gating: true, checks: [citedOk("c2"), badRule("b2"), badRule("b3")] } }), {});
  assert.deepEqual(refusedAt(two), ["a[0]", "b[1]", "b[2]"]);
  for (const p of two) assert.ok(p.path.startsWith(`spec.checkpoints.${p.checkpoint}.checks[${p.index}]`) && p.message.includes(`checks[${p.index}]`), p.path);
});

test("checkTables remove-and-retry: a refusal that only exists after a removal is an artifact and is not reported", () => {
  // the only check of a checkpoint is refused: its removal would leave the checkpoint empty, which is not a finding
  const one = checkTables(rr({ a: { gating: true, checks: [badRule("only")] } }), {});
  assert.deepEqual(one.map((p) => [p.kind, p.checkpoint, p.index]), [["refused", "a", 0]]);
  // both checkpoints emptied: both checks are still reported, no checkpoint-level problem
  const both = checkTables(rr({ a: { gating: true, checks: [badRule("x")] }, b: { gating: true, checks: [badRule("y")] } }), {});
  assert.deepEqual(refusedAt(both), ["a[0]", "b[0]"]);
  assert.equal(both.length, 2);
  // a spec-level error on the UNTOUCHED spec is reported, once, alone
  const noGoal = checkTables({ ...rr({ a: { gating: true, checks: [badRule("x"), badRule("y")] } }), goal: "" }, {});
  assert.deepEqual(noGoal.map((p) => [p.kind, p.path]), [["refused", "spec.goal"]]);
  // the original shape still reports every entry
  assert.deepEqual(refusedAt(checkTables(rr({ cp: { gating: true, checks: [null, 5, "x", [], { rule: "cells" }] } }), {})), ["cp[0]", "cp[1]", "cp[2]", "cp[3]", "cp[4]"]);
});

test("checkTables remove-and-retry: at most 20 refused checks are found; one more is a `truncated` problem", () => {
  const checks = (n) => [citedOk(), ...Array.from({ length: n }, (_, i) => badRule(`b${i}`))];
  const at20 = checkTables(rr({ a: { gating: true, checks: checks(20) } }), {});
  assert.equal(refusedAt(at20).length, 20);
  assert.equal(at20.some((p) => p.kind === "truncated"), false, "exactly 20: nothing more to find");
  const at21 = checkTables(rr({ a: { gating: true, checks: checks(21) } }), {});
  assert.equal(refusedAt(at21).length, 20);
  assert.deepEqual(at21[at21.length - 1], { kind: "truncated", limit: 20 });
  assert.deepEqual(refusedAt(at21).slice(0, 3), ["a[1]", "a[2]", "a[3]"]);
});

test("checkTables remove-and-retry: never mutates the spec, never throws on a hostile one", () => {
  const spec = rr({ a: { gating: true, checks: [citedOk(), badRule("bad")] } });
  const before = JSON.stringify(spec);
  checkTables(spec, {});
  assert.equal(JSON.stringify(spec), before);
  assert.doesNotThrow(() => checkTables(rr({ a: new Proxy({}, { get() { throw 1; } }) }), {}));
});

test("checkTables with a checkpoint id holding . [ or ]: exactly one UNPLACED refusal, the same in either key order", () => {
  const ok = (id) => ({ id, rule: "maxWords", field: "x", value: 5 });
  const A = () => ({ gating: true, checks: [ok("c0"), ok("c1"), ok("c2")] });
  const cases = [
    () => ({ gating: true, checks: [badRule("q")] }), // a bad check inside the colliding checkpoint
    () => ({ gating: 5, checks: [] }), // a checkpoint-level error
    () => 5, // not an object
  ];
  for (const mk of cases) {
    const results = [rr({ a: A(), "a.checks[1]": mk() }), rr({ "a.checks[1]": mk(), a: A() })].map((s) => {
      let err;
      try { createRubric(JSON.parse(JSON.stringify(s))); } catch (e) { err = e; }
      const ps = checkTables(s, {});
      assert.equal(ps.length, 1);
      assert.deepEqual(Object.keys(ps[0]).sort(), ["kind", "message", "path"]);
      assert.equal(ps[0].kind, "refused");
      assert.equal(ps[0].path, err.path);
      return ps[0].path;
    });
    assert.equal(results[0], results[1]);
  }
  // ids without . [ ] keep their placement
  assert.deepEqual(refusedAt(checkTables(rr({ a: A(), b: { gating: true, checks: [badRule("q")] } }), {})), ["b[0]"]);
});

test("checkTables: odd ids still report a cells refusal placed (found per check object, not by path)", () => {
  const cell = { id: "x", rule: "cells", table: "nope", claim: "c", op: "sum", column: "Amount" };
  const ps = checkTables(rr({ "a.b": { gating: true, checks: [cell] } }), {});
  assert.ok(ps.some((p) => p.kind === "refused" && p.checkpoint === "a.b" && p.index === 0), JSON.stringify(ps));
});

test("checkTables INVARIANT: createRubric throws on the untouched spec <=> at least one `refused`", () => {
  const ok = (id) => ({ id, rule: "maxWords", field: "x", value: 5 });
  const ids = ["a", "a.checks", "a.checks[0]", "a.checks[1]", "a[0]"];
  const values = [() => 5, () => ({ gating: 5, checks: [] }), () => ({ gating: true, checks: [badRule("q")] }), () => ({ gating: true, checks: [] }), () => ({ gating: true, checks: [ok("c0"), ok("c1")] }), () => ({ gating: true, checks: [ok("c0"), badRule("c1")] })];
  let threw = 0, passed = 0, n = 0;
  const pairs = ids.flatMap((i, x) => ids.slice(x + 1).map((j) => [i, j]));
  const grid = () => values.flatMap((v1) => values.map((v2) => [v1, v2]));
  for (const [i, j] of pairs) {
    for (const [v1, v2] of grid()) {
      for (const order of [[i, j], [j, i]]) {
        const vals = { [i]: v1, [j]: v2 };
        const cps = {};
        for (const id of order) cps[id] = vals[id]();
        const spec = rr(cps);
        let throws = true;
        try { createRubric(JSON.parse(JSON.stringify(spec))); throws = false; } catch { /* refused */ }
        const refused = checkTables(spec, {}).filter((p) => p.kind === "refused").length;
        const label = `${order.join("|")} ${JSON.stringify(spec.checkpoints)}`;
        if (throws) { threw++; assert.ok(refused >= 1, `throws but no refused: ${label}`); } else { passed++; assert.equal(refused, 0, `passes but refused: ${label}`); }
        n++;
      }
    }
  }
  assert.ok(threw > 50 && passed > 5, `sweep covers both outcomes (${threw}/${passed} of ${n})`);
});

test("checkTables with odd checkpoint ids: one unplaced refusal, never a sound check blamed (three-checkpoint sweep)", () => {
  const ok = (id) => ({ id, rule: "maxWords", field: "x", value: 5 });
  const ids = ["a", "a.checks", "a.checks[0]", "a.checks[1]", "a[0]", "a.checks[0].field", "b", "a.checks[2]"];
  const values = [() => 5, () => ({ gating: 5, checks: [] }), () => ({ gating: true, checks: [badRule("q")] }), () => ({ gating: true, checks: [] }), () => ({ gating: true, checks: [ok("c0"), ok("c1")] }), () => ({ gating: true, checks: [ok("c0"), badRule("c1"), ok("c2")] })];
  let n = 0, threw = 0;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) for (let k = j + 1; k < ids.length; k++) {
    const trio = [ids[i], ids[j], ids[k]];
    if (!trio.some((id) => /[.[\]]/.test(id))) continue;
    for (const order of [trio, [...trio].reverse()]) for (const vs of [[0, 0, 0], [1, 2, 3], [5, 0, 4], [2, 5, 1], [4, 4, 5], [3, 1, 2], [0, 5, 5], [4, 3, 0], [4, 4, 4], [3, 3, 4]]) {
      const cps = {};
      order.forEach((id, x) => { cps[id] = values[vs[x]](); });
      const spec = rr(cps);
      let throws = true;
      try { createRubric(JSON.parse(JSON.stringify(spec))); throws = false; } catch { /* refused */ }
      const ps = checkTables(spec, {});
      const refused = ps.filter((p) => p.kind === "refused");
      const label = JSON.stringify(cps);
      assert.equal(refused.length >= 1, throws, label);
      if (throws) threw++;
      for (const p of refused) {
        if (p.index === undefined) continue;
        const c = spec.checkpoints[p.checkpoint]?.checks?.[p.index];
        assert.ok(!(c && c.rule === "maxWords"), `a sound check is blamed: ${label} -> ${p.checkpoint}[${p.index}]`);
      }
      n++;
    }
  }
  assert.ok(n > 500 && threw > 100 && n > threw, `${n}/${threw}`);
});

// ---- checkSchema: a REVOKED Proxy anywhere in args is caller misuse with checkSchema's own clear message ----------------------

test("checkSchema: a revoked Proxy as args, rules, columns or tables throws the clear TypeError, never a native one", () => {
  const revoked = (target) => { const r = Proxy.revocable(target, {}); r.revoke(); return r.proxy; };
  const ok = { rules: ["cells"], columns: ["a"], tables: ["t"] };
  for (const mk of [() => revoked({}), () => revoked([])]) {
    assert.throws(() => checkSchema(mk()), { name: "TypeError", message: "checkSchema: args is unreadable" });
    assert.throws(() => checkSchema({ ...ok, rules: mk() }), { name: "TypeError", message: /^checkSchema: rules must be/ });
    assert.throws(() => checkSchema({ ...ok, columns: mk() }), { name: "TypeError", message: "checkSchema: columns must be an array of strings" });
    assert.throws(() => checkSchema({ ...ok, tables: mk() }), { name: "TypeError", message: "checkSchema: tables must be an array of strings" });
  }
  assert.throws(() => checkSchema({ ...ok, columns: [revoked({})] }), { message: "checkSchema: columns must be an array of strings" });
  assert.ok(checkSchema(ok));
});
