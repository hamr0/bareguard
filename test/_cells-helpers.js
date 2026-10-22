import { evaluate, makeEnv } from "../src/primitives/rubric-cells.js";

// Shared by the cells tests (not a test file: the name starts with an underscore).

export const MISSING = Symbol("missing"); // the claim field is absent
const DIFF_OPS = new Set(["onlyColumnsChanged", "untouchedIdentical", "rowsAdded", "rowsDeleted", "newColumnRule"]);
const TABLE_OPS = new Set(["allNumbers", "allDates", "noEmpty", "noDuplicates", "rowCount", "rowMath"]);
export const ruleOf = (op) => (DIFF_OPS.has(op) ? "diff" : TABLE_OPS.has(op) ? "table" : "cells");

/** Run one check through the engine; verdict "green" | "red" | "stopped". `claim` is the claim OBJECT (or MISSING). */
export function runCheck(check, tables, claim) {
  const rule = ruleOf(check?.op);
  const c = rule === "cells" ? { claim: "c", ...check } : check;
  const env = makeEnv(new Map(), () => tables, () => (claim === MISSING ? { missing: true } : { value: claim }));
  const r = evaluate(rule, c, env);
  return { verdict: r.stopped ? "stopped" : r.gaps.length ? "red" : "green", gaps: r.gaps, stopped: r.stopped, expected: r.expected };
}
/** typed rows from arrays of cells; rowNumbers start at 2 */
export const mk = (header, data, start = 2) => ({ header, rows: data.map((c, i) => ({ rowNumber: start + i, cells: c })) });
