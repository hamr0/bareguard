// `groundedValues` / `groundedLiterals` (RULED #82, docs/product/cells-prd.md §11.6): is every number, date and time an AI wrote
// somewhere in the person's own words? ONE caller-given string, read by ONE hand-coded, linear, left-to-right scan that consumes each
// match whole as one token (time, date, amount, bare number), so `$150` does not say 15, `05:00` does not say 5 and `2026-11-18` says
// no bare 2026. Strict on purpose ("nothing inferred"): a token that is not exactly one of the forms below is MALFORMED, consumed whole,
// and grounds nothing. No LLM, no clock, no regex built from input, no work cap (linear: normalize once, every char read a constant
// number of times). Values compare as exact decimals (parseGrammar), never floats.

import { normalizeForQuote, clip } from "./rubric.js";
import { parseGrammar, decToString } from "./rubric-locate.js";
import { isRealDay } from "./rubric-months.js";

const CLIP = 120;
const U_MINUS = 0x2212;
const isDigit = (c) => c >= 48 && c <= 57;
const isSym = (c) => c === 36 || c === 0x20ac || c === 0xa3; // $ € £
const GLUE = /^[\p{L}\p{M}\p{Nd}]$/u; // one code point at a time: a fixed class, never built from input
const glue = (cp) => cp !== undefined && cp === cp && GLUE.test(String.fromCodePoint(cp));
/** The code point that ENDS just before index i. */
function cpBefore(t, i) {
  const c = t.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = t.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return t.codePointAt(i - 2);
  }
  return c;
}

// --- the scan -------------------------------------------------------------------

/** The maximal run of 0-9 , . from s; `t` is its end without trailing "." and ",". */
function numRun(t, s) {
  let e = s;
  for (let c = t.charCodeAt(e); isDigit(c) || c === 44 || c === 46; c = t.charCodeAt(e)) e++;
  let k = e;
  while (k > s && (t.charCodeAt(k - 1) === 44 || t.charCodeAt(k - 1) === 46)) k--;
  return { e, t: k };
}

/** Skip the word characters (letters, marks, digits of any script) glued from i on: a malformed token swallows what is glued to it. */
function skipGlue(t, i) {
  while (i < t.length && glue(t.codePointAt(i))) i += t.codePointAt(i) > 0xffff ? 2 : 1;
  return i;
}

/** An am/pm suffix at d (optionally after ONE space): { ok, pm, end }, { dotted, end } for a.m. / p.m., or null. */
function suffixAt(t, d) {
  let p = d;
  if (t.charCodeAt(p) === 32) p++;
  const a = t.charCodeAt(p) | 32;
  if (a !== 97 && a !== 112) return null;
  const pm = a === 112;
  const c1 = t.charCodeAt(p + 1);
  if (c1 === 46 && (t.charCodeAt(p + 2) | 32) === 109 && !glue(t.codePointAt(p + 3))) return { dotted: true, end: p + 3 + (t.charCodeAt(p + 3) === 46 ? 1 : 0) };
  if ((c1 | 32) !== 109 || glue(t.codePointAt(p + 2))) return null; // "american" is a word, "9amx" is glued letters
  return { ok: true, pm, end: p + 2 };
}

/**
 * Scan text (already normalized) once. Returns what it says: `nums` (canonical decimal strings, bare and amount tokens),
 * `dates` (real ISO dates), `times` (minutes of the day).
 */
