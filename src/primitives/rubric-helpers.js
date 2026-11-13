// Check helpers for callers (RULED #82, docs/product/cells-prd.md §11): `checkTables`, `checkSchema`, `claimSchema`.
// Deterministic, $0, no LLM. They are the draft-time view of what `createRubric` / `checkStep` already do: the same validator, the same
// snapshot, the same header comparison (exact string, `header.indexOf`), so a spec `checkTables` calls fine cannot fault on tables or columns.
// (`runTableChecks` lives in rubric.js beside `checkStep`, with which it shares one evaluation path; `groundedLiterals` in rubric-grounded.js.)

import { rubricVocabulary, createRubric, snapshotSpec, checkRefusal, clip } from "./rubric.js";
import { snapshotTable, canonTableSha, CELLS_RULES, COLUMN_FIELDS, SIGNED_LIMITS, claimSchemaOf } from "./rubric-cells.js";

const CLIP = 120;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// --- checkTables ----------------------------------------------------------------

/** The readable state of one given table: { header, sha }, "absent" (not carried) or "unreadable". Reads own entries only. */
function tableState(tables, name) {
  let raw;
  try {
    if (!isPlain(tables) || !Object.hasOwn(tables, name)) return "absent";
    raw = tables[name];
  } catch {
    return "unreadable";
  }
  if (raw === undefined) return "absent";
  try {
    const snap = snapshotTable(raw, "table");
    return { header: snap.header, sha: canonTableSha(snap) };
  } catch {
    return "unreadable";
  }
}

/** The column-bearing fields of a signed check, in COLUMN_FIELDS order: [{ field: "where[1].column", column }]. `c` is a snapshot. */
function columnRefs(c) {
  const out = [];
  for (const [k, at] of Object.entries(COLUMN_FIELDS)) {
    const v = c[k];
    if (v === undefined) continue;
    if (at === "self") {
      if (typeof v === "string") out.push({ field: k, column: v }); // `b` may be { const }: not a column
    } else if (at === "self.column") {
      if (isPlain(v) && typeof v.column === "string") out.push({ field: `${k}.column`, column: v.column });
    } else if (at === "each.column" && Array.isArray(v)) {
      v.forEach((e, i) => {
        if (isPlain(e) && typeof e.column === "string") out.push({ field: `${k}[${i}].column`, column: e.column });
      });
    }
    // `columns` ("each", diff onlyColumnsChanged) names no header the engine reads: it is not checked
  }
  return out;
}

