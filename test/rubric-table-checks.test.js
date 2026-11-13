import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Gate, createRubric, checkStep, runTableChecks, tableSha, rubricVocabulary, rubricSha } from "../src/index.js";
import { TABLE_MAX_CELLS } from "../src/primitives/rubric-cells.js";
import { computeGolden } from "./_cells-golden.js";
import * as api from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

// Ruling #82: runTableChecks (cells-prd.md §11.3), `fault.inputs` on a table sha mismatch (§11.7), and the proof that checkStep's
// contract did not change (golden over every worked example, produced by the code BEFORE this ruling).

const V = rubricVocabulary;
const EX = V.cells.exampleTables;
const clone = (x) => JSON.parse(JSON.stringify(x));
const tableExamples = Object.entries(V.rules.table.ops).map(([op, d]) => ({ op, check: clone(d.example.check) }));
const specOf = (checks, inputs) => ({ schema: 1, goal: "g", inputs: inputs ?? [{ name: "t", sha256: tableSha(EX.t) }], checkpoints: { cp: { gating: true, checks } } });
const tableCheck = (extra = {}) => ({ id: "n", rule: "table", table: "t", op: "noDuplicates", column: "Id", ...extra });

// ---- checkStep did not change -------------------------------------------------------------------------------------

test("golden: checkStep over every cells / table / diff example (plain, tampered, missing, ragged) equals the pre-#82 results, fault.inputs aside", async () => {
  const golden = JSON.parse(fs.readFileSync(new URL("./fixtures/cells-golden.json", import.meta.url), "utf8"));
  const now = await computeGolden(api);
  assert.deepEqual(Object.keys(now), Object.keys(golden));
  assert.equal(Object.keys(golden).length, 136);
  let mismatchFaults = 0;
  for (const k of Object.keys(golden)) {
    const r = clone(now[k]);
    for (const f of [r.fault, ...r.full.faults]) {
      if (f && f.inputs !== undefined) {
        mismatchFaults++;
        assert.equal(f.kind, "missing-measurement");
        delete f.inputs; // the one additive field
      }
    }
    assert.deepEqual(r, golden[k], k);
  }
  assert.ok(mismatchFaults > 0, "the golden run must contain sha-mismatch faults, or the strip above proves nothing");
});

// ---- 11.3 runTableChecks ---------------------------------------------------------------------------------------------

/** the same table damage the golden uses, plus ones that make the table checks red */
const damages = {
  plain: (t) => t,
  tampered: (t) => ({ ...t, t: { header: t.t.header, rows: t.t.rows.map((r, i) => (i === 0 ? { rowNumber: r.rowNumber, cells: r.cells.map((c, j) => (j === 1 ? "999" : c)) } : r)) } }),
  missing: (t) => ({ a: t.a }),
  ragged: (t) => ({ ...t, t: { header: t.t.header, rows: [{ rowNumber: 2, cells: ["x"] }] } }),
};
const redTables = {
  allX: (t) => ({ header: t.header, rows: t.rows.map((r) => ({ rowNumber: r.rowNumber, cells: r.cells.map(() => "x") })) }),
  blanks: (t) => ({ header: t.header, rows: t.rows.map((r) => ({ rowNumber: r.rowNumber, cells: r.cells.map(() => "") })) }),
  dupRows: (t) => ({ header: t.header, rows: t.rows.map((r) => ({ rowNumber: r.rowNumber, cells: [...t.rows[0].cells] })) }),
  wrongMath: (t) => ({ header: t.header, rows: t.rows.map((r) => ({ rowNumber: r.rowNumber, cells: r.cells.map((c, j) => (j === 5 ? "1" : c)) })) }),
  oneRow: (t) => ({ header: t.header, rows: t.rows.slice(0, 1) }),
};

