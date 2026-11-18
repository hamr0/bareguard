// `itemShape` (RULED #83, docs/product/rubric-prd.md): a deterministic SHAPE check over a list of items in the step output.
// It never judges wording or truth (that stays with `cited`); it says whether every item has the signed fields, of the signed kinds,
// inside the signed bounds. Pass/fail only. A red names fields and counts, NEVER the worker's values or text.
//
// Cost shape: linear in the output (every item, key, string and nested object is read a constant number of times); no regex is built
// from input and there is no work cap beyond `MAX_LIST` items (and `MAX_LIST_ENTRIES` entries per `list`). Never throws on hostile output: a throwing getter or a revoked Proxy
// is a red `unreadable` item, a lying `length` is bounded by `MAX_LIST`.

import { clip, MAX_ITEMS, MAX_LIST, MAX_LIST_ENTRIES, typeName } from "./rubric.js";
import { isArr } from "./rubric-helpers.js";
import { extractValue, parseBound, compareBounds } from "./rubric-locate.js";
import { readCellNumber } from "./rubric-cells.js";

/** A money / date / time string over this many UTF-16 units is not one value: it is red without being read (bounds the reader's input). */
export const READ_CAP = 200;

/** Code points in `s` (a surrogate pair counts once; a lone surrogate counts once). */
function codePoints(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** Whitespace-separated runs (JS `\s`). */
function wordCount(s) {
  let n = 0;
  const re = /\S+/g;
  while (re.exec(s) !== null) n++;
  return n;
}

/** The decide the reader of a money / date / time field runs as (the same reader `cited` uses). */
function decideOf(kind, spec) {
  const d = { valueKind: kind };
  for (const k of ["currency", "unit", "decimal", "lang", "months"]) if (spec[k] !== undefined) d[k] = spec[k];
  return d;
}

/**
 * Read `raw` as exactly ONE value of the decide's kind and nothing else: whitespace is collapsed and trimmed (nothing else is
 * stripped), the reader must find exactly one token, and the token (with its currency symbol / unit text) must cover the whole string.
 * Returns the reader's result `{ ok: true, value }` or null.
 */
function readWhole(decide, raw) {
  if (raw.length > READ_CAP) return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (t === "") return null;
  const sp = [];
  const r = extractValue(decide, t, sp);
  if (!r.ok) return null;
  sp.sort((a, b) => a.start - b.start);
  let pos = 0;
  for (const s of sp) {
    if (t.slice(pos, s.start).trim() !== "") return null;
    if (s.end > pos) pos = s.end;
  }
  if (t.slice(pos).trim() !== "") return null;
  return r;
}

function urlOk(raw) {
  const t = raw.trim();
  // the authority must be non-empty in the RAW input (WHATWG repairs "https:///path" to host "path" and "\\" to "/"), so: scheme, "//", then a char that is not "/" or "\"
  if (!/^https?:\/\/[^/\\]/i.test(t) || /\s/.test(t) || t.includes("\\")) return false;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ---- the plan: the signed fields, sorted once, with bounds parsed once --------------------------------------------------------------

const plans = new WeakMap(); // a check (frozen) -> its plan

function planSpec(name, s) {
  const p = { name, required: s.required === true, kind: s.kind, spec: s };
  if (s.kind === "object") p.sub = { fields: s.fields, list: planFields(s.fields) };
  else if (s.kind === "list") p.elem = planSpec("", s.of);
  else if (s.kind === "oneOf") {
    p.fold = s.ignoreCase === true;
    p.set = new Set(p.fold ? s.values.map((v) => v.toLowerCase()) : s.values);
  } else if (s.kind === "money" || s.kind === "date" || s.kind === "time") {
    p.decide = decideOf(s.kind, s);
    for (const k of ["min", "max", "gt", "lt"]) if (s[k] !== undefined) p[k] = parseBound(s.kind, s[k]).value;
  }
  return p;
}

function planFields(fields) {
  return Object.keys(fields)
    .sort()
    .map((name) => planSpec(name, fields[name]));
}

function planOf(c) {
  let p = plans.get(c);
  if (p === undefined) plans.set(c, (p = { fields: c.fields, list: planFields(c.fields) }));
  return p;
}

// ---- evaluation ---------------------------------------------------------------------------------------------------------------------

/** `rec`: the offender strings so far (at most MAX_ITEMS kept) and the total. */
function add(rec, str) {
  rec.total++;
  if (rec.items.length < MAX_ITEMS) rec.items.push(str);
}

/** min / max are inclusive, gt / lt exclusive; the red is `under` / `over` either way (the signed spec says which bound it was). */
function boundsOf(rec, at, v, p, cmp) {
  if ((p.min !== undefined && cmp(v, p.min) < 0) || (p.gt !== undefined && cmp(v, p.gt) <= 0)) add(rec, `${at}:under`);
  if ((p.max !== undefined && cmp(v, p.max) > 0) || (p.lt !== undefined && cmp(v, p.lt) >= 0)) add(rec, `${at}:over`);
}

/** A `list`: `at` = `#<i>:<dotted path>`; entries are `at[<j>]`. */
function checkList(rec, at, p, v, i, depth) {
  const s = p.spec;
  let len;
  try {
    if (!Array.isArray(v)) return add(rec, `${at}:not-a-list`); // NOT isArr: it maps a throw (a revoked Proxy) to false, and a throw is unreadable, not a non-list
    len = v.length;
  } catch {
    return add(rec, `${at}:unreadable`); // Array.isArray or length threw
  }
  if (!Number.isInteger(len) || len < 0) return add(rec, `${at}:unreadable`);
  if (len > MAX_LIST_ENTRIES) return add(rec, `${at}:too-many:${len}>${MAX_LIST_ENTRIES}`);
  if (s.minEntries !== undefined && len < s.minEntries) return add(rec, `${at}:count-under:${len}<${s.minEntries}`);
  if (s.maxEntries !== undefined && len > s.maxEntries) return add(rec, `${at}:count-over:${len}>${s.maxEntries}`);
  const seen = s.unique === true ? new Set() : null;
  for (let j = 0; j < len; j++) {
    let e;
    try {
      e = v[j];
    } catch {
      add(rec, `${at}[${j}]:unreadable`); // a throwing index getter or a revoked Proxy element
      continue;
    }
    const key = checkValue(rec, `${at}[${j}]`, p.elem, e, i, "", depth);
    if (seen !== null && key !== undefined) {
      if (seen.has(key)) add(rec, `${at}[${j}]:duplicate`);
      else seen.add(key);
    }
  }
}

/**
 * One present value against its field spec. `at` = `#<i>:<dotted path>`. Returns, for a scalar kind whose value was READ, a canonical
 * string key of that value (what `unique` compares); undefined when the value could not be read.
 */
function checkValue(rec, at, p, v, i, path, depth) {
  const s = p.spec;
  if (p.kind === "list") return checkList(rec, at, p, v, i, depth);
  if (p.kind === "object") {
    if (v === null || typeof v !== "object" || isArr(v)) return add(rec, `${at}:wrong-type`);
    return checkObject(rec, p.sub, v, i, path, depth + 1);
  }
  if (p.kind === "number") {
    let n;
    if (typeof v === "number") n = v;
    else if (s.fromText === true && typeof v === "string") {
      n = readCellNumber(v);
      if (n === null) return add(rec, `${at}:bad-number`);
    } else return add(rec, `${at}:wrong-type`);
    if (!Number.isFinite(n)) return add(rec, `${at}:bad-number`);
    boundsOf(rec, at, n, s, (a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return String(n === 0 ? 0 : n); // -0 and 0 are one value
  }
  if (typeof v !== "string") return add(rec, `${at}:wrong-type`);
  switch (p.kind) {
    case "text": {
      if (s.minChars !== undefined || s.maxChars !== undefined) {
        const n = codePoints(v);
        if (s.minChars !== undefined && n < s.minChars) add(rec, `${at}:too-short:chars:${n}<${s.minChars}`);
        if (s.maxChars !== undefined && n > s.maxChars) add(rec, `${at}:too-long:chars:${n}>${s.maxChars}`);
      }
      if (s.minWords !== undefined || s.maxWords !== undefined) {
        const n = wordCount(v);
        if (s.minWords !== undefined && n < s.minWords) add(rec, `${at}:too-short:words:${n}<${s.minWords}`);
        if (s.maxWords !== undefined && n > s.maxWords) add(rec, `${at}:too-long:words:${n}>${s.maxWords}`);
      }
      return v;
    }
    case "oneOf":
      if (!p.set.has(p.fold ? v.toLowerCase() : v)) add(rec, `${at}:not-one-of`);
      return p.fold ? v.toLowerCase() : v;
    case "url":
      if (!urlOk(v)) add(rec, `${at}:bad-url`);
      return v.trim();
    default: {
      // money | date | time
      const r = readWhole(p.decide, v);
      if (r === null) return add(rec, `${at}:bad-${p.kind}`);
      boundsOf(rec, at, r.value, p, (a, b) => compareBounds(p.kind, a, b));
      return String(r.canon);
    }
  }
}

function checkObject(rec, sub, obj, i, path, depth) {
  let keys;
  try {
    keys = Object.keys(obj);
  } catch {
    return add(rec, `#${i}:${path === "" ? "" : `${path}:`}unreadable`);
  }
  for (const p of sub.list) {
    const name = p.name;
    const dotted = path === "" ? name : `${path}.${name}`;
    let v;
    try {
      v = Object.hasOwn(obj, name) ? obj[name] : undefined;
    } catch {
      add(rec, `#${i}:${dotted}:unreadable`); // a throwing getter
      continue;
    }
    if (v === undefined) {
      if (p.required) add(rec, `#${i}:${dotted}:missing`);
      continue;
    }
    checkValue(rec, `#${i}:${dotted}`, p, v, i, dotted, depth);
  }
  for (const k of keys) {
    if (!Object.hasOwn(sub.fields, k)) add(rec, `#${i}:${path === "" ? "" : `${path}:`}unknown-field:${clip(k)}`);
  }
}

/**
 * Evaluate an `itemShape` check against the raw value of its `field`. Returns `{}` (green) or `{ gap }`.
 * Whole-field gaps: `not-a-list`, `too-many`, `count-under`, `count-over`; otherwise one `item-shape` gap whose `items` are
 * `#<i>:<dotted path>:<reason>` (at most MAX_ITEMS, `itemsTotal` when cut).
 */
export function evalItemShape(c, value) {
  let len;
  try {
    if (!isArr(value)) return { gap: { kind: "not-a-list", measured: typeName(value) } };
    len = value.length;
  } catch {
    return { gap: { kind: "unreadable" } };
  }
  if (!Number.isInteger(len) || len < 0) return { gap: { kind: "unreadable" } };
  if (len > MAX_LIST) return { gap: { kind: "too-many", measured: len, limit: MAX_LIST } };
  if (c.minItems !== undefined && len < c.minItems) return { gap: { kind: "count-under", measured: len, limit: c.minItems, direction: "at-least" } };
  if (c.maxItems !== undefined && len > c.maxItems) return { gap: { kind: "count-over", measured: len, limit: c.maxItems, direction: "at-most" } };
  const plan = planOf(c);
  const rec = { items: [], total: 0 };
  for (let i = 0; i < len; i++) {
    try {
      const item = value[i];
      if (item === null || typeof item !== "object" || isArr(item)) {
        add(rec, `#${i}:item-not-object`);
        continue;
      }
      checkObject(rec, plan, item, i, "", 0);
    } catch {
      add(rec, `#${i}:unreadable`); // reading the item itself threw (a revoked Proxy element, a throwing index getter); nothing was added for it yet
    }
  }
  if (rec.total === 0) return {};
  return { gap: { kind: "item-shape", items: rec.items, ...(rec.total > rec.items.length ? { itemsTotal: rec.total } : {}) } };
}