/**
 * "This spec will not run on these tables", at $0: every problem a raw drafted spec has with the typed tables, all in one call. Per
 * check: `no-table` (a check reads a table `tables` does not carry), `not-a-column` (a column-bearing field names a header the table does not
 * have; exact string compare), `refused` (what `createRubric` would throw for that check, with its `path` and message). Per table:
 * `unreadable-table` (`tableSha` would be null: malformed, a duplicate or empty header list, over the size caps) and `sha-mismatch` (a table
 * named in `spec.inputs` whose given rows do not hash to the signed sha256). Typed objects only; callers write their own sentences.
 * @param {object} spec the raw (not yet `createRubric`-ed) spec a drafter produced
 * @param {Object<string, {header: string[], rows: {rowNumber: number, cells: string[]}[]}>} tables
 * @returns {{ kind: "no-table"|"unreadable-table"|"not-a-column"|"sha-mismatch"|"refused"|"truncated", limit?: number, checkpoint?: string, index?: number, id?: string, table?: string, column?: string, field?: string, path?: string, message?: string }[]}
 * @when Reach for this right after an AI drafted a rubric spec over the person's tables and BEFORE signing or running it: one call lists everything that would stop it (a check naming a table or column that is not there, a table that cannot be read, a table that does not match its signed sha256, a spec `createRubric` would refuse), so you send one repair prompt instead of discovering each at step time. Empty array = ok. It checks the draft against the data; `createRubric` and `checkStep` still run as before.
 * @category rubric
 * @signature checkTables(spec: object, tables: object) => { kind: string, limit?: number, checkpoint?: string, index?: number, id?: string, table?: string, column?: string, field?: string, path?: string, message?: string }[]
 * @fails Never throws: a hostile spec or table, a throwing getter, a Proxy, `__proto__` keys or a non-object argument all return problems (a spec that cannot be read is one `refused`). A fresh array of fresh objects each call; inputs are not mutated. `refused` is reported for EVERY failing check (the path as `createRubric` forms it): a cells/table/diff check by the validator's own function, any other check (a non-object entry too) by remove-and-retry on the REAL spec: `createRubric` throws, that check is taken out of a copy, it is asked again, and so on (so a sound check is never refused for lacking its inputs or neighbours). It stops when `createRubric` passes, when a refusal is not inside a check, or after 20 such checks; a 21st still refused adds one last problem `{ kind: "truncated", limit: 20 }` (more may exist). A refusal that belongs to the spec or a checkpoint is reported only when it is the FIRST one, on the untouched spec; one that appears only after removals is dropped. Stated limit: when ANY checkpoint id contains `.`, `[` or `]` the path text cannot say which check or checkpoint it names, so remove-and-retry does not run and the untouched spec's single `createRubric` refusal is reported UNPLACED (`{ kind: "refused", path, message }`, no checkpoint, index or id); cells/table/diff refusals found by their own validator stay placed. A check that is `refused` gets no table or column problems. Problems with no check (`unreadable-table`, `sha-mismatch`, a spec-level `refused`) come first, then each check's, in checkpoint and check order. A diff's `after` table is the artifact checked later, not signed: it is reported only when given and unreadable, and checked for `keyColumn` and a `newColumnRule`'s `a`, `b`, `result`, `where` and `dateFormats` columns when given.
 * @example
 * import { checkTables } from "bareguard";
 * const sheet = { header: ["Id", "Amount"], rows: [{ rowNumber: 2, cells: ["a", "5"] }] };
 * const spec = { schema: 1, goal: "g", inputs: [{ name: "t", sha256: "0".repeat(64) }], checkpoints: { s: { gating: true,
 *   checks: [{ id: "sum", rule: "cells", table: "t", claim: "ans", op: "sum", column: "amount" }] } } };
 * checkTables(spec, { t: sheet }).map((p) => p.kind); // ["sha-mismatch", "not-a-column"]
 */
export function checkTables(spec, tables) {
  try {
    return buildProblems(spec, tables);
  } catch {
    return [{ kind: "refused", path: "spec", message: "invalid rubric: spec could not be read" }];
  }
}