test("parity: for every table op, runTableChecks gives the verdict and gaps checkStep gives the same check on the same tables (and ignores cells and diff checks)", async () => {
  let reds = 0;
  let stops = 0;
  let greens = 0;
  const variants = [];
  for (const [dn, d] of Object.entries(damages)) variants.push([dn, d(EX), EX.t]);
  for (const [rn, d] of Object.entries(redTables)) variants.push([rn, { t: d(EX.t), a: EX.a }, d(EX.t)]);
  for (const [vn, tables, signedT] of variants) {
    const checks = [
      ...tableExamples.map((e, i) => ({ ...e.check, id: `tb${i}` })),
      { id: "cellsCheck", rule: "cells", table: "t", claim: "answer", op: "sum", column: "Amount" }, // not run by runTableChecks
    ];
    const rubric = createRubric(specOf(checks, [{ name: "t", sha256: tableSha(signedT) ?? "0".repeat(64) }]));
    const mine = runTableChecks(rubric, "cp", tables);
    assert.deepEqual(mine.map((x) => x.id), tableExamples.map((_, i) => `tb${i}`), `${vn}: one entry per table check, in order, none for the cells check`);
    const full = await checkStep(rubric, "cp", { done: true }, { tables });
    for (const m of mine) {
      const gaps = full.full.gaps.filter((g) => g.id === m.id);
      const fault = full.full.faults.find((f) => f.id === m.id);
      if (fault) {
        stops++;
        assert.equal(m.verdict, "stopped", `${vn} ${m.id}`);
        assert.deepEqual(m.fault, fault, `${vn} ${m.id}`);
        assert.deepEqual(m.gaps, []);
      } else if (gaps.length) {
        reds++;
        assert.equal(m.verdict, "red", `${vn} ${m.id}`);
        assert.deepEqual(m.gaps, gaps, `${vn} ${m.id}`);
        assert.equal(m.fault, undefined);
      } else {
        greens++;
        assert.deepEqual({ verdict: m.verdict, gaps: m.gaps }, { verdict: "green", gaps: [] }, `${vn} ${m.id}`);
      }
    }
  }
  assert.ok(reds >= 8 && stops >= 12 && greens >= 5, `corpus must reach all three verdicts: ${reds} red, ${stops} stopped, ${greens} green`);
});

test("runTableChecks: the signed-table sha lock (mutating it must go red): a swapped table is stopped, not green", () => {
  const rubric = createRubric(specOf([tableCheck()]));
  const swapped = { ...EX, t: { header: EX.t.header, rows: [{ rowNumber: 2, cells: ["a9", "1", "", "", "", ""] }] } };
  const [r] = runTableChecks(rubric, "cp", swapped);
  assert.equal(r.verdict, "stopped");
  assert.equal(r.fault.kind, "missing-measurement");
  assert.equal(r.fault.detail, "table t does not match its signed sha256");
  assert.deepEqual(r.fault.inputs, ["t"]);
  assert.equal(runTableChecks(rubric, "cp", EX)[0].verdict, "green");
});

test("runTableChecks: oversize is red table-too-large, ragged and hostile are stopped, per check, never a throw", () => {
  const fake = [{ name: "t", sha256: "0".repeat(64) }];
  const checks = [tableCheck({ id: "one" }), tableCheck({ id: "two", op: "noEmpty" })];
  const rubric = createRubric(specOf(checks, fake));
  const over = { header: ["Id"], rows: Array.from({ length: TABLE_MAX_CELLS + 1 }, (_, i) => ({ rowNumber: i + 2, cells: ["x"] })) };
  const big = runTableChecks(rubric, "cp", { t: over });
  assert.deepEqual(big.map((r) => r.verdict), ["red", "red"]);
  assert.equal(big[0].gaps[0].kind, "table-too-large");
  assert.equal(big[0].gaps[0].limit, TABLE_MAX_CELLS);
  const kind = (tables) => runTableChecks(rubric, "cp", tables).map((r) => r.fault?.kind);
  assert.deepEqual(kind({ t: { header: ["Id"], rows: [{ rowNumber: 2, cells: ["a", "b"] }] } }), ["table-invalid", "table-invalid"]);
  assert.deepEqual(kind({}), ["table-invalid", "table-invalid"]);
  assert.deepEqual(kind({ get t() { throw new Error("boom"); } }), ["table-invalid", "table-invalid"]);
  assert.deepEqual(kind({ t: { header: ["Id"], get rows() { throw new Error("boom"); } } }), ["table-invalid", "table-invalid"]);
  assert.deepEqual(kind({ t: new Proxy({}, { get() { throw new Error("p"); }, ownKeys() { throw new Error("p"); } }) }), ["table-invalid", "table-invalid"]);
  const cyc = { header: ["Id"], rows: [] };
  cyc.rows.push(cyc);
  assert.deepEqual(kind({ t: cyc }), ["table-invalid", "table-invalid"]);
  assert.deepEqual(kind(new Proxy({}, { get() { throw new Error("p"); }, has() { throw new Error("p"); }, getOwnPropertyDescriptor() { throw new Error("p"); } })), ["table-invalid", "table-invalid"]);
});