function scan(text) {
  const n = text.length;
  const nums = new Set();
  const dates = new Set();
  const times = new Set();
  const addNum = (dec, neg) => {
    if (neg && !(dec.int === "0" && dec.frac === "")) dec.neg = true;
    nums.add(decToString(dec));
  };

  // a token that starts with a digit at s (signed: the sign sits at s - 1). Returns where the scan resumes (always > s).
  function digitToken(s, signed) {
    let d = s;
    while (isDigit(text.charCodeAt(d))) d++;
    const before = signed || s === 0 ? undefined : cpBefore(text, s); // what stands directly before the digits
    const glued = glue(before);
    const c1 = text.charCodeAt(d);

    // 1. a time: H:MM / HH:MM (optionally with am/pm), or H / HH alone directly before am/pm
    if (c1 === 58 && isDigit(text.charCodeAt(d + 1))) {
      let e = s;
      for (let c = text.charCodeAt(e); isDigit(c) || c === 58; c = text.charCodeAt(e)) e++;
      while (e > s && text.charCodeAt(e - 1) === 58) e--;
      const run = text.slice(s, e);
      const sx = suffixAt(text, e);
      const shape = /^(\d{1,2}):(\d{2})$/.exec(run); // run is only digits and colons, <= the run length: linear
      let end = e;
      let ok = shape !== null && !signed && !glued;
      if (sx !== null) {
        end = sx.end;
        if (sx.dotted) ok = false;
      } else if (glue(text.codePointAt(e))) ok = false; // 5:00x
      if (ok && shape) {
        const h = +shape[1];
        const m = +shape[2];
        if (m > 59) ok = false;
        else if (sx !== null && sx.ok) {
          if (h < 1 || h > 12) ok = false;
          else times.add((h % 12 + (sx.pm ? 12 : 0)) * 60 + m);
        } else if (h > 23) ok = false;
        else times.add(h * 60 + m);
      }
      return end;
    }
    if (d - s <= 2) {
      const sx = suffixAt(text, d);
      if (sx !== null) {
        const h = +text.slice(s, d);
        if (sx.ok && !signed && !glued && h >= 1 && h <= 12) times.add((h % 12 + (sx.pm ? 12 : 0)) * 60);
        return sx.end;
      }
    }

    // 2. a date: three or more digit groups joined by single - / . separators. Only a real ISO date grounds; any other such run is opaque.
    if ((c1 === 45 || c1 === 47 || c1 === 46) && isDigit(text.charCodeAt(d + 1))) {
      const lens = [d - s];
      const seps = [];
      let p = d;
      for (let sp = text.charCodeAt(p); (sp === 45 || sp === 47 || sp === 46) && isDigit(text.charCodeAt(p + 1)); sp = text.charCodeAt(p)) {
        seps.push(sp);
        let q = p + 1;
        while (isDigit(text.charCodeAt(q))) q++;
        lens.push(q - (p + 1));
        p = q;
      }
      if (lens.length >= 3) {
        if (lens.length === 3 && lens[0] === 4 && lens[1] === 2 && lens[2] === 2 && seps[0] === 45 && seps[1] === 45 && !signed && !glued && !glue(text.codePointAt(p)) && isRealDay(+text.slice(s, s + 4), +text.slice(s + 5, s + 7), +text.slice(s + 8, s + 10))) {
          dates.add(text.slice(s, p));
        }
        return p;
      }
    }

    // 3. a number: bare, or an amount with a symbol glued AFTER it
    const { e, t } = numRun(text, s);
    let bad = glued || glue(text.codePointAt(e));
    if (!signed && s > 0) {
      const p = before;
      if (p === U_MINUS || p === 40 || p === 46 || p === 44) bad = true; // "−5", "(500)", ".5", ",5"
    }
    if (bad) return e;
    const dec = parseGrammar(text, s, t);
    if (dec === null) return e;
    if (t === e && isSym(text.charCodeAt(e))) { // 150€
      if (signed || glue(text.codePointAt(e + 1))) return skipGlue(text, e + 1);
      addNum(dec, false);
      return e + 1;
    }
    addNum(dec, signed && text.charCodeAt(s - 1) === 45);
    return e;
  }

  // a symbol at i directly followed by a digit: $150. A sign before it (signed) makes it malformed.
  function amountToken(i, signed) {
    const s = i + 1;
    const { e, t } = numRun(text, s);
    let bad = signed;
    if (!signed && i > 0) {
      const p = cpBefore(text, i);
      if (glue(p) || p === U_MINUS || p === 40) bad = true;
    }
    if (bad || glue(text.codePointAt(e))) return e;
    const dec = parseGrammar(text, s, t);
    if (dec === null) return e;
    if (t === e && isSym(text.charCodeAt(e))) return skipGlue(text, e + 1); // $43$ : a symbol on both sides
    addNum(dec, false);
    return e;
  }

  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isDigit(c)) {
      i = digitToken(i, false);
    } else if (isSym(c)) {
      const d = text.charCodeAt(i + 1);
      if (isDigit(d)) i = amountToken(i, false);
      else if ((d === 45 || d === 43) && isDigit(text.charCodeAt(i + 2))) i = numRun(text, i + 2).e; // $-5: malformed
      else i++;
    } else if ((c === 45 || c === 43) && (i === 0 || text.charCodeAt(i - 1) === 32 || text.charCodeAt(i - 1) === 40)) {
      const d = text.charCodeAt(i + 1);
      if (isDigit(d)) i = digitToken(i + 1, true);
      else if (isSym(d) && isDigit(text.charCodeAt(i + 2))) i = amountToken(i + 1, true);
      else i++;
    } else i++;
  }
  return { nums, dates, times };
}

// --- the exports ---------------------------------------------------------------

const KINDS = ["number", "date", "time"];
const UNREADABLE = Symbol("unreadable");
const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_HM = /^(\d{2}):(\d{2})$/;