function buildProblems(spec, tables) {
  let s;
  try {
    s = snapshotSpec(spec);
  } catch (e) {
    const path = typeof e?.path === "string" ? e.path : "spec";
    return [{ kind: "refused", path, message: typeof e?.message === "string" ? clip(e.message, 400) : "invalid rubric: spec could not be read" }];
  }
  /** @type {{path: string, message: string}|null} */
  let whole = null; // what createRubric throws for the spec as a whole
  try {
    createRubric(s);
  } catch (e) {
    whole = { path: typeof e?.path === "string" ? e.path : "spec", message: e instanceof Error ? clip(e.message, 400) : "invalid rubric" };
  }

  // signed inputs: name -> sha256 (a malformed inputs list is a createRubric refusal, reported in `whole`; read what is readable)
  const signed = new Map();
  if (isPlain(s) && Array.isArray(s.inputs)) for (const i of s.inputs) if (isPlain(i) && typeof i.name === "string" && typeof i.sha256 === "string" && !signed.has(i.name)) signed.set(i.name, i.sha256);
  const inputNames = new Set(signed.keys());

  // pass 1: every check, in order, with its own createRubric refusal when it is a cells-family check
  const cps = isPlain(s) && isPlain(s.checkpoints) ? Object.keys(s.checkpoints) : [];
  /** @type {any[]} */
  const entries = [];
  cps.forEach((cpId, ci) => {
    const cp = s.checkpoints[cpId];
    if (!isPlain(cp) || !Array.isArray(cp.checks)) return;
    cp.checks.forEach((c, n) => {
      /** @type {{ci: number, cpId: string, n: number, c: any, id: string|undefined, refused: {path: string, message: string}|null, cells: boolean}} */
      const e = { ci, cpId, n, c, id: isPlain(c) && typeof c.id === "string" ? clip(c.id, CLIP) : undefined, refused: null, cells: false };
      if (isPlain(c) && typeof c.rule === "string" && CELLS_RULES.includes(c.rule)) {
        e.cells = true;
        e.refused = checkRefusal(c, `spec.checkpoints.${cpId}.checks[${n}]`, inputNames);
      }
      entries.push(e);
    });
  });
  const cellsRefused = entries.some((e) => e.refused !== null);

  // problems with no check come first; checks' problems are ordered by (checkpoint, check index)
  const front = [];
  const tableLevel = [];
  const perCheck = []; // { ci, n, rank, p }
  // remove-and-retry on the REAL spec (createRubric stops at its first refusal): see removalRefusals
  let truncated = false;
  // An id with `.`, `[` or `]` makes a createRubric path ambiguous (`spec.checkpoints.a.checks[0]` is check a[0] or checkpoint "a.checks[0]"):
  // text cannot say which, so such a spec gets the one createRubric refusal UNPLACED and no remove-and-retry (stated limit).
  const oddIds = cps.some((id) => /[.[\]]/.test(id));
  if (whole !== null && oddIds) {
    if (!entries.some((e) => e.refused !== null && e.refused.path === whole.path)) // a cells-family check's own refusal is already reported, placed
       front.push({ kind: "refused", path: whole.path, message: whole.message });
  } else if (whole !== null) {
    const r = removalRefusals(s, whole, cps, entries);
    if (r.front !== null) {
      if (r.front.ci === undefined) front.push(r.front.p);
      else perCheck.push(r.front);
    }
    for (const x of r.checks) perCheck.push(x);
    truncated = r.truncated;
  }

  const seen = new Set();
  const states = new Map();
  const stateOf = (name) => {
    let st = states.get(name);
    if (st === undefined) states.set(name, (st = tableState(tables, name)));
    return st;
  };
  const touch = (name) => { // table-level problems, once per table, in the order tables are first read
    if (seen.has(name)) return;
    seen.add(name);
    const st = stateOf(name);
    if (st === "unreadable") tableLevel.push({ kind: "unreadable-table", table: name });
    else if (st !== "absent" && signed.has(name) && signed.get(name) !== st.sha) tableLevel.push({ kind: "sha-mismatch", table: name });
  };

  for (const e of entries) {
    if (!e.cells) continue;
    const loc = { checkpoint: e.cpId, index: e.n, ...(e.id !== undefined ? { id: e.id } : {}) };
    if (e.refused !== null) {
      perCheck.push({ ci: e.ci, n: e.n, rank: 0, p: { kind: "refused", ...loc, path: e.refused.path, message: clip(e.refused.message, 400) } });
      continue;
    }
    const c = e.c;
    const diff = c.rule === "diff";
    const first = diff ? c.before : c.table;
    touch(first);
    if (diff) touch(c.after);
    const st1 = stateOf(first);
    if (st1 === "absent") perCheck.push({ ci: e.ci, n: e.n, rank: 1, p: { kind: "no-table", ...loc, table: first } });
    // which header each field is read in (verified against runDiff): diff keyColumn in both; a newColumnRule's other fields in the AFTER one
    for (const ref of columnRefs(c)) {
      /** @type {string[]} */
      const homes = !diff ? [first] : ref.field === "keyColumn" ? [first, c.after] : [c.after];
      for (const name of homes) {
        const st = stateOf(name);
        if (st === "absent" || st === "unreadable") continue;
        if (!st.header.includes(ref.column)) {
          perCheck.push({ ci: e.ci, n: e.n, rank: 2, p: { kind: "not-a-column", ...loc, table: name, column: clip(ref.column, CLIP), field: ref.field } });
          break; // one problem per field
        }
      }
    }
  }
  for (const name of signed.keys()) touch(name); // a signed table nobody reads is still compared

  // fail-closed backstop: createRubric threw on the untouched spec, so the list must carry a `refused`; if nothing placed it, report it as-is
  if (whole !== null && !front.some((p) => p.kind === "refused") && !perCheck.some((x) => x.p.kind === "refused")) front.push({ kind: "refused", path: whole.path, message: whole.message });
  perCheck.sort((a, b) => a.ci - b.ci || a.n - b.n || a.rank - b.rank); // stable: fields keep COLUMN_FIELDS order
  return [...front, ...tableLevel, ...perCheck.map((x) => x.p), ...(truncated ? [{ kind: "truncated", limit: MAX_REFUSED }] : [])];
}

const MAX_REFUSED = 20; // check refusals found by remove-and-retry; one more is a `truncated` problem