test("runTableChecks: a table named __proto__ is an own entry only; an inherited member never answers", () => {
  const spec = specOf([tableCheck({ table: "__proto__" })], [{ name: "__proto__", sha256: tableSha(EX.t) }]);
  const rubric = createRubric(spec);
  assert.equal(runTableChecks(rubric, "cp", JSON.parse(`{"__proto__": ${JSON.stringify(EX.t)}}`))[0].verdict, "green");
  assert.equal(runTableChecks(rubric, "cp", {})[0].fault.kind, "table-invalid");
  assert.equal(({}).header, undefined);
  const ts = specOf([tableCheck({ table: "toString" })], [{ name: "toString", sha256: tableSha(EX.t) }]);
  assert.equal(runTableChecks(createRubric(ts), "cp", {})[0].fault.kind, "table-invalid");
});

test("runTableChecks: a checkpoint with no table checks returns []; a table-only checkpoint is served; the result is frozen and fresh", () => {
  const other = createRubric({ schema: 1, goal: "g", inputs: [{ name: "t", sha256: tableSha(EX.t) }], checkpoints: { only: { gating: true, checks: [{ id: "c", rule: "cells", table: "t", claim: "a", op: "sum", column: "Amount" }] }, none: { gating: false, checks: [] }, tbl: { gating: true, checks: [tableCheck()] } } });
  assert.deepEqual(runTableChecks(other, "only", EX), []);
  assert.deepEqual(runTableChecks(other, "none", {}), []);
  const r1 = runTableChecks(other, "tbl", EX);
  assert.equal(r1.length, 1);
  assert.ok(Object.isFrozen(r1) && Object.isFrozen(r1[0]) && Object.isFrozen(r1[0].gaps));
  assert.notEqual(runTableChecks(other, "tbl", EX), r1);
  assert.deepEqual(runTableChecks(other, "tbl", EX), r1);
  assert.throws(() => { "use strict"; r1.push(1); }, TypeError);
});

test("runTableChecks: TypeError only for the caller-misuse cases", () => {
  const rubric = createRubric(specOf([tableCheck()]));
  assert.throws(() => runTableChecks({}, "cp", EX), TypeError);
  assert.throws(() => runTableChecks(null, "cp", EX), TypeError);
  assert.throws(() => runTableChecks(specOf([tableCheck()]), "cp", EX), TypeError, "a raw spec is not a rubric");
  assert.throws(() => runTableChecks(rubric, "nope", EX), TypeError);
  assert.throws(() => runTableChecks(rubric, undefined, EX), TypeError);
  assert.throws(() => runTableChecks(rubric, "toString", EX), TypeError);
  for (const bad of [undefined, null, [], "x", 5, true]) assert.throws(() => runTableChecks(rubric, "cp", bad), TypeError, String(bad));
  assert.doesNotThrow(() => runTableChecks(rubric, "cp", {}));
});

test("runTableChecks does not touch a gate: it is a pure export (no audit, no state)", async (t) => {
  const dir = await makeTmpDir();
  t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const spec = specOf([tableCheck()]);
  const gate = new Gate({ audit: { path: auditPath }, rubric: { spec, sha256: rubricSha(spec), advanceOn: ["done"] }, runId });
  await gate.init();
  const before = fs.readFileSync(auditPath, "utf8");
  runTableChecks(createRubric(spec), "cp", EX);
  assert.equal(fs.readFileSync(auditPath, "utf8"), before);
});

// ---- 11.7 fault.inputs ----------------------------------------------------------------------------------------------

const NAMES = (n) => Array.from({ length: n }, (_, i) => `t${String(i).padStart(2, "0")}`);
const mkTable = (i) => ({ header: ["Id"], rows: [{ rowNumber: 2, cells: [`row${i}`] }] });
const changedTable = (i) => ({ header: ["Id"], rows: [{ rowNumber: 2, cells: [`ROW${i}`] }] });

