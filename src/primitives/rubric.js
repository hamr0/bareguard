// rubric primitive (Module 1: the PURE core) — see docs/product/rubric-prd.md.
//
// A rubric is a signed list of deterministic checks bound to a goal. This module
// validates a spec, fingerprints it, runs the checks over an output, and mints a
// verdict (green | red | stopped) with structured gaps or a fault. It runs no
// model, no command, no git, and NO user regex (Law 5): every comparison is
// bareguard's own code over typed fields, or a number/exit the CALLER measured
// (Law 11). It holds no state and is not wired to the Gate yet.
//
// Day-1 scope only: the judge path (`judged`, `locate`/`verdict`, soft-green,
// `reads`/`agree`) is NOT here. A `judged` check is refused at createRubric as an
// unknown check type, and `checkStep` refuses a `judge` option rather than
// silently ignoring it.
//
// ONE rule table (RULES) drives validation, dispatch AND the exported
// `rubricVocabulary` — the vocabulary cannot drift from what is implemented.

import { createHash } from "node:crypto";
import path from "node:path";
import { resolveWithSymlinks, findSymlinkComponent, within, norm } from "./fs.js";

/**
 * @typedef {Object} Gap
 * A red check, as data for the worker's retry. `key` is `${checkpoint}:${checkId}`
 * and is stable across retries; ordered rules carry `direction`. Lists are bounded.
 * @property {string} key
 * @property {string} checkpoint
 * @property {string} check the rule name
 * @property {string} id the check id
 * @property {string} [field]
 * @property {string} [kind]
 * @property {string|number} [measured]
 * @property {string|number} [limit]
 * @property {string} [direction]
 * @property {string[]} [items]
 * @property {number} [itemsTotal] set only when `items` was truncated
 *
 * @typedef {Object} Fault
 * An instrument failure (`stopped`): for the runner, never the worker.
 * @property {string} key
 * @property {string} checkpoint
 * @property {string} id
 * @property {"exception"|"liveness"|"missing-measurement"|"unknown-pattern"|"baseline-conflict"} kind
 * @property {string} detail bounded
 *
 * @typedef {Object} Check
 * One signed check: `{ id, rule, ...fields }` — the fields are listed per rule in `rubricVocabulary`.
 * @property {string} id
 * @property {string} rule
 *
 * @typedef {Object} Rubric
 * A frozen, validated spec (the `createRubric` return value). Same shape as the spec.
 * @property {number} schema
 * @property {string} goal
 * @property {Object<string, {gating: boolean, requiresHuman?: true, checks: Check[]}>} checkpoints
 *
 * @typedef {Object} StepResult
 * @property {"green"|"red"|"stopped"} verdict
 * @property {string} checkpoint
 * @property {string} rubricSha
 * @property {string|null} outputSha sha256 (hex) of `opts.outputBytes`, else of a string output's UTF-8 bytes; null for an object output with no `outputBytes`
 * @property {Gap[]} gaps what the worker may see; [] unless red
 * @property {Fault|null} fault the first fault, when stopped
 * @property {{gaps: Gap[], faults: Fault[]}} full everything, for the audit and the human
 * @property {Object<string, {baseline:number, baselineSource:{anchor:string, route:string}}>} baselines seed baselines this call measured, for the caller/gate to record
 * @property {Object<string, {count:number, sha256:string}>} callerItems caller item lists this call used (count + sha256 of the JSON list), for the audit
 */

// --- constants ---------------------------------------------------------------

const MAX_NAME_LEN = 128; // ids, checkpoint ids, field names (they land in keys and audit lines)
const SOURCE_CAP_BYTES = 5 * 1024 * 1024; // PRD §4.2 / ruling 2026-10-06 #7
const MAX_ITEMS = 20; // offender-list bound in a gap
const CLIP = 120; // a caller-MEASURED / output-derived string inside a gap (never a signed one)
const MAX_SIGNED_LEN = 1000; // a signed name/phrase/value is refused past this at createRubric, so it rides a gap UNCLIPPED
const FAULT_DETAIL_CLIP = 200;
const MAX_LIST = 100_000; // caller/output list we will walk (each filesChanged path costs an lstat)
const MAX_SNAPSHOT_DEPTH = 16;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FOUNDATIONAL_IDS = new Set(["happened", "clean", "agree", "signed"]);
const SHA_HEX = /^[0-9a-f]{64}$/;

// --- small helpers -----------------------------------------------------------

function fail(where, msg) {
  const e = new Error(`invalid rubric: ${where} ${msg}`);
  /** @type {any} */ (e).path = where;
  return e;
}