/**
 * The ONE place a createRubric error path is resolved to a checkpoint (and a check). A checkpoint id may itself contain `.checks[`, so
 * `spec.checkpoints.a.checks[1].id` can be check 1 of `a` OR field `id` of a checkpoint named `a.checks[1]`. Rule: the candidate that
 * consumes the LONGEST prefix owns the path, whatever the key order. Candidates are a checkpoint (`spec.checkpoints.<id>` then end, `.`
 * or `[`) and a check (`spec.checkpoints.<id>.checks[<k>]` then end, `.` or `[`). A check candidate is dropped when what follows it is a
 * checkpoint field (`checks`, `gating`, `requiresHuman`, `accept`): no check rule has a field of those names (checkKeys + rubricVocabulary
 * rules), so a longer checkpoint id that matches is then the true owner. The one genuine tie, a path that ends exactly at
 * `...<id>.checks[<k>]`, goes to the check, independent of key order, but only when check <k> EXISTS: `count(cpId)` is the number of checks the
 * caller resolves against (the original list in `locate`; the CURRENT, shrunk copy in the remove-and-retry loop, which is what createRubric
 * was just asked about). Otherwise the path falls to the checkpoint that bears that name.
 * @param {string} path
 * @param {string[]} cps
 * @param {(cpId: string) => number} count
 * Only called when no checkpoint id contains `.`, `[` or `]` (`buildProblems` refuses to place anything otherwise): then `spec.checkpoints.<id>`
 * followed by an edge character names exactly one id, a check path exactly one (id, k), and the tie rules below never fire.
 * @returns {{ci: number, cpId: string, k: number|null}|null} k is null for a checkpoint-level path; null when no checkpoint owns it
 */
