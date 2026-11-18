// `itemShape` (RULED #83, docs/product/rubric-prd.md): a deterministic SHAPE check over a list of items in the step output.
// It never judges wording or truth (that stays with `cited`); it says whether every item has the signed fields, of the signed kinds,
// inside the signed bounds. Pass/fail only. A red names fields and counts, NEVER the worker's values or text.
//
// Cost shape: linear in the output (every item, key, string and nested object is read a constant number of times); no regex is built
// from input and there is no work cap beyond `MAX_LIST` items. Never throws on hostile output: a throwing getter or a revoked Proxy
// is a red `unreadable` item, a lying `length` is bounded by `MAX_LIST`.

import { clip, MAX_ITEMS, MAX_LIST, typeName } from "./rubric.js";
import { extractValue, parseBound, compareBounds } from "./rubric-locate.js";
import { readCellNumber } from "./rubric-cells.js";

/** A money / date / time string over this many UTF-16 units is not one value: it is red without being read (bounds the reader's input). */
export const READ_CAP = 200;

const isArr = (v) => {
  try {
    return Array.isArray(v);
  } catch {
    return false;
  }
};

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
  if (!/^https?:\/\//i.test(t) || /\s/.test(t)) return false;
  try {
    const u = new URL(t);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

// ---- the plan: the signed fields, sorted once, with bounds parsed once --------------------------------------------------------------

const plans = new WeakMap(); // a check (frozen) -> its plan

function planFields(fields) {
  return Object.keys(fields)
    .sort()
    .map((name) => {
      const s = fields[name];
      const p = { name, required: s.required === true, kind: s.kind, spec: s };
      if (s.kind === "object") p.sub = { fields: s.fields, list: planFields(s.fields) };
      else if (s.kind === "oneOf") {
        p.fold = s.ignoreCase === true;
        p.set = new Set(p.fold ? s.values.map((v) => v.toLowerCase()) : s.values);
      } else if (s.kind === "money" || s.kind === "date" || s.kind === "time") {
        p.decide = decideOf(s.kind, s);
        for (const k of ["min", "max", "gt", "lt"]) if (s[k] !== undefined) p[k] = parseBound(s.kind, s[k]).value;
      }
      return p;
    });
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

/** One present value against its field spec. `at` = `#<i>:<dotted path>`. */
function checkValue(rec, at, p, v, i, path, depth) {
  const s = p.spec;
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
    return;
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
      return;
    }
    case "oneOf":
      if (!p.set.has(p.fold ? v.toLowerCase() : v)) add(rec, `${at}:not-one-of`);
      return;
    case "url":
      if (!urlOk(v)) add(rec, `${at}:bad-url`);
      return;
    default: {
      // money | date | time
      const r = readWhole(p.decide, v);
      if (r === null) return add(rec, `${at}:bad-${p.kind}`);
      boundsOf(rec, at, r.value, p, (a, b) => compareBounds(p.kind, a, b));
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