/** What a missing entry shows of a value: a number as given, a string clipped, a boolean, else a type name. */
function carry(v) {
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return clip(v, CLIP);
  if (v === UNREADABLE) return "unreadable";
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
/** The canonical form of a literal for its kind, or null when the value is wrong for it. */
function canonOf(kind, v) {
  if (kind === "number") {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    const s = String(v);
    const neg = s.charCodeAt(0) === 45;
    const dec = parseGrammar(s, neg ? 1 : 0, s.length); // an exponent form ("1e+21") is not a plain decimal: null
    if (dec === null) return null;
    if (neg && !(dec.int === "0" && dec.frac === "")) dec.neg = true;
    return decToString(dec);
  }
  if (kind === "date") {
    const m = typeof v === "string" ? RE_ISO.exec(v) : null;
    return m !== null && isRealDay(+m[1], +m[2], +m[3]) ? v : null;
  }
  const m = typeof v === "string" ? RE_HM.exec(v) : null; // time
  return m !== null && +m[1] <= 23 && +m[2] <= 59 ? +m[1] * 60 + +m[2] : null;
}
const read = (o, k) => {
  try {
    return Object.hasOwn(o, k) ? o[k] : undefined;
  } catch {
    return UNREADABLE;
  }
};
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Is each number, date and time in `values` something the person said in `text`? One scan of `text`, each match one whole token
 * (a time, a real ISO date, an amount like `$150` or `150€`, or a bare number): `$150` says 150 and not 15, `05:00` says no bare 5,
 * `2026-11-18` says no bare 2026. Strict, nothing inferred. A number is grounded by a bare or an amount token of that exact decimal value
 * (`1,000` says 1000, `-5` says -5 and not 5, `+5` says 5; `5k`, `400USD`, `.5`, `(500)` say nothing). A date is grounded by that exact real ISO
 * date. A time is `"HH:MM"` (24-hour) and is grounded by `H:MM`, `HH:MM` or `H am|pm` in the text, compared as minutes of the day (a bare `5:00`
 * says only 05:00). A three-group digit shape that is not a real ISO date (`3/4/2026`, `18.11.2026`) is opaque and says nothing.
 * @param {{kind: "number"|"date"|"time", value: number|string}[]} values
 * @param {string} text the person's words, ONE string the caller assembles
 * @returns {{ ok: boolean, missing: {index: number, kind: string, value: any}[], why?: "not-an-array"|"not-a-string" }}
 * @when Reach for this when an AI wrote literals (a threshold, a date, a time) that must have come from the person's own words and you have only the values, not a signed check: it tells you which ones the person never said, so you refuse the invented ones before anything runs. For the literals inside a drafted `cells`/`table` check use `groundedLiterals`, which is built on this.
 * @category rubric
 * @signature groundedValues(values: {kind: "number"|"date"|"time", value: number|string}[], text: string) => { ok: boolean, missing: {index: number, kind: string, value: any}[], why?: string }
 * @fails Never throws. `missing` lists, in order, every entry that is not grounded, with its `index`: an entry that is not a plain object, a `kind` outside number/date/time (reported as kind "invalid"), a value of the wrong type (a numeric string, NaN, Infinity, an exponent-form number such as 1e21, a non-real date, a time that is not exactly "HH:MM") is itself missing. A `values` that is not an array is `{ ok: false, missing: [], why: "not-an-array" }`; a `text` that is not a string grounds nothing, so every entry is missing and `why` is "not-a-string". One linear pass, no work cap.
 * @example
 * import { groundedValues } from "bareguard";
 * groundedValues([{ kind: "number", value: 150 }, { kind: "number", value: 15 }], "budget $150 by 2026-11-18");
 * // { ok: false, missing: [{ index: 1, kind: "number", value: 15 }] }
 */
export function groundedValues(values, text) {
  if (!Array.isArray(values)) return { ok: false, missing: [], why: "not-an-array" };
  let len;
  try {
    len = values.length;
  } catch {
    return { ok: false, missing: [], why: "not-an-array" };
  }
  const textOk = typeof text === "string";
  let said = null;
  if (textOk) {
    try {
      said = scan(normalizeForQuote(text));
    } catch {
      said = null; // a failure grounds nothing
    }
  }
  const missing = [];
  for (let index = 0; index < len; index++) {
    let kind;
    let value;
    try {
      const e = values[index];
      if (!isObj(e)) throw new Error("not an entry");
      kind = read(e, "kind");
      value = read(e, "value");
    } catch {
      missing.push({ index, kind: "invalid", value: "unreadable" });
      continue;
    }
    if (!KINDS.includes(kind)) {
      missing.push({ index, kind: "invalid", value: carry(value) });
      continue;
    }
    const canon = canonOf(kind, value);
    const set = said === null ? null : kind === "number" ? said.nums : kind === "date" ? said.dates : said.times;
    if (canon === null || set === null || !set.has(canon)) missing.push({ index, kind, value: carry(value) });
  }
  return { ok: textOk && missing.length === 0, missing, ...(textOk ? {} : { why: "not-a-string" }) };
}

const NUM_VALUE = ["gt", "gte", "lt", "lte", "eq"];
const DATE_VALUE = ["before", "after", "dateOn"];

/**
 * Is every number and date literal a drafted `cells` / `table` check carries something the person said in `text`? The literals read:
 * `where[i].value` for gt gte lt lte eq and `where[i].lo` / `.hi` for between (numbers); `where[i].value` for before after dateOn and
 * `where[i].lo` / `.hi` for dateBetween, and `asOf` (dates); the row-math `b.const` (a number). Not read: `equals` text, `needle`,
 * `keyValue`, band bounds, `n`, `tolerance`, `range`, `exceptKeys`. Built on `groundedValues`, so the reader rules are the same.
 * @param {object} check a drafted check (a plain object; not mutated)
 * @param {string} text the person's words, ONE string the caller assembles (the job line plus its rules)
 * @returns {{ ok: boolean, missing: {path: string, kind: string, value: any}[], why?: string }}
 * @when Reach for this right after an AI drafted a `cells` or `table` check from the person's request: every threshold, bound and date it wrote must be in what the person said, so the check cannot silently use an invented number. Pass the person's whole instruction as one string. It judges only the literals, not whether the check is valid (that is `createRubric` and `checkTables`).
 * @category rubric
 * @signature groundedLiterals(check: object, text: string) => { ok: boolean, missing: {path: string, kind: string, value: any}[], why?: string }
 * @fails Never throws. `missing` lists, in check order (`where` entries in order, then `asOf`, then `b.const`), each literal the text does not say, with its field `path` (like `where[1].value`, `asOf`, `b.const`) and its kind (number or date). A literal of the wrong type (a numeric string, a non-finite number, a non-ISO or unreal date, an absent `lo`) is itself missing. A `check` that is not a plain object is `missing: [{ path: "", kind: "check", value: <type name> }]`; a throwing getter or Proxy yields missing entries, never a throw. A `text` that is not a string grounds nothing (every literal missing, `why: "not-a-string"`).
 * @example
 * import { groundedLiterals } from "bareguard";
 * const check = { id: "big", rule: "cells", table: "t", claim: "a", op: "countIf", where: [{ column: "Amount", cmp: "gt", value: 500 }, { column: "Due", cmp: "after", value: "2026-11-01" }] };
 * groundedLiterals(check, "count invoices over $500 due after 2026-11-30");
 * // { ok: false, missing: [{ path: "where[1].value", kind: "date", value: "2026-11-01" }] }
 */
export function groundedLiterals(check, text) {
  if (!isObj(check)) {
    const r = groundedValues([], text);
    return { ok: false, missing: [{ path: "", kind: "check", value: carry(check) }], ...(r.why ? { why: r.why } : {}) };
  }
  /** @type {{path: string, kind: string, value: any}[]} */
  const lits = [];
  const where = read(check, "where");
  if (where === UNREADABLE) lits.push({ path: "where", kind: "invalid", value: UNREADABLE });
  else if (Array.isArray(where)) {
    let len = 0;
    try {
      len = where.length;
    } catch {
      lits.push({ path: "where", kind: "invalid", value: UNREADABLE });
    }
    for (let i = 0; i < len; i++) {
      let w;
      try {
        w = where[i];
      } catch {
        continue;
      }
      if (!isObj(w)) continue;
      const cmp = read(w, "cmp");
      const kind = NUM_VALUE.includes(cmp) || cmp === "between" ? "number" : DATE_VALUE.includes(cmp) || cmp === "dateBetween" ? "date" : null;
      if (kind === null) continue; // equals, empty, notEmpty, or an unknown cmp (checkTables / createRubric refuse that)
      const fields = cmp === "between" || cmp === "dateBetween" ? ["lo", "hi"] : ["value"];
      for (const f of fields) lits.push({ path: `where[${i}].${f}`, kind, value: read(w, f) });
    }
  }
  const asOf = read(check, "asOf");
  if (asOf !== undefined) lits.push({ path: "asOf", kind: "date", value: asOf });
  const b = read(check, "b");
  if (isObj(b)) {
    const k = read(b, "const");
    if (k !== undefined) lits.push({ path: "b.const", kind: "number", value: k });
  }
  const r = groundedValues(/** @type {any} */ (lits.map((l) => ({ kind: l.kind, value: l.value }))), text);
  const missing = r.missing.map((m) => ({ path: lits[m.index].path, kind: lits[m.index].kind, value: m.value }));
  return { ok: r.ok, missing, ...(r.why ? { why: r.why } : {}) };
}