function resolvePath(path, cps, count) {
  const edge = (c) => c === undefined || c === "." || c === "[";
  let best = null;
  let bestLen = -1;
  for (let ci = 0; ci < cps.length; ci++) {
    const head = `spec.checkpoints.${cps[ci]}`;
    if (!path.startsWith(head) || !edge(path[head.length])) continue;
    if (head.length > bestLen) { best = { ci, cpId: cps[ci], k: null }; bestLen = head.length; }
    const m = /^\.checks\[(\d+)\]/.exec(path.slice(head.length));
    if (m === null) continue;
    const end = head.length + m[0].length;
    if (+m[1] >= count(cps[ci]) || !edge(path[end]) || /^\.(checks|gating|requiresHuman|accept)(?![^.[])/.test(path.slice(end))) continue;
    if (end >= bestLen) { best = { ci, cpId: cps[ci], k: +m[1] }; bestLen = end; }
  }
  return best;
}

/** The check a createRubric path points into: { cpId, k } with k the index in the CURRENT checks list, or null (spec- or checkpoint-level). */
function checkAt(path, cps, count) {
  const r = resolvePath(path, cps, count);
  return r !== null && r.k !== null ? { cpId: r.cpId, k: r.k } : null;
}

/**
 * createRubric stops at its first refusal. Report the rest by remove-and-retry on the REAL spec (its inputs, checkpoints and neighbouring
 * checks are all there, so a sound check is never refused for lacking context): record the refusal, take that check out of a copy, ask
 * createRubric again; stop when it passes, when the refusal is not inside a check, or at MAX_REFUSED. A non-check refusal counts only on the
 * untouched spec (after a removal it can be an artifact, such as an empty checkpoint, and is dropped). Cells-family refusals are already known
 * (`e.refused`): those checks are taken out first and never reported twice. A checkpoint a removal empties stays (createRubric accepts it).
 */
function removalRefusals(s, first, cps, entries) {
  /** @type {{ front: any, checks: any[], truncated: boolean }} */
  const out = { front: null, checks: [], truncated: false };
  try {
    const known = new Map(entries.map((e) => [`${e.cpId}\u0000${e.n}`, e]));
    /** @type {Map<string, number[]>} the original indexes still in each checkpoint's checks, in order */
    const alive = new Map();
    for (const e of entries) {
      const list = alive.get(e.cpId) ?? [];
      alive.set(e.cpId, list);
      list.push(e.n);
    }
    const count = (cpId) => alive.get(cpId)?.length ?? 0; // the CURRENT copy's check counts (untouched spec on the first call)
    const at0 = checkAt(first.path, cps, count);
    if (at0 === null) {
      out.front = locate(first, cps, entries); // spec- or checkpoint-level on the untouched spec: reported once
      return out;
    }
    const aliveOrig = (cpId, k) => alive.get(cpId)?.[k];
    const take = (cpId, orig) => alive.set(cpId, (alive.get(cpId) ?? []).filter((i) => i !== orig));
    const record = (err, loc) => {
      const orig = aliveOrig(loc.cpId, loc.k);
      const e = known.get(`${loc.cpId}\u0000${orig}`);
      const now = `spec.checkpoints.${loc.cpId}.checks[${loc.k}]`;
      const real = `spec.checkpoints.${loc.cpId}.checks[${orig}]`;
      if (e !== undefined && e.refused === null) {
        const path = err.path.startsWith(now) ? real + err.path.slice(now.length) : err.path;
        out.checks.push({ ci: e.ci, n: orig, rank: 0, p: { kind: "refused", checkpoint: loc.cpId, index: orig, ...(e.id !== undefined ? { id: e.id } : {}), path, message: err.message.split(now).join(real) } });
      }
      return orig;
    };
    const copy = () => {
      const checkpoints = Object.create(null);
      for (const cpId of cps) {
        const cp = s.checkpoints[cpId];
        const keep = alive.get(cpId);
        if (keep === undefined) checkpoints[cpId] = cp;
        else checkpoints[cpId] = Object.assign(Object.create(null), cp, { checks: keep.map((i) => cp.checks[i]) });
      }
      return Object.assign(Object.create(null), s, { checkpoints });
    };
    // the first refusal sits in a check of the untouched spec: record it, then take it out with every cells-family refusal already known
    /** @type {{cpId: string, k: number}|null} */
    let loc = at0;
    const orig0 = record(first, loc);
    const gone = [];
    for (const e of entries) if (e.refused !== null) gone.push([e.cpId, e.n]);
    if (orig0 !== undefined) gone.push([loc.cpId, orig0]);
    for (const [cpId, n] of gone) take(cpId, n);
    while (out.checks.length < MAX_REFUSED) {
      try {
        createRubric(copy());
        return out;
      } catch (e) {
        const err = { path: typeof e?.path === "string" ? e.path : "spec", message: e instanceof Error ? clip(e.message, 400) : "invalid rubric" };
        loc = checkAt(err.path, cps, count);
        if (loc === null || aliveOrig(loc.cpId, loc.k) === undefined) return out; // not inside a check: an artifact of the removals
        const o = record(err, loc);
        take(loc.cpId, o);
      }
    }
    try {
      createRubric(copy());
    } catch (e) {
      const l = typeof e?.path === "string" ? checkAt(e.path, cps, count) : null;
      out.truncated = l !== null && aliveOrig(l.cpId, l.k) !== undefined;
    }
  } catch {
    // an unreadable spec is reported as today: what was found stays
  }
  return out;
}

/** Place the one createRubric refusal at the check or checkpoint its path names, else at the front. */
function locate(whole, cps, entries) {
  const base = { kind: "refused", path: whole.path, message: whole.message };
  const counts = new Map();
  for (const e of entries) counts.set(e.cpId, (counts.get(e.cpId) ?? 0) + 1);
  const r = resolvePath(whole.path, cps, (cpId) => counts.get(cpId) ?? 0);
  if (r === null) return { ci: undefined, n: -1, rank: 0, p: base };
  if (r.k !== null) {
    const e = entries.find((x) => x.cpId === r.cpId && x.n === r.k);
    if (e !== undefined) return { ci: e.ci, n: e.n, rank: 0, p: { ...base, checkpoint: e.cpId, index: e.n, ...(e.id !== undefined ? { id: e.id } : {}) } };
  }
  return { ci: r.ci, n: -1, rank: 0, p: { ...base, checkpoint: r.cpId } };
}

// --- checkSchema ----------------------------------------------------------------

const SCHEMA_RULES = ["cells", "table"];

/** The vocabulary field -> JSON schema mapping (cells-prd.md §11.4). `ctx` carries the enums; an unknown type THROWS so a new one cannot be dropped silently. */
function fieldSchema(name, d, ctx) {
  const withDesc = (o) => (typeof d.description === "string" ? { ...o, description: d.description } : o);
  const colEnum = () => ({ type: "string", enum: ctx.columns });
  switch (d.type) {
    case "name": // table / claim handled by the caller; any other name field is a bounded string
      return withDesc({ type: "string", minLength: 1, maxLength: d.maxLength });
    case "string":
      return d.columnAt === "self" ? withDesc(colEnum()) : withDesc({ type: "string", maxLength: d.maxLength });
    case "operand": // a: a column name; b: a column name or { const: finite number }
      return name === "b"
        ? withDesc({ anyOf: [colEnum(), { type: "object", properties: { const: { type: "number" } }, required: ["const"], additionalProperties: false }] })
        : withDesc(colEnum());
    case "cell":
      return withDesc({ type: "object", properties: { column: colEnum(), row: { type: "integer", minimum: 2 } }, required: ["column", "row"], additionalProperties: false });
    case "condition-list": {
      const lit = { anyOf: [{ type: "number" }, { type: "string" }] };
      return withDesc({
        type: "array", minItems: 1, maxItems: SIGNED_LIMITS.conds,
        items: { type: "object", properties: { column: colEnum(), cmp: { type: "string", enum: [...d.cmps] }, value: lit, lo: lit, hi: lit }, required: ["column", "cmp"], additionalProperties: false },
      });
    }
    case "date-format-list":
      return withDesc({
        type: "array", minItems: 1, maxItems: SIGNED_LIMITS.dateFormats,
        items: { type: "object", properties: { column: colEnum(), format: { type: "string", enum: [...rubricVocabulary.cells.dateFormats] } }, required: ["column", "format"], additionalProperties: false },
      });
    case "band-list":
      return withDesc({
        type: "array", minItems: 1, maxItems: SIGNED_LIMITS.bands,
        items: { type: "object", properties: { name: { type: "string", maxLength: SIGNED_LIMITS.name }, gt: { type: "number" }, gte: { type: "number" }, lt: { type: "number" }, lte: { type: "number" } }, required: ["name"], additionalProperties: false },
      });
    case "range":
      return withDesc({ type: "object", properties: { from: { type: "integer", minimum: 2 }, to: { type: "integer", minimum: 2 } }, required: ["from", "to"], additionalProperties: false });
    case "integer":
      return withDesc({ type: "integer", ...(d.min !== undefined ? { minimum: d.min } : {}) });
    case "number":
      return withDesc({ type: "number" });
    case "boolean":
      return withDesc({ type: "boolean" });
    case "enum":
      return withDesc({ type: "string", enum: [...d.enum] });
    case "date": // the format is in the description only: some strict-schema providers refuse `pattern`; createRubric checks the real date
      return withDesc({ type: "string" });
    case "explanation":
      return { type: "string" };
    default:
      throw new Error(`checkSchema: vocabulary field ${name} has a type this builder does not map (${String(d.type)})`);
  }
}

function stringArray(v, what) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new TypeError(`checkSchema: ${what} must be an array of strings`);
  return [...new Set(v)];
}