test("fault.inputs: every mismatched table GIVEN, in spec.inputs order, including one no check of the checkpoint reads", async () => {
  const inputs = ["t", "u", "v"].map((n, i) => ({ name: n, sha256: tableSha(mkTable(i)) }));
  const spec = { schema: 1, goal: "g", inputs, checkpoints: { cp: { gating: true, checks: [tableCheck({ table: "v" })] } } };
  const rubric = createRubric(spec);
  // t mismatched (not read by any check), u right, v mismatched (read). Reported in spec.inputs order, not read order.
  const tables = { v: changedTable(2), u: mkTable(1), t: changedTable(0) };
  const r = await checkStep(rubric, "cp", { done: true }, { tables });
  assert.equal(r.verdict, "stopped");
  assert.deepEqual(r.fault, { key: "cp:n", checkpoint: "cp", id: "n", kind: "missing-measurement", detail: "table v does not match its signed sha256", inputs: ["t", "v"] });
  assert.equal(r.fault.inputsTotal, undefined);
  assert.ok(Object.isFrozen(r.fault) && Object.isFrozen(r.fault.inputs));
  // exactly one mismatch reports exactly it; a table with the right sha is absent
  const one = await checkStep(rubric, "cp", { done: true }, { tables: { v: changedTable(2), u: mkTable(1), t: mkTable(0) } });
  assert.deepEqual(one.fault.inputs, ["v"]);
  // the same list rides runTableChecks
  assert.deepEqual(runTableChecks(rubric, "cp", tables)[0].fault, r.fault);
  // a table not given is not listed (it is not a mismatch), and the unread one stays unread
  const partial = await checkStep(rubric, "cp", { done: true }, { tables: { v: changedTable(2) } });
  assert.deepEqual(partial.fault.inputs, ["v"]);
});

test("fault.inputs: the same list rides every sha fault of the call; an unreadable table is table-invalid and not listed", async () => {
  const inputs = ["t", "u", "w"].map((n, i) => ({ name: n, sha256: tableSha(mkTable(i)) }));
  const spec = { schema: 1, goal: "g", inputs, checkpoints: { cp: { gating: true, checks: [tableCheck({ id: "a", table: "t" }), tableCheck({ id: "b", table: "u" }), tableCheck({ id: "c", table: "w" })] } } };
  const rubric = createRubric(spec);
  const r = await checkStep(rubric, "cp", { done: true }, { tables: { t: changedTable(0), u: changedTable(1), w: { header: [] } } });
  const byId = Object.fromEntries(r.full.faults.map((f) => [f.id, f]));
  assert.deepEqual(byId.a.inputs, ["t", "u"]);
  assert.deepEqual(byId.b.inputs, ["t", "u"]);
  assert.equal(byId.c.kind, "table-invalid");
  assert.equal(byId.c.inputs, undefined, "table-invalid carries no inputs");
  assert.deepEqual(r.fault, byId.a);
});

test("fault.inputs: 20 names fit, 21 cap at 20 with inputsTotal 21 (the itemsTotal convention)", async () => {
  for (const n of [20, 21, 22]) {
    const names = NAMES(n);
    const inputs = names.map((nm, i) => ({ name: nm, sha256: tableSha(mkTable(i)) }));
    const spec = { schema: 1, goal: "g", inputs, checkpoints: { cp: { gating: true, checks: [tableCheck({ table: names[0] })] } } };
    const tables = Object.fromEntries(names.map((nm, i) => [nm, changedTable(i)]));
    const r = await checkStep(createRubric(spec), "cp", { done: true }, { tables });
    assert.equal(r.fault.inputs.length, Math.min(n, 20), `n=${n}`);
    assert.deepEqual(r.fault.inputs, names.slice(0, 20));
    if (n > 20) assert.equal(r.fault.inputsTotal, n);
    else assert.equal(Object.hasOwn(r.fault, "inputsTotal"), false);
  }
});

test("fault.inputs: a green run does no extra hash work (an unread table is never touched); a mismatch run does", async () => {
  const inputs = [{ name: "t", sha256: tableSha(EX.t) }, { name: "unread", sha256: tableSha(mkTable(1)) }];
  const rubric = createRubric({ schema: 1, goal: "g", inputs, checkpoints: { cp: { gating: true, checks: [tableCheck()] } } });
  let reads = 0;
  const spy = () => new Proxy(mkTable(1), { get(target, k) { if (k === "rows" || k === "header") reads++; return target[k]; } });
  const green = await checkStep(rubric, "cp", { done: true }, { tables: { t: EX.t, unread: spy() } });
  assert.equal(green.verdict, "green");
  assert.equal(reads, 0, "no hashing of tables no check reads on a green run");
  const bad = await checkStep(rubric, "cp", { done: true }, { tables: { t: { header: EX.t.header, rows: [] }, unread: spy() } });
  assert.equal(bad.verdict, "stopped");
  assert.ok(reads > 0, "the mismatch fault hashes the given tables");
  // hashed once per call, whatever the number of faults
  reads = 0;
  const two = createRubric({ schema: 1, goal: "g", inputs, checkpoints: { cp: { gating: true, checks: [tableCheck({ id: "a" }), tableCheck({ id: "b" }), tableCheck({ id: "c" })] } } });
  const r3 = await checkStep(two, "cp", { done: true }, { tables: { t: { header: EX.t.header, rows: [] }, unread: spy() } });
  assert.equal(r3.full.faults.length, 3);
  const once = reads;
  reads = 0;
  await checkStep(createRubric({ schema: 1, goal: "g", inputs, checkpoints: { cp: { gating: true, checks: [tableCheck()] } } }), "cp", { done: true }, { tables: { t: { header: EX.t.header, rows: [] }, unread: spy() } });
  assert.equal(once, reads, "three faults hash the unread table exactly as often as one fault does");
});