function clip(s, n = CLIP) {
  let str = typeof s === "string" ? s : String(s);
  if (str.length <= n) return str;
  let end = n;
  const c = str.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--; // never cut a surrogate pair in half
  return str.slice(0, end);
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function blank(s) {
  return typeof s !== "string" || s.trim() === "";
}

function deepFreeze(o) {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

// --- snapshot + canonical form + sha ----------------------------------------

/**
 * Deep copy a JSON-shaped value onto NULL-PROTOTYPE objects. Refuses (throws)
 * anything not plain JSON data: undefined, NaN/±Infinity, bigint, functions,
 * symbols, class instances, `__proto__`/`constructor`/`prototype` keys, a hostile
 * getter/Proxy that throws, or nesting past MAX_SNAPSHOT_DEPTH (which also bounds
 * a cycle). Every value is read exactly once, so later validation sees what the
 * hash saw.
 */
function snapshot(v, where, depth) {
  if (depth > MAX_SNAPSHOT_DEPTH) throw fail(where, "is nested too deeply (or cyclic)");
  if (v === null) return null;
  const t = typeof v;
  if (t === "string" || t === "boolean") return v;
  if (t === "number") {
    if (!Number.isFinite(v)) throw fail(where, "must be a finite number, not NaN/Infinity");
    return v;
  }
  if (t !== "object") throw fail(where, `has an unsupported type (${t})`);
  try {
    if (Array.isArray(v)) {
      const out = [];
      const len = v.length;
      if (!Number.isInteger(len) || len > MAX_LIST) throw fail(where, "is an array that is too long");
      for (let i = 0; i < len; i++) out.push(snapshot(v[i], `${where}[${i}]`, depth + 1));
      return out;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw fail(where, "must be a plain object");
    const out = Object.create(null);
    for (const k of Object.keys(v)) {
      if (RESERVED_KEYS.has(k)) throw fail(`${where}.${k}`, "is a reserved key name");
      out[k] = snapshot(v[k], `${where}.${k}`, depth + 1);
    }
    return out;
  } catch (e) {
    if (e instanceof Error && /** @type {any} */ (e).path !== undefined) throw e;
    throw fail(where, `is unreadable (${clip(e instanceof Error ? e.message : "threw")})`);
  }
}

function canon(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

const BRANDED = new WeakSet(); // objects returned by createRubric()
const SHA_CACHE = new WeakMap();

/**
 * The fingerprint a human signs: sha256 (hex) over a CANONICAL serialization of
 * the whole spec — JSON with object keys sorted by UTF-16 code unit at every
 * depth, arrays in order, no whitespace. So key order never matters and any
 * changed value does. Accepts a raw spec or a `createRubric` result (same hash).
 * @param {object} spec
 * @returns {string}
 * @when Reach for this to get the fingerprint of a rubric spec — the value the human signs and the gate verifies — or to check that a harness's projection of a larger signed spec hashes the same fields. It covers EVERYTHING in the spec (goal, inputs, judge identity, every check), so any edit forces a re-sign.
 * @category rubric
 * @signature rubricSha(spec: object) => string
 * @fails Throws on a spec that is not plain JSON data: undefined, NaN/Infinity, a function/bigint/symbol, a class instance, a `__proto__`/`constructor`/`prototype` key, a throwing getter or Proxy, or nesting past 16 levels. Canonical form: sorted keys, JSON scalars; `-0` hashes as `0`. It does NOT validate the spec's meaning — that is `createRubric`.
 * @example
 * import { rubricSha } from "bareguard";
 * rubricSha({ schema: 1, goal: "g", checkpoints: {} }) === rubricSha({ checkpoints: {}, goal: "g", schema: 1 }); // true
 */
export function rubricSha(spec) {
  if (spec !== null && typeof spec === "object" && SHA_CACHE.has(spec)) return SHA_CACHE.get(spec);
  const copy = BRANDED.has(/** @type {object} */ (spec)) ? spec : snapshot(spec, "spec", 0);
  const sha = sha256Hex(canon(copy));
  if (BRANDED.has(/** @type {object} */ (spec))) SHA_CACHE.set(/** @type {object} */ (spec), sha);
  return sha;
}

// --- the rule table ----------------------------------------------------------

const STRICT = { type: "boolean", required: false, default: false };
const FIELD = { type: "name", required: true, nonBlank: true, maxLength: MAX_NAME_LEN };
const COUNT = { type: "integer", required: true, min: 1, max: null };
const LIST = { type: "string-list", required: true, minItems: 1, itemType: "string", nonBlank: true, itemMaxLength: MAX_SIGNED_LEN };
const OPT_LIST = { ...LIST, required: false };
const NONE_EXIT = { type: "integer", required: false };
// `text` on EVERY check is the signer's explanation only (Law 6): optional, a string, never decides.
const EXPLAIN = { type: "explanation", required: false };
const DIRECTION = { type: "enum", required: true, enum: ["lower-is-better", "higher-is-better"] };

const OK = Object.freeze({});

function red(kind, more = {}) {
  return { gap: { kind, ...more } };
}
function stop(kind, detail) {
  return { fault: { kind, detail: clip(detail, FAULT_DETAIL_CLIP) } };
}

// ---- reading the output (a failure here is RED, Law 1) ----

function readField(ctx, name) {
  try {
    if (!Object.hasOwn(ctx.fields, name)) return { missing: true };
    return { value: ctx.fields[name] };
  } catch {
    return { unreadable: true };
  }
}

/** The field as a string, or a red result. `base` carries limit/direction for ordered rules. */
function textField(ctx, name, base = {}) {
  const r = readField(ctx, name);
  if (r.unreadable) return red("unreadable", base);
  if (r.missing) return red("missing", base);
  if (typeof r.value !== "string") return red("wrong-type", { ...base, measured: typeName(r.value) });
  return { text: r.value };
}

function typeName(v) {
  if (v === null) return "type:null";
  if (Array.isArray(v)) return "type:array";
  return `type:${typeof v}`;
}

function describeNumber(v) {
  return typeof v === "number" ? String(v) : typeName(v); // "NaN", "Infinity", "-Infinity" or "type:string"
}

// ---- text rules ----

function splitLines(text) {
  return text.split(/\r?\n/);
}

function stripLeadingHashes(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 35) i++; // '#'
  return i === 0 ? line : line.slice(i).trimStart();
}

/**
 * `markers` true = count a leading '#' run as a word (only `maxWords` strict does);
 * false = strip it (forgiving, and `minWords` in BOTH modes). The raw count is never
 * below the stripped one, so strict can only make `maxWords` stricter, and `minWords`
 * strict is exactly forgiving: strict is never the looser result in either direction.
 */
function countWords(text, markers) {
  let n = 0;
  for (const line of splitLines(text)) {
    const s = (markers ? line : stripLeadingHashes(line)).trim();
    if (s !== "") n += s.split(/\s+/).length;
  }
  return n;
}

function countNonEmptyLines(text) {
  let n = 0;
  for (const line of splitLines(text)) if (line.trim() !== "") n++;
  return n;
}

/** Forgiving heading line (PRD §4.1): '#'-run, trailing ':' stripped, trimmed, lowercased. "" = not a heading. */
function forgivingHeading(line) {
  let s = stripLeadingHashes(line).trimEnd();
  if (s.endsWith(":")) s = s.slice(0, -1);
  return s.trim().toLowerCase();
}

/**
 * Strict ATX heading: after `#{1,6}` and one or more spaces, the REST of the line is
 * the heading text, exactly (no closing-`#` stripping, no trimming). null when the line
 * is not one, or the rest is empty. Hand-coded and linear (no backtracking regex).
 */
function strictHeading(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h < 1 || h > 6 || line.charCodeAt(h) !== 32) return null;
  let s = h;
  while (line.charCodeAt(s) === 32) s++;
  return s >= line.length ? null : line.slice(s);
}

/**
 * The comparable keys of the heading lines, in order. Forgiving: the forgiving heading
 * text. Strict: a (forgiving, strict) pair, so a strict name matches only when BOTH the
 * exact strict text AND the forgiving text match: strict can never be looser than
 * forgiving (a name ending in ':' therefore matches in neither mode).
 */
function headingsOf(text, strict) {
  const out = [];
  for (const line of splitLines(text)) {
    if (strict) {
      const sh = strictHeading(line);
      if (sh !== null) out.push(JSON.stringify([forgivingHeading(line), sh]));
    } else {
      const h = forgivingHeading(line);
      if (h !== "") out.push(h);
    }
  }
  return out;
}

function nameKey(name, strict) {
  const f = name.trim().toLowerCase();
  return strict ? JSON.stringify([f, name]) : f;
}

// `signed`: the items are values the signer wrote (names, phrases, ids); they ride a gap UNCLIPPED (bounded at
// createRubric), because the worker must be able to reproduce them. Measured / output-derived items are clipped.
function boundItems(items, signed = false) {
  const list = items.slice(0, MAX_ITEMS).map((s) => (signed ? String(s) : clip(s)));
  return items.length > MAX_ITEMS ? { items: list, itemsTotal: items.length } : { items: list };
}

function runSections(ctx, c) {
  const t = textField(ctx, c.field);
  if (t.gap) return t;
  const strict = c.strict === true;
  const heads = headingsOf(t.text, strict);
  if (strict && heads.length === 0) return red("no-headings");
  const set = new Set(heads);
  const missing = c.names.filter((n) => !set.has(nameKey(n, strict)));
  if (missing.length === 0) return OK;
  return red("missing", { measured: missing.length, limit: c.names.length, ...boundItems(missing, true) });
}

function runSectionOrder(ctx, c) {
  const t = textField(ctx, c.field);
  if (t.gap) return t;
  const strict = c.strict === true;
  const heads = headingsOf(t.text, strict);
  if (strict && heads.length === 0) return red("no-headings");
  /** @type {Map<string, number[]>} */
  const positions = new Map();
  heads.forEach((h, i) => {
    const l = positions.get(h);
    if (l) l.push(i);
    else positions.set(h, [i]);
  });
  const offenders = [];
  const kinds = new Set();
  let from = 0;
  for (const name of c.names) {
    const list = positions.get(nameKey(name, strict));
    if (!list) {
      offenders.push(`missing:${name}`);
      kinds.add("missing"); // the search position does NOT move past a missing name
      continue;
    }
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    if (lo === list.length) {
      offenders.push(`out-of-order:${name}`);
      kinds.add("out-of-order");
    } else {
      from = list[lo] + 1;
    }
  }
  if (offenders.length === 0) return OK;
  const kind = ["missing", "out-of-order"].filter((k) => kinds.has(k)).join(",");
  return red(kind, { measured: offenders.length, limit: c.names.length, ...boundItems(offenders, true) });
}

/** Forgiving: case-insensitive substring. Strict: ALSO an exact substring (so never looser). */
function carries(hay, hayLower, phrase, strict) {
  const f = hayLower.includes(phrase.toLowerCase());
  return strict ? f && hay.includes(phrase) : f;
}

function runMustCarry(ctx, c) {
  const t = textField(ctx, c.field);
  if (t.gap) return t;
  const strict = c.strict === true;
  const lower = t.text.toLowerCase();
  const missing = c.phrases.filter((p) => !carries(t.text, lower, p, strict));
  return missing.length === 0 ? OK : red("missing", boundItems(missing, true));
}

function runBlockLines(ctx, c) {
  const t = textField(ctx, c.field);
  if (t.gap) return t;
  const strict = c.strict === true;
  const lines = splitLines(t.text).filter((l) => l.trim() !== "");
  if (lines.length === 0) return red("zero-lines", { measured: 0, limit: c.size });
  const kinds = [];
  if (lines.length % c.size !== 0) kinds.push("not-multiple");
  const missing = [];
  for (let i = 0, b = 1; i < lines.length; i += c.size, b++) {
    const block = lines.slice(i, i + c.size).join(" ");
    const lower = block.toLowerCase();
    for (const p of c.phrases) if (!carries(block, lower, p, strict)) missing.push(`block ${b}:${p}`);
  }
  if (missing.length > 0) kinds.push("block-missing");
  if (kinds.length === 0) return OK;
  return red(kinds.join(","), { measured: lines.length, limit: c.size, ...(missing.length ? boundItems(missing, true) : {}) });
}

function runCountRule(measure, dir, over) {
  // dir: "at-most" | "at-least"; over(n, value) true when red
  return (ctx, c) => {
    const t = textField(ctx, c.field, { limit: c.value, direction: dir });
    if (t.gap) return t;
    const n = measure(t.text, c.strict === true);
    return over(n, c.value) ? red(dir === "at-most" ? "over" : "under", { measured: n, limit: c.value, direction: dir }) : OK;
  };
}

function runNonEmpty(ctx, c) {
  const r = readField(ctx, c.field);
  if (r.unreadable) return red("unreadable");
  if (r.missing) return red("missing");
  const v = r.value;
  try {
    if (typeof v === "string") return v.trim() !== "" ? OK : red("empty");
    if (Array.isArray(v)) return v.length > 0 ? OK : red("empty");
    if (v !== null && typeof v === "object") return Object.keys(v).length > 0 ? OK : red("empty");
  } catch {
    return red("unreadable");
  }
  return red("wrong-type", { measured: typeName(v) });
}

// ---- value rules ----

function runIn(want) {
  return (ctx, c) => {
    const r = readField(ctx, c.field);
    if (r.unreadable) return red("unreadable");
    if (r.missing) return red("missing");
    if (typeof r.value !== "string") return red("wrong-type", { measured: typeName(r.value) });
    const inList = c.values.includes(r.value);
    if (inList === want) return OK;
    return red(want ? "not-in" : "forbidden", { measured: clip(r.value), ...boundItems(c.values, true) });
  };
}

function runAtMost(ctx, c) {
  const base = { limit: c.value, direction: "at-most" };
  const r = readField(ctx, c.field);
  if (r.unreadable) return red("unreadable", base);
  if (r.missing) return red("missing", base);
  if (typeof r.value !== "string") return red("wrong-type", { ...base, measured: typeName(r.value) });
  const rank = c.order.indexOf(r.value);
  if (rank === -1) return red("unknown", { ...base, measured: clip(r.value) });
  return rank > c.order.indexOf(c.value) ? red("over", { ...base, measured: r.value }) : OK;
}

function runMaxMin(dir) {
  return (ctx, c) => {
    const base = { limit: c.value, direction: dir };
    const r = readField(ctx, c.field);
    if (r.unreadable) return red("unreadable", base);
    if (r.missing) return red("missing", base);
    const v = r.value;
    if (typeof v !== "number" || !Number.isFinite(v)) return red("not-finite-number", { ...base, measured: describeNumber(v) });
    const bad = dir === "at-most" ? v > c.value : v < c.value;
    return bad ? red(dir === "at-most" ? "over" : "under", { ...base, measured: v }) : OK;
  };
}

// ---- claims: cited / complete ----

function claimsOf(ctx, name) {
  const r = readField(ctx, name);
  if (r.unreadable) return { gap: { kind: "unreadable" } };
  if (r.missing) return { gap: { kind: "missing" } };
  let arr = null;
  try {
    if (Array.isArray(r.value)) {
      const len = r.value.length;
      if (len > MAX_LIST) return { gap: { kind: "too-many", measured: len, limit: MAX_LIST } };
      arr = [];
      for (let i = 0; i < len; i++) arr.push(r.value[i]);
    }
  } catch {
    return { gap: { kind: "unreadable" } };
  }
  if (arr === null) return { gap: { kind: "wrong-type", measured: typeName(r.value) } };
  return { claims: arr };
}

function ownString(o, key) {
  try {
    if (o === null || typeof o !== "object" || !Object.hasOwn(o, key)) return undefined;
    const v = o[key];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

function runCited(ctx, c) {
  const input = (ctx.rubric.inputs ?? []).find((i) => i.name === c.source);
  const text = lookup(getOpt(ctx, "inputs"), c.source);
  if (typeof text !== "string") return stop("missing-measurement", `opts.inputs[${c.source}] is missing or not a string`);
  if (sha256Hex(text) !== input.sha256) return stop("missing-measurement", `input ${c.source} does not match its signed sha256`);
  const cl = claimsOf(ctx, c.claims);
  if (cl.gap) return { gap: cl.gap };
  // A non-empty output that cites nothing is RED, never a vacuous green (independent of `complete`).
  if (cl.claims.length === 0) return red("no-claims", { measured: 0 });
  const tooBig = Buffer.byteLength(text, "utf8") > SOURCE_CAP_BYTES;
  const src = tooBig ? "" : normalizeForQuote(text);
  const bad = [];
  cl.claims.forEach((cc, i) => {
    const claim = ownString(cc, "claim");
    const quote = ownString(cc, "quote");
    if (claim === undefined || quote === undefined) return bad.push(`#${i}:malformed`);
    if (tooBig) return bad.push(`#${i}:source-too-large`);
    const q = normalizeForQuote(quote);
    if (q === "") return bad.push(`#${i}:empty-quote`);
    if (!src.includes(q)) return bad.push(`#${i}:quote-not-found`);
    const n = numbersInQuote(claim, quote);
    if (!n.ok) return bad.push(`#${i}:numbers:${n.missing.join(",")}`);
  });
  return bad.length === 0 ? OK : red("unsupported", { measured: bad.length, limit: cl.claims.length, ...boundItems(bad) });
}

function runComplete(ctx, c) {
  let items;
  if (c.items !== undefined) {
    items = c.items;
  } else {
    const list = lookup(getOpt(ctx, "items"), c.id);
    if (!Array.isArray(list) || list.length === 0) return stop("missing-measurement", `opts.items[${c.id}] is missing or empty`);
    if (list.length > MAX_LIST) return stop("exception", "caller item list too large");
    items = [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (typeof it !== "string" || it.trim() === "") return stop("missing-measurement", `opts.items[${c.id}][${i}] is not a non-empty string`);
      items.push(it);
    }
    ctx.callerItems[c.id] = { count: items.length, sha256: sha256Hex(JSON.stringify(items)) };
  }
  const cl = claimsOf(ctx, c.claims);
  if (cl.gap) return { gap: cl.gap };
  const covered = new Set();
  for (const cc of cl.claims) {
    const it = ownString(cc, "item");
    if (it !== undefined) covered.add(it);
  }
  const missing = items.filter((it) => !covered.has(it));
  return missing.length === 0 ? OK : red("uncovered", { measured: missing.length, limit: items.length, ...boundItems(missing, c.items !== undefined) });
}

// ---- caller-measured rules ----

function lookup(map, key) {
  if (map === null || typeof map !== "object") return undefined;
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function own(o, key) {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

function getOpt(ctx, key) {
  const r = ctx.opts[key];
  if (r && r.e !== undefined) throw r.e;
  return r ? r.v : undefined;
}

function measurementOf(ctx, c) {
  const m = lookup(getOpt(ctx, "measurements"), c.id);
  if (m === null || typeof m !== "object") return { stop: stop("missing-measurement", `opts.measurements[${c.id}] is missing`) };
  return { m };
}

/** Liveness proof (PRD §4.3). `scope` false = commandExit (only the exit is required). */
function proofStop(m, c, scope) {
  const exit = own(m, "exit");
  if (!Number.isInteger(exit)) return stop("missing-measurement", "exit is missing or not an integer");
  if (!scope) return null;
  const pre = own(m, "matchedPreScope");
  if (!Number.isInteger(pre) || pre < 0) return stop("missing-measurement", "matchedPreScope is missing or not a non-negative integer");
  const noneExit = c.noneExit;
  if (exit !== 0 && pre === 0 && !(noneExit !== undefined && exit === noneExit)) {
    return stop("liveness", `crashed tool: exit ${exit} with 0 matches before any scope filter — unknown, not zero`);
  }
  return null;
}

function runCommandExit(ctx, c) {
  const g = measurementOf(ctx, c);
  if (g.stop) return g.stop;
  const bad = proofStop(g.m, c, false);
  if (bad) return bad;
  const exit = own(g.m, "exit");
  const expect = c.expectExit === undefined ? 0 : c.expectExit;
  if (exit === expect) return OK;
  const lines = own(g.m, "outputLines");
  const out = Array.isArray(lines) ? lines.filter((l) => typeof l === "string").slice(0, MAX_ITEMS) : [];
  return red("exit", { measured: exit, limit: expect, ...(out.length ? { items: out.map((l) => clip(l)) } : {}) });
}

function runNotWorse(ctx, c) {
  const g = measurementOf(ctx, c);
  if (g.stop) return g.stop;
  const m = g.m;
  const bad = proofStop(m, c, true);
  if (bad) return bad;
  const value = own(m, "value");
  if (typeof value !== "number" || !Number.isFinite(value)) return stop("missing-measurement", "value is missing or not a finite number");
  let baseline;
  const passed = own(m, "baseline");
  if (c.baseline === "seed") {
    const src = own(m, "baselineSource");
    const anchor = src !== null && typeof src === "object" ? own(src, "anchor") : undefined;
    const route = src !== null && typeof src === "object" ? own(src, "route") : undefined;
    if (typeof passed !== "number" || !Number.isFinite(passed)) return stop("missing-measurement", "seed baseline is missing or not a finite number");
    if (blank(anchor) || blank(route)) return stop("missing-measurement", "baselineSource {anchor, route} is missing");
    const prior = lookup(getOpt(ctx, "priorBaselines"), c.id);
    if (prior !== undefined && prior !== passed) {
      return stop("baseline-conflict", `seed baseline ${passed} differs from the recorded ${String(prior)}`);
    }
    baseline = passed;
    ctx.baselines[c.id] = { baseline, baselineSource: { anchor: clip(anchor), route: clip(route) } };
  } else {
    if (passed !== undefined) return stop("baseline-conflict", "a per-call baseline is refused: the signed baseline is a literal");
    baseline = c.baseline;
  }
  const worse = c.direction === "lower-is-better" ? value > baseline : value < baseline;
  if (!worse) return OK;
  const terms = own(m, "terms");
  const items = [];
  if (c.terms !== undefined && Array.isArray(terms)) {
    for (const t of terms) {
      const id = t !== null && typeof t === "object" ? own(t, "id") : undefined;
      const contributes = t !== null && typeof t === "object" ? own(t, "contributes") : undefined;
      if (typeof id === "string" && c.terms.includes(id) && typeof contributes === "number" && Number.isFinite(contributes)) {
        items.push(`${id}=${contributes}`);
      }
    }
  }
  return red("worse", { measured: value, limit: baseline, direction: c.direction, ...(items.length ? boundItems(items, true) : {}) });
}

function runPatternAbsent(ctx, c) {
  const g = measurementOf(ctx, c);
  if (g.stop) return g.stop;
  const bad = proofStop(g.m, c, true);
  if (bad) return bad;
  const hits = own(g.m, "hits");
  if (!Array.isArray(hits)) return stop("missing-measurement", "hits is missing or not an array");
  if (hits.length > MAX_LIST) return stop("exception", "hit list too large");
  const items = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const id = h !== null && typeof h === "object" ? own(h, "id") : undefined;
    if (typeof id !== "string" || !c.patterns.includes(id)) return stop("unknown-pattern", `hit ${i} carries an id that is not in the signed pattern list`);
    items.push(`${id}@${clip(String(own(h, "path")), 80)}:${String(own(h, "line"))}`);
  }
  return items.length === 0 ? OK : red("present", { measured: items.length, limit: 0, ...boundItems(items) });
}

function runFilesChanged(ctx, c) {
  const g = measurementOf(ctx, c);
  if (g.stop) return g.stop;
  const bad = proofStop(g.m, c, true);
  if (bad) return bad;
  const paths = own(g.m, "paths");
  if (!Array.isArray(paths)) return stop("missing-measurement", "paths is missing or not an array");
  if (paths.length > MAX_LIST) return stop("exception", "path list too large");
  if (paths.length === 0) return c.requireNonEmpty ? red("empty") : OK;
  // Prefixes resolve physically, fresh, with bareguard's fs resolver (fs.js). A prefix
  // that is, or sits under, a symlink would silently MOVE the scope: an instrument fault.
  const prefixes = [];
  for (let i = 0; i < c.allowPrefixes.length; i++) {
    const p = norm(c.allowPrefixes[i]);
    const link = findSymlinkComponent(p);
    if (link) return stop("exception", `allowPrefixes[${i}] is or contains a symlink (${link.at} ${link.why})`);
    const rr = resolveWithSymlinks(p);
    if ("error" in rr) return stop("exception", `allowPrefixes[${i}] cannot be resolved (${rr.error})`);
    prefixes.push({ lexical: p, resolved: rr.resolved });
  }
  const offenders = [];
  for (const raw of paths) {
    if (typeof raw !== "string" || raw === "" || !path.isAbsolute(raw)) {
      offenders.push(typeof raw === "string" ? raw : typeName(raw));
      continue;
    }
    const p = norm(raw);
    const rr = resolveWithSymlinks(p);
    const ok = !("error" in rr) && prefixes.some((x) => within(p, x.lexical) && within(rr.resolved, x.resolved));
    if (!ok) offenders.push(raw);
  }
  return offenders.length === 0 ? OK : red("outside-prefixes", { measured: offenders.length, limit: paths.length, ...boundItems(offenders) });
}

// --- the table ---------------------------------------------------------------

/**
 * rule -> { fields: descriptor map, run(ctx, check) -> {} | {gap} | {fault}, exactlyOne? }.
 * Every field a rule accepts is listed here and nowhere else.
 */
const RULES = {
  nonEmpty: { fields: { field: FIELD }, run: runNonEmpty },
  maxWords: { fields: { field: FIELD, value: COUNT, strict: STRICT }, run: runCountRule((t, strict) => countWords(t, strict), "at-most", (n, v) => n > v) },
  minWords: { fields: { field: FIELD, value: COUNT, strict: STRICT }, run: runCountRule((t) => countWords(t, false), "at-least", (n, v) => n < v) },
  maxLines: { fields: { field: FIELD, value: COUNT }, run: runCountRule(countNonEmptyLines, "at-most", (n, v) => n > v) },
  sections: { fields: { field: FIELD, names: LIST, strict: STRICT }, run: runSections },
  sectionOrder: { fields: { field: FIELD, names: LIST, strict: STRICT }, run: runSectionOrder },
  mustCarry: { fields: { field: FIELD, phrases: LIST, strict: STRICT }, run: runMustCarry },
  blockLines: { fields: { field: FIELD, size: COUNT, phrases: LIST, strict: STRICT }, run: runBlockLines },
  in: { fields: { field: FIELD, values: LIST }, run: runIn(true) },
  notIn: { fields: { field: FIELD, values: LIST }, run: runIn(false) },
  atMost: {
    fields: { field: FIELD, value: { type: "string", required: true, nonBlank: true, maxLength: MAX_SIGNED_LEN }, order: { ...LIST, unique: true } },
    run: runAtMost,
  },
  max: { fields: { field: FIELD, value: { type: "number", required: true } }, run: runMaxMin("at-most") },
  min: { fields: { field: FIELD, value: { type: "number", required: true } }, run: runMaxMin("at-least") },
  cited: {
    fields: { claims: FIELD, source: { type: "name", required: true, nonBlank: true, maxLength: MAX_NAME_LEN, ref: "input" } },
    run: runCited,
  },
  complete: {
    fields: { claims: FIELD, items: OPT_LIST, itemsFrom: { type: "enum", required: false, enum: ["caller"] } },
    exactlyOne: ["items", "itemsFrom"],
    run: runComplete,
  },
  // commandExit takes NO noneExit: it has no liveness scope, so the param would do nothing (refused at createRubric).
  commandExit: { fields: { expectExit: { type: "integer", required: false, default: 0 } }, run: runCommandExit },
  notWorse: {
    fields: {
      direction: DIRECTION,
      baseline: { type: "number-or-enum", required: true, enum: ["seed"] },
      noneExit: NONE_EXIT,
      terms: OPT_LIST,
    },
    run: runNotWorse,
  },
  patternAbsent: { fields: { patterns: LIST, noneExit: NONE_EXIT }, run: runPatternAbsent },
  filesChanged: {
    fields: { allowPrefixes: LIST, requireNonEmpty: { type: "boolean", required: true }, noneExit: NONE_EXIT },
    run: runFilesChanged,
  },
};

for (const r of Object.values(RULES)) r.fields.text = EXPLAIN;

// --- rubricVocabulary --------------------------------------------------------

function describeField(name, d) {
  if (d.type === "explanation") return `${name}?: string (the signer's explanation; never decides)`;
  let t = d.type === "string-list" ? `non-empty list of non-blank strings, each max ${d.itemMaxLength} chars` : d.type === "name" ? `non-blank string, max ${d.maxLength} chars` : d.type === "string" ? `non-blank string, max ${d.maxLength} chars` : d.type;
  if (d.type === "integer" && d.min !== undefined) t = `integer >= ${d.min}`;
  if (d.type === "number") t = "finite number";
  if (d.type === "enum") t = d.enum.map((e) => JSON.stringify(e)).join(" | ");
  if (d.type === "number-or-enum") t = `finite number | ${d.enum.map((e) => JSON.stringify(e)).join(" | ")}`;
  if (d.unique) t += ", no duplicates";
  const def = d.default !== undefined ? ` = ${JSON.stringify(d.default)}` : "";
  return `${name}${d.required ? "" : "?"}: ${t}${def}`;
}

/**
 * The one-line description of a rule, GENERATED from its vocabulary entry (never hand-written).
 * @param {string} rule
 * @returns {string}
 */
export function describeRule(rule) {
  if (!Object.hasOwn(RULES, rule)) throw new Error(`unknown rubric rule ${clip(rule)}`);
  const r = RULES[rule];
  const fields = Object.keys(r.fields).map((n) => describeField(n, r.fields[n]));
  const one = r.exactlyOne ? `; exactly one of ${r.exactlyOne.join(", ")}` : "";
  return `${rule}({ id, ${fields.join(", ")} })${one}`;
}

/**
 * Every Day-1 check type, machine-readable and frozen: field names, types,
 * required/optional, bounds (count fields are integers >= 1 with no maximum;
 * string lists are non-empty arrays of non-blank strings) and defaults (incl.
 * `strict`, default false). `description` is generated from the entry.
 * A text rule reads a string field; a plain-string output is the single field `text`.
 * @when Read this to draft a rubric: it lists the ONLY check types you may use and each one's exact fields. A drafted line that maps to none of them must be refused, never bent onto the nearest rule. Every description shown to a person should be generated from this, not hand-written.
 * @category rubric
 * @fails Plain frozen data; reading never throws, and mutating it throws in strict mode (it is deep-frozen). Day 1 lists the deterministic rules only — `judged`, `locate`/`verdict` judges and soft-green are not in it.
 * @example
 * import { rubricVocabulary } from "bareguard";
 * rubricVocabulary.rules.maxWords.fields.value; // { type: "integer", required: true, min: 1, max: null }
 */
export const rubricVocabulary = deepFreeze({
  schema: 1,
  common: {
    id: { type: "name", required: true, nonBlank: true, maxLength: MAX_NAME_LEN, unique: "within the checkpoint", forbidden: [":", ...FOUNDATIONAL_IDS] },
    rule: { type: "enum", required: true, enum: Object.keys(RULES) },
  },
  bounds: {
    count: { type: "integer", min: 1, max: null },
    stringList: { type: "string-list", minItems: 1, itemType: "string", nonBlank: true, itemMaxLength: MAX_SIGNED_LEN },
    signedString: { maxLength: MAX_SIGNED_LEN },
    name: { maxLength: MAX_NAME_LEN },
    quoteSourceMaxBytes: SOURCE_CAP_BYTES,
  },
  foundational: [
    { name: "happened", description: "the output exists and is readable: a non-empty string, or an object with at least one own key" },
  ],
  rules: Object.fromEntries(
    Object.keys(RULES).map((rule) => [
      rule,
      {
        description: describeRule(rule),
        fields: JSON.parse(JSON.stringify(RULES[rule].fields)),
        ...(RULES[rule].exactlyOne ? { exactlyOne: [...RULES[rule].exactlyOne] } : {}),
      },
    ]),
  ),
});

// --- createRubric ------------------------------------------------------------

function checkName(v, where, what = "must be a non-blank string") {
  if (blank(v)) throw fail(where, what);
  if (v.length > MAX_NAME_LEN) throw fail(where, `must be at most ${MAX_NAME_LEN} characters`);
}

function checkKeys(o, allowed, where) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw fail(`${where}.${k}`, "is not a recognised field");
}

function checkValue(d, v, where) {
  switch (d.type) {
    case "name":
      return checkName(v, where);
    case "string":
      if (blank(v)) throw fail(where, "must be a non-blank string");
      if (v.length > MAX_SIGNED_LEN) throw fail(where, `must be at most ${MAX_SIGNED_LEN} characters`);
      return;
    case "integer":
      if (!Number.isInteger(v) || (d.min !== undefined && v < d.min)) {
        throw fail(where, d.min !== undefined ? `must be an integer >= ${d.min}` : "must be an integer");
      }
      return;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) throw fail(where, "must be a finite number");
      return;
    case "boolean":
      if (typeof v !== "boolean") throw fail(where, "must be a boolean");
      return;
    case "explanation":
      if (typeof v !== "string") throw fail(where, "must be a string (the signer's explanation)");
      return;
    case "string-list": {
      if (!Array.isArray(v) || v.length < 1) throw fail(where, "must be a non-empty array of non-blank strings");
      v.forEach((s, i) => {
        if (blank(s)) throw fail(`${where}[${i}]`, "must be a non-blank string");
        if (s.length > MAX_SIGNED_LEN) throw fail(`${where}[${i}]`, `must be at most ${MAX_SIGNED_LEN} characters`);
      });
      if (d.unique && new Set(v).size !== v.length) throw fail(where, "must not contain duplicates");
      return;
    }
    case "enum":
      if (typeof v !== "string" || !d.enum.includes(v)) throw fail(where, `must be one of ${d.enum.map((e) => JSON.stringify(e)).join(", ")}`);
      return;
    case "number-or-enum":
      if (typeof v === "number" && Number.isFinite(v)) return;
      if (typeof v === "string" && d.enum.includes(v)) return;
      throw fail(where, `must be a finite number or ${d.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    default:
      throw fail(where, "has an unknown field type");
  }
}

function validateCheck(c, where, inputNames) {
  if (c === null || typeof c !== "object" || Array.isArray(c)) throw fail(where, "must be an object");
  const rule = c.rule;
  if (typeof rule !== "string" || !Object.hasOwn(RULES, rule)) {
    throw fail(`${where}.rule`, `is not a known check type: ${typeof rule === "string" ? JSON.stringify(clip(rule)) : typeName(rule)} (see rubricVocabulary)`);
  }
  const def = RULES[rule];
  checkKeys(c, ["id", "rule", ...Object.keys(def.fields)], where);
  checkName(c.id, `${where}.id`);
  if (c.id.includes(":") || FOUNDATIONAL_IDS.has(c.id)) throw fail(`${where}.id`, 'must not contain ":" or be a reserved foundational name');
  for (const [name, d] of Object.entries(def.fields)) {
    const v = c[name];
    if (v === undefined) {
      if (d.required) throw fail(`${where}.${name}`, `is required for ${rule}`);
      continue;
    }
    checkValue(d, v, `${where}.${name}`);
    if ((rule === "sections" || rule === "sectionOrder") && name === "names") {
      // A heading line's trailing ":" is stripped from the LINE, never from the name, so such a name could never match.
      v.forEach((n, i) => {
        if (n.trim().endsWith(":")) throw fail(`${where}.names[${i}]`, `${JSON.stringify(n)} ends in ":", which can never match (the ":" is stripped from the heading line, not the name); drop the ":"`);
      });
    }
    if (d.ref === "input" && !inputNames.has(v)) throw fail(`${where}.${name}`, `names input ${JSON.stringify(clip(v))}, which is not in spec.inputs`);
  }
  if (def.exactlyOne) {
    const have = def.exactlyOne.filter((k) => c[k] !== undefined);
    if (have.length !== 1) throw fail(where, `needs exactly one of ${def.exactlyOne.join(", ")}`);
  }
  if (rule === "atMost" && !c.order.includes(c.value)) throw fail(`${where}.value`, "must be one of order");
}

/**
 * Validate a rubric spec and return it frozen. Refuses (throws) rather than bends:
 * an unknown check type, an unknown field, a missing required field, a count that
 * is not an integer >= 1, a list that is empty or holds an empty/whitespace-only
 * string, `blockLines` without both `size` and `phrases`, `commandExit` with `noneExit`, `notWorse` without a
 * `direction`, `__proto__`/`constructor`/`prototype` keys anywhere, and a
 * non-JSON value. The result is a null-prototype deep copy; the caller's object is
 * never held. Pass `{ sha256 }` to also verify the signed fingerprint.
 * @param {object} spec
 * @param {{sha256: string}} [opts]
 * @returns {Rubric}
 * @when Reach for this the moment a rubric spec exists (a drafter produced it, or a signed one is being loaded): it is the draft-time gate that refuses a line mapping to no owned check, and the load-time gate that refuses an unsigned or tampered spec. Its result is what `checkStep` takes.
 * @category rubric
 * @signature createRubric(spec: object, opts?: { sha256: string }) => Rubric
 * @fails Throws `Error("invalid rubric: <path> <reason>")` (with `.path`) on any invalid spec — never returns a partial rubric. With `opts`, also throws when `opts.sha256` is missing or not equal to `rubricSha(spec)`. Day 1 refuses `judged` checks and `onExhausted: "ask"` (later work), and a `requiresHuman` checkpoint that is not `gating`.
 * @example
 * import { createRubric, rubricSha } from "bareguard";
 * const spec = { schema: 1, goal: "Write the resume", checkpoints: { resume: { gating: true,
 *   checks: [{ id: "words-cap", rule: "maxWords", field: "text", value: 600 }] } } };
 * const rubric = createRubric(spec, { sha256: rubricSha(spec) }); // throws on a bad spec or a wrong sha
 */
export function createRubric(spec, opts) {
  const s = snapshot(spec, "spec", 0);
  if (s === null || typeof s !== "object" || Array.isArray(s)) throw fail("spec", "must be an object");
  checkKeys(s, ["schema", "goal", "inputs", "judge", "reads", "checkpoints", "onExhausted", "maxReds"], "spec");
  if (s.schema !== 1) throw fail("spec.schema", "must be 1");
  if (blank(s.goal)) throw fail("spec.goal", "must be a non-blank string");

  const inputNames = new Set();
  if (s.inputs !== undefined) {
    if (!Array.isArray(s.inputs)) throw fail("spec.inputs", "must be an array");
    s.inputs.forEach((i, n) => {
      const w = `spec.inputs[${n}]`;
      if (i === null || typeof i !== "object" || Array.isArray(i)) throw fail(w, "must be an object");
      checkKeys(i, ["name", "sha256"], w);
      checkName(i.name, `${w}.name`);
      if (typeof i.sha256 !== "string" || !SHA_HEX.test(i.sha256)) throw fail(`${w}.sha256`, "must be a 64-character lowercase hex sha256");
      if (inputNames.has(i.name)) throw fail(`${w}.name`, "is a duplicate input name");
      inputNames.add(i.name);
    });
  }
  if (s.judge !== undefined && s.judge !== null) {
    const j = s.judge;
    if (typeof j !== "object" || Array.isArray(j)) throw fail("spec.judge", "must be an object or null");
    checkKeys(j, ["provider", "model", "cutoff", "band"], "spec.judge");
    if (blank(j.provider)) throw fail("spec.judge.provider", "must be a non-blank string");
    if (blank(j.model)) throw fail("spec.judge.model", "must be a non-blank string");
    for (const k of ["cutoff", "band"]) {
      if (j[k] !== undefined && (typeof j[k] !== "number" || !Number.isFinite(j[k]))) throw fail(`spec.judge.${k}`, "must be a finite number");
    }
  }
  if (s.reads !== undefined) checkValue({ type: "integer", min: 1 }, s.reads, "spec.reads");
  if (s.maxReds !== undefined) checkValue({ type: "integer", min: 1 }, s.maxReds, "spec.maxReds");
  if (s.onExhausted !== undefined && s.onExhausted !== "fail") {
    throw fail("spec.onExhausted", s.onExhausted === "ask" ? 'is "ask", which is not available yet; use "fail"' : 'must be "fail"');
  }

  const cps = s.checkpoints;
  if (cps === null || typeof cps !== "object" || Array.isArray(cps)) throw fail("spec.checkpoints", "must be an object");
  const ids = Object.keys(cps);
  if (ids.length === 0) throw fail("spec.checkpoints", "must name at least one checkpoint");
  for (const id of ids) {
    const w = `spec.checkpoints.${id}`;
    checkName(id, w, "has a blank checkpoint id");
    if (id.includes(":")) throw fail(w, 'checkpoint ids must not contain ":"');
    const cp = cps[id];
    if (cp === null || typeof cp !== "object" || Array.isArray(cp)) throw fail(w, "must be an object");
    checkKeys(cp, ["gating", "requiresHuman", "checks"], w);
    if (typeof cp.gating !== "boolean") throw fail(`${w}.gating`, "must be a boolean");
    if (cp.requiresHuman !== undefined) {
      if (cp.requiresHuman !== true) throw fail(`${w}.requiresHuman`, "must be true when present");
      if (!cp.gating) throw fail(`${w}.requiresHuman`, "needs a gating checkpoint (it would never be enforced)");
    }
    if (!Array.isArray(cp.checks)) throw fail(`${w}.checks`, "must be an array");
    const seen = new Set();
    cp.checks.forEach((c, n) => {
      validateCheck(c, `${w}.checks[${n}]`, inputNames);
      if (seen.has(c.id)) throw fail(`${w}.checks[${n}].id`, `duplicates id ${JSON.stringify(c.id)} in this checkpoint`);
      seen.add(c.id);
    });
  }

  if (opts !== undefined) {
    if (opts === null || typeof opts !== "object" || typeof opts.sha256 !== "string") throw fail("opts.sha256", "is required to verify a signed rubric");
    if (opts.sha256 !== canonSha(s)) throw fail("opts.sha256", "does not match the rubric: unsigned or tampered");
  }
  deepFreeze(s);
  BRANDED.add(s);
  return s;
}

function canonSha(copy) {
  return sha256Hex(canon(copy));
}

// --- quoteIn / numbersInQuote -----------------------------------------------

// Strip the markers FIRST, then collapse+trim, so a quote that is only markers/whitespace
// is empty (a vacuous quote must not match) and "a ** b" still equals "a b".
function normalizeForQuote(s) {
  return s.split("**").join("").split("__").join("").replace(/\s+/g, " ").trim();
}

/**
 * Is `quote` in `source`? Minimal normalization on both sides: whitespace runs
 * collapse to one space (then trim), and `**` and `__` are removed. Then plain
 * substring containment (not line-wise). Case-sensitive. An empty quote (after
 * normalizing) is not ok; a source over 5 MiB (5 * 1024 * 1024 UTF-8 bytes) is not ok.
 * @param {string} quote
 * @param {string} source
 * @returns {{ok: boolean, why?: string}}
 * @when Reach for this to check that a quote a model returned really appears in the frozen text it claims to cite, forgiving only markdown bold and reflowed whitespace — so a paraphrase or a changed word fails, but a quote copied across a line wrap or out of a bold run passes.
 * @category rubric
 * @signature quoteIn(quote: string, source: string) => { ok: boolean, why?: "not-a-string"|"source-too-large"|"empty-quote"|"not-found" }
 * @fails Never throws. A non-string argument, an empty quote and an oversize source each return `{ ok: false, why }`. Plain substring search, no regex built from input.
 * @example
 * import { quoteIn } from "bareguard";
 * quoteIn("ships in 2 weeks", "It **ships in\n2 weeks**.").ok; // true
 * quoteIn("ships in 3 weeks", "It ships in 2 weeks.").ok;      // false
 */
export function quoteIn(quote, source) {
  if (typeof quote !== "string" || typeof source !== "string") return { ok: false, why: "not-a-string" };
  if (Buffer.byteLength(source, "utf8") > SOURCE_CAP_BYTES) return { ok: false, why: "source-too-large" };
  const q = normalizeForQuote(quote);
  if (q === "") return { ok: false, why: "empty-quote" };
  return normalizeForQuote(source).includes(q) ? { ok: true } : { ok: false, why: "not-found" };
}

/**
 * Does every number in `claim` appear as a number in `quote`? A number token is
 * ASCII digits with an optional fractional part (`\d+(?:\.\d+)?`) and is compared
 * as the exact token, so `8` does not match `2018`, and `8x`, `1.2k`, `50%` and
 * `2 weeks` yield 8, 1.2, 50 and 2. Known gaps, by design: number words are not
 * checked, and thousands separators are not stripped (`1,200` vs `1200` is a false red).
 * @param {string} claim
 * @param {string} quote
 * @returns {{ok: boolean, missing: string[], why?: string}}
 * @when Reach for this right after `quoteIn` passes, to catch a claim whose figures drifted from the quote that supposedly backs it (a quote saying "2 weeks" cannot back a claim of "4 hours").
 * @category rubric
 * @signature numbersInQuote(claim: string, quote: string) => { ok: boolean, missing: string[], why?: "not-a-string" }
 * @fails Never throws. A non-string argument returns `{ ok: false, missing: [] , why: "not-a-string" }`. `missing` lists the claim's unmatched tokens, de-duplicated and capped at 20.
 * @example
 * import { numbersInQuote } from "bareguard";
 * numbersInQuote("delivers 8x faster", "delivers 8x faster").ok;   // true
 * numbersInQuote("delivers in 4 hours", "delivers in 2 weeks");    // { ok: false, missing: ["4"] }
 */
export function numbersInQuote(claim, quote) {
  if (typeof claim !== "string" || typeof quote !== "string") return { ok: false, missing: [], why: "not-a-string" };
  const have = new Set(quote.match(/\d+(?:\.\d+)?/g) ?? []);
  const missing = [];
  for (const t of claim.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!have.has(t) && !missing.includes(t)) missing.push(t);
    if (missing.length >= MAX_ITEMS) break;
  }
  return { ok: missing.length === 0, missing };
}

// --- renderGaps --------------------------------------------------------------

/**
 * A deterministic one-string render of a gap list: each gap becomes a JSON array
 * of its fields in a FIXED order [key, check, kind, field, measured, limit,
 * direction, items, itemsTotal] (absent = null), and the entries are joined by
 * "; " in the order given (the minted order is signed check order). JSON makes the
 * render injective, so the same failing state always gives the same string and
 * different states give different strings.
 * @param {Gap[]} gaps
 * @returns {string}
 * @when Reach for this to detect a stuck retry loop: render the gaps of each try and compare the strings — an identical render means the worker changed nothing that the checks can see.
 * @category rubric
 * @signature renderGaps(gaps: Gap[]) => string
 * @fails Never throws. A non-array returns ""; an element that is not an object is skipped; a hostile getter is read as absent.
 * @example
 * import { renderGaps } from "bareguard";
 * renderGaps([{ key: "resume:words-cap", check: "maxWords", measured: 633, limit: 600, direction: "at-most" }]);
 * // '["resume:words-cap","maxWords",null,null,633,600,"at-most",null,null]'
 */
export function renderGaps(gaps) {
  if (!Array.isArray(gaps)) return "";
  const parts = [];
  for (const g of gaps) {
    if (g === null || typeof g !== "object") continue;
    const row = ["key", "check", "kind", "field", "measured", "limit", "direction", "items", "itemsTotal"].map((k) => {
      try {
        const v = g[k];
        if (v === undefined) return null;
        if (k === "items") return Array.isArray(v) ? v.map((x) => String(x)) : null;
        return typeof v === "number" || typeof v === "string" ? v : String(v);
      } catch {
        return null;
      }
    });
    parts.push(JSON.stringify(row));
  }
  return parts.join("; ");
}

// --- checkStep ---------------------------------------------------------------

function errorDetail(e) {
  try {
    return clip(e instanceof Error ? e.message : String(e), FAULT_DETAIL_CLIP);
  } catch {
    return "unreadable error";
  }
}

function mintGap(checkpoint, c, partial) {
  const g = { key: `${checkpoint}:${c.id}`, checkpoint, check: c.rule, id: c.id };
  const field = c.field ?? c.claims;
  if (field !== undefined) g.field = field;
  for (const k of ["kind", "measured", "limit", "direction", "items", "itemsTotal"]) {
    let v = partial[k];
    if (v === undefined) continue;
    g[k] = v;
  }
  return g;
}

/**
 * Run a checkpoint's deterministic checks over an output and mint the verdict.
 * Foundational `happened` first (a missing/empty/unreadable output is red and the
 * rest is moot), then every listed check in signed order. `green`: all checks
 * green. `red`: a check is red; `gaps` carries one bounded gap per red check.
 * `stopped`: the INSTRUMENT failed (a measurement threw, a liveness proof failed,
 * a caller measurement or item list is missing, an unsigned pattern id, a
 * conflicting seed baseline); `fault` is for the runner, `gaps` is empty, and a
 * measurement failure is never read as an empty set or a zero. A plain-string
 * output is the single field `text`; an object output is read by own keys.
 * Caller measurements: `opts.measurements[checkId]`, `opts.items[checkId]`,
 * `opts.inputs[name]` (text of a signed input), `opts.priorBaselines[checkId]`
 * (a seed baseline already recorded for this run; a different passed baseline is `baseline-conflict`).
 * `opts.inputs[name]` must hash to the signed `sha256` or the check is `stopped`.
 * `outputSha` = sha256 of exactly `opts.outputBytes` (a string, or a Buffer/Uint8Array)
 * when given, for any output type; else of the UTF-8 bytes of a string output; else
 * null for an object (bareguard never serializes one: such an advance cannot be bound
 * to its bytes). Precedence: stopped > red > green (a stopped verdict keeps its reds
 * in `full` only). Async so judge support can be added without an API break.
 * @param {Rubric} rubric
 * @param {string} checkpoint
 * @param {any} output
 * @param {object} [opts]
 * @returns {Promise<StepResult>}
 * @when Reach for this each time an agent hands over output at a checkpoint: it grades the output against the signed rubric and returns the verdict, the structured gap to feed the retry, or the fault for the runner. Take any command/count measurements yourself first and pass them in — bareguard compares, it never runs a tool.
 * @category rubric
 * @signature checkStep(rubric: Rubric, checkpoint: string, output: string|object, opts?: { measurements?: object, items?: object, inputs?: object, priorBaselines?: object, outputBytes?: string|Uint8Array }) => Promise<StepResult>
 * @fails Rejects with a TypeError only for CALLER misuse: a rubric not made by `createRubric`, an unknown checkpoint, a non-object `opts`, or a `judge` option (the judge path is not available yet — refused, not ignored). Never rejects because of the output: any shape, a throwing getter or a Proxy yields red (`happened`/field checks) and a throwing measurement yields stopped. An output that is not a string or a non-array object is red.
 * @example
 * import { createRubric, checkStep } from "bareguard";
 * const rubric = createRubric({ schema: 1, goal: "g", checkpoints: { resume: { gating: true,
 *   checks: [{ id: "words-cap", rule: "maxWords", field: "text", value: 600 }] } } });
 * const r = await checkStep(rubric, "resume", "word ".repeat(633));
 * // r.verdict === "red"; r.gaps[0] -> { key: "resume:words-cap", measured: 633, limit: 600, direction: "at-most", ... }
 */
export async function checkStep(rubric, checkpoint, output, opts) {
  if (rubric === null || typeof rubric !== "object" || !BRANDED.has(rubric)) {
    throw new TypeError("checkStep: rubric must come from createRubric()");
  }
  const spec = /** @type {any} */ (rubric);
  if (typeof checkpoint !== "string" || !Object.hasOwn(spec.checkpoints, checkpoint)) {
    throw new TypeError(`checkStep: unknown checkpoint ${typeof checkpoint === "string" ? JSON.stringify(clip(checkpoint)) : typeName(checkpoint)}`);
  }
  if (opts !== undefined && (opts === null || typeof opts !== "object" || Array.isArray(opts))) {
    throw new TypeError("checkStep: opts must be an object");
  }
  const o = opts ?? {};
  let judge;
  try {
    judge = o.judge;
  } catch {
    judge = true;
  }
  if (judge !== undefined && judge !== null) throw new TypeError("checkStep: a judge is not available in this version; pass deterministic rubrics only");
  const sha = rubricSha(rubric);
  const cp = spec.checkpoints[checkpoint];

  // Snapshot the caller's option maps once (a throwing getter is deferred to the check that reads it).
  const optsRead = Object.create(null);
  for (const k of ["measurements", "items", "inputs", "priorBaselines"]) {
    try {
      optsRead[k] = { v: o[k] };
    } catch (e) {
      optsRead[k] = { e };
    }
  }

  // outputSha: sha256 of EXACTLY the caller's `outputBytes` (a string as UTF-8) for any output type; else
  // of a string output's UTF-8 bytes; else null (an object is never serialized here, so it cannot be bound).
  let outputBytes;
  try {
    outputBytes = o.outputBytes;
  } catch {
    throw new TypeError("checkStep: opts.outputBytes is unreadable");
  }
  if (outputBytes !== undefined && typeof outputBytes !== "string" && !(outputBytes instanceof Uint8Array)) {
    throw new TypeError("checkStep: opts.outputBytes must be a string or a Buffer/Uint8Array");
  }
  let outputSha = null;
  if (outputBytes !== undefined) outputSha = sha256Hex(outputBytes);
  else if (typeof output === "string") outputSha = sha256Hex(output);
  let fields = null;
  let shapeGap = null;
  if (typeof output === "string") {
    fields = Object.create(null);
    fields.text = output;
  } else if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    fields = output;
  } else {
    shapeGap = { kind: "wrong-type", measured: typeName(output) };
  }
  if (shapeGap === null) {
    try {
      const empty = typeof output === "string" ? output.trim() === "" : Object.keys(output).length === 0;
      if (empty) shapeGap = { kind: "empty" };
    } catch {
      shapeGap = { kind: "unreadable" };
    }
  }

  const ctx = { rubric: spec, fields, opts: optsRead, baselines: {}, callerItems: {} };
  const reds = [];
  const faults = [];

  if (shapeGap !== null) {
    reds.push(mintGap(checkpoint, { id: "happened", rule: "happened" }, shapeGap));
  } else {
    for (const c of cp.checks) {
      let res;
      try {
        res = RULES[c.rule].run(ctx, c);
      } catch (e) {
        res = stop("exception", errorDetail(e));
      }
      if (res.gap) reds.push(mintGap(checkpoint, c, res.gap));
      else if (res.fault) faults.push({ key: `${checkpoint}:${c.id}`, checkpoint, id: c.id, kind: res.fault.kind, detail: res.fault.detail });
    }
  }

  const verdict = faults.length > 0 ? "stopped" : reds.length > 0 ? "red" : "green";
  return deepFreeze({
    verdict,
    checkpoint,
    rubricSha: sha,
    outputSha,
    gaps: verdict === "red" ? reds : [],
    fault: faults[0] ?? null,
    full: { gaps: reds, faults },
    baselines: ctx.baselines,
    callerItems: ctx.callerItems,
  });
}