/**
 * The JSON schema of ONE `cells` and/or `table` check, generated from `rubricVocabulary`: every column field an enum of the exact header
 * strings, `table` an enum of the table names, ONE `op` enum across the rules (no per-op `oneOf`), `additionalProperties: false`. The caller
 * wraps it (an array, `maxItems`, its own extra fields) and may drop properties; a dropped property must also be dropped from `required`.
 * Call it once per table (`tables: [name]`, that table's `columns`).
 * @param {{ rules: ("cells"|"table")[], columns: string[], tables: string[] }} args
 * @returns {object|null}
 * @when Reach for this when an AI must draft a `cells` or `table` check as structured output: it gives the exact schema for one check, so a column it names is one of the real headers and a table is one of the real tables, instead of you hand-writing (and drifting from) the field list. Build one schema per table, wrap it in your own array, and still run `createRubric` and `checkTables` on the result: a schema cannot say which fields an op requires.
 * @category rubric
 * @signature checkSchema(args: { rules: string[], columns: string[], tables: string[] }) => object | null
 * @fails Throws a TypeError only for caller misuse: `args` not an object, `rules` empty or holding anything but "cells" / "table", `columns` or `tables` not an array of strings. Returns null when `columns` or `tables` is empty (an empty enum cannot be built). Header strings of any shape (empty, "__proto__", very long) become plain enum data. A fresh object each call with a stable key order.
 * @example
 * import { checkSchema } from "bareguard";
 * const schema = checkSchema({ rules: ["cells", "table"], columns: ["Id", "Amount"], tables: ["invoices"] });
 * schema.properties.column.enum; // ["Id", "Amount"]
 */