test("fault.inputs: a hostile opts.tables lists nothing and never throws; a text input of the same name is not a table", async () => {
  const rubric = createRubric({ schema: 1, goal: "g", inputs: [{ name: "t", sha256: tableSha(EX.t) }, { name: "doc", sha256: "a".repeat(64) }], checkpoints: { cp: { gating: true, checks: [tableCheck()] } } });
  const r = await checkStep(rubric, "cp", { done: true }, { tables: { t: { header: EX.t.header, rows: [] }, doc: "some text, not a table" } });
  assert.deepEqual(r.fault.inputs, ["t"]);
  const g = await checkStep(rubric, "cp", { done: true }, { tables: { t: { header: EX.t.header, rows: [] }, get doc() { throw new Error("boom"); } } });
  assert.deepEqual(g.fault.inputs, ["t"]);
  const missing = await checkStep(rubric, "cp", { done: true }, { tables: {} });
  assert.equal(missing.fault.kind, "table-invalid");
  assert.equal(missing.fault.inputs, undefined);
});

test("fault.inputs: the audit line of the fault stays within the line bound with 20 maximum-length names", async (t) => {
  const dir = await makeTmpDir();
  t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const names = Array.from({ length: 21 }, (_, i) => `${String(i).padStart(2, "0")}${"n".repeat(126)}`);
  assert.equal(names[0].length, 128);
  const inputs = names.map((nm, i) => ({ name: nm, sha256: tableSha(mkTable(i)) }));
  const spec = { schema: 1, goal: "g", inputs, checkpoints: { cp: { gating: true, checks: [tableCheck({ table: names[0] })] } } };
  const gate = new Gate({ audit: { path: auditPath }, rubric: { spec, sha256: rubricSha(spec), advanceOn: ["done"] }, runId });
  await gate.init();
  const res = await gate.checkStep("cp", { done: true }, { tables: Object.fromEntries(names.map((nm, i) => [nm, changedTable(i)])) });
  assert.equal(res.verdict, "stopped");
  assert.equal(res.fault.inputs.length, 20);
  const lines = fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean);
  const line = lines.filter((l) => JSON.parse(l).phase === "rubric").pop();
  assert.ok(Buffer.byteLength(line, "utf8") + 1 <= 3500, `${Buffer.byteLength(line, "utf8")} bytes`);
  assert.equal(JSON.parse(line).verdict, "stopped");
});

// ---- a REVOKED Proxy is caller misuse like any non-object: the same clear TypeError, never a native "IsArray" one ----------

test("runTableChecks: a revoked Proxy as tables or checkpoint gets the clear caller-misuse TypeError", () => {
  const sheet = { header: ["Id"], rows: [{ rowNumber: 2, cells: ["a"] }] };
  const rubric = createRubric({ schema: 1, goal: "g", inputs: [{ name: "t", sha256: tableSha(sheet) }],
    checkpoints: { s: { gating: true, checks: [{ id: "ids", rule: "table", table: "t", op: "noDuplicates", column: "Id" }] } } });
  const revoked = (target) => { const r = Proxy.revocable(target, {}); r.revoke(); return r.proxy; };
  for (const t of [revoked({}), revoked([])]) assert.throws(() => runTableChecks(rubric, "s", t), { name: "TypeError", message: "runTableChecks: tables must be an object" });
  for (const c of [revoked({}), revoked([])]) assert.throws(() => runTableChecks(rubric, c, { t: sheet }), { name: "TypeError", message: /^runTableChecks: unknown checkpoint type:/ });
  assert.equal(runTableChecks(rubric, "s", { t: sheet })[0].verdict, "green");
});