export function checkSchema(args) {
  let rules, columns, tables;
  try {
    if (!isPlain(args)) throw new TypeError("checkSchema: args must be an object");
    rules = args.rules;
    columns = args.columns;
    tables = args.tables;
  } catch (e) {
    throw e instanceof TypeError ? e : new TypeError("checkSchema: args is unreadable");
  }
  if (!Array.isArray(rules) || rules.length === 0 || rules.some((r) => !SCHEMA_RULES.includes(r))) throw new TypeError('checkSchema: rules must be a non-empty array of "cells" and/or "table"');
  const ruleList = [...new Set(rules)];
  const cols = stringArray(columns, "columns");
  const tabs = stringArray(tables, "tables");
  if (cols.length === 0 || tabs.length === 0) return null;
  const ctx = { columns: cols };
  const vocab = rubricVocabulary.rules;
  const properties = {
    id: { type: "string", minLength: 1, maxLength: rubricVocabulary.common.id.maxLength },
    rule: { type: "string", enum: ruleList },
  };
  const ops = [];
  for (const rule of ruleList) {
    for (const op of Object.keys(vocab[rule].ops)) if (!ops.includes(op)) ops.push(op);
  }
  const required = ["id", "rule", "table", "op"];
  const seenFields = new Set(["id", "rule"]);
  for (const rule of ruleList) {
    for (const [name, d] of Object.entries(vocab[rule].fields)) {
      if (seenFields.has(name)) continue;
      seenFields.add(name);
      if (name === "table") properties.table = { type: "string", enum: tabs, description: d.description };
      else if (name === "claim") properties.claim = { type: "string", minLength: 1, maxLength: d.maxLength, description: d.description };
      else if (name === "op") properties.op = { type: "string", enum: ops, description: d.description };
      else properties[name] = fieldSchema(name, d, ctx);
    }
  }
  if (ruleList.length === 1 && ruleList[0] === "cells") required.push("claim");
  return { type: "object", properties, required, additionalProperties: false };
}

// --- claimSchema ----------------------------------------------------------------

/**
 * The JSON schema of the claim a `cells` check expects (the object the worker puts under the check's `claim` field name), exact to the
 * strict claim types: JS numbers only (never numeric strings), integer row numbers (minimum 2), `"<row>"` map keys as digit strings,
 * and, where the check's signed `valueKind` decides it, text versus number. Generated from the same table the vocabulary's `claim` prose
 * comes from, so the schema and the claim reader cannot drift.
 * @param {object} check a signed or drafted `cells` check (a plain object; not mutated)
 * @returns {object|null}
 * @when Reach for this when a worker must hand back a `cells` claim as structured output: it gives the exact schema of that one check's answer box, so a numeric string or a float row number is impossible instead of a red `claim-malformed` after a retry. Per check only: a caller that puts several claims in one box merges the schemas itself.
 * @category rubric
 * @signature claimSchema(check: object) => object | null
 * @fails Never throws. Returns null for a `table` or `diff` check (they have no claim), anything that is not a valid `cells` check (unknown op, a missing field, a hostile object), and a non-object. It also returns null for a check carrying a field bareguard does not know (a caller's own `covers`, say): the validator refuses any unrecognised field, so pass the bareguard-shaped check and strip your own fields first. A fresh object each call. A box that offers exactly one key (every single-form op, and `rows` without `keyColumn`) lists it in `required`. An op with two alternative keys (`rows` with `keyColumn`, `topN`, `duplicates`) gets `minProperties: 1` and an `anyOf` of one `required` per key (so an empty box `{}` is rejected); it allows both together (no `oneOf`), and both present stays red `claim-malformed` at `checkStep`. Keywords emitted, exactly: `type`, `properties`, `required`, `additionalProperties` (`false`, or a schema for the row-number maps of `band` / `daysSince`), `items`, `minimum`, `minProperties`, `anyOf`, `propertyNames` with a `pattern`, and `description`. A provider that rejects `propertyNames`, a schema-valued `additionalProperties`, `minProperties` or a root `anyOf` will refuse the `band`, `daysSince`, `rows`, `topN` and `duplicates` boxes; bareguard does not emit a reduced subset.
 * @example
 * import { claimSchema } from "bareguard";
 * claimSchema({ id: "n", rule: "cells", table: "t", claim: "answer", op: "sum", column: "Amount" });
 * // { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }
 */
export function claimSchema(check) {
  try {
    const c = snapshotSpec(check); // a null-prototype plain-data copy; refuses anything hostile or not JSON
    return claimSchemaOf(c);
  } catch {
    return null;
  }
}
