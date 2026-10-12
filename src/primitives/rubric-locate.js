// The PURE decide core of the `locate` judge (docs/product/rubric-prd.md §5.2, RULED #30-#46).
//
// Everything here is side-effect free and takes plain data: ONE quote string and ONE signed decide (or the
// signed LIST of decides). It never calls a judge, never touches the gate or an audit, and is not exported
// from src/index.js (Module 2 wires it into createRubric / checkStep).
//
// Extraction is hand-coded: a single left-to-right pass over UTF-16 code units, no regex with backtracking,
// no user regex. Text is the quote after `normalizeForQuote` (the text `quoteIn` proved), digits are ASCII
// 0-9 only. Number and money values are EXACT decimals ({neg, int, frac} digit strings), never IEEE floats.

import { normalizeForQuote, carries, clip } from "./rubric.js";

const MAX_ITEMS = 20; // list bound inside a gap (same as rubric.js)
const U_MINUS = 0x2212; // "−", never read as a minus, never dropped
const CURRENCY = new Set(["$", "€", "£"]);

// --- character classes -------------------------------------------------------

const isDigit = (c) => c >= 48 && c <= 57;
const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isWs = (c) => c === 32 || (c >= 9 && c <= 13);

// --- exact decimals ----------------------------------------------------------

/**
 * Parse text[a, b) as the numeric-run grammar `D+ ( "," D D D )* ( "." D+ )?` (first group 1-3 digits when
 * any "," is present, later groups exactly 3, at most one ".", then at least one digit). Null = malformed.
 * Returns an unsigned, normalized decimal {neg:false, int, frac}.
 */
function parseGrammar(text, a, b) {
  let i = a;
  while (i < b && isDigit(text.charCodeAt(i))) i++;
  const first = i - a;
  if (first === 0) return null;
  let int;
  if (i < b && text.charCodeAt(i) === 44) {
    if (first > 3) return null;
    const parts = [text.slice(a, i)];
    while (i < b && text.charCodeAt(i) === 44) {
      if (i + 4 > b) return null; // need ",ddd" fully inside the run
      for (let k = 1; k <= 3; k++) if (!isDigit(text.charCodeAt(i + k))) return null;
      if (i + 4 < b && isDigit(text.charCodeAt(i + 4))) return null; // a 4th digit in the group
      parts.push(text.slice(i + 1, i + 4));
      i += 4;
    }
    int = parts.join("");
  } else {
    int = text.slice(a, i);
  }
  let frac = "";
  if (i < b) {
    if (text.charCodeAt(i) !== 46) return null;
    const f = i + 1;
    if (f >= b) return null;
    for (let k = f; k < b; k++) if (!isDigit(text.charCodeAt(k))) return null;
    frac = text.slice(f, b);
  }
  return normDec(false, int, frac);
}

function normDec(neg, int, frac) {
  let s = 0;
  while (s < int.length - 1 && int.charCodeAt(s) === 48) s++;
  if (s > 0) int = int.slice(s);
  let e = frac.length;
  while (e > 0 && frac.charCodeAt(e - 1) === 48) e--;
  if (e < frac.length) frac = frac.slice(0, e);
  if (int === "0" && frac === "") neg = false; // -0 equals 0
  return { neg, int, frac };
}

function decToString(d) {
  return (d.neg ? "-" : "") + d.int + (d.frac ? "." + d.frac : "");
}

function cmpMag(a, b) {
  if (a.int.length !== b.int.length) return a.int.length < b.int.length ? -1 : 1;
  if (a.int !== b.int) return a.int < b.int ? -1 : 1;
  if (a.frac !== b.frac) return a.frac < b.frac ? -1 : 1; // trailing zeros are stripped, so lexicographic is exact
  return 0;
}

function cmpDec(a, b) {
  if (a.neg !== b.neg) return a.neg ? -1 : 1;
  const m = cmpMag(a, b);
  return a.neg ? -m : m;
}

// --- token prefix (what stands directly before a token) ----------------------

const OK = 0;
const MAL = 1;
const NEG = 2;

/**
 * Classify the char before a token that starts at `s`. Letter = malformed (adjacency). U+2212 = malformed
 * (f.minus). "-" at the start / after whitespace / after "(" is a SIGN (negative for number, malformed
 * for money and time); any other "-" is a separator. "(" = malformed (f.paren). "." or "," = malformed
 * (f.dotcomma, a leading ".5").
 */
function prefixOf(text, s, f) {
  if (s === 0) return OK;
  const p = text.charCodeAt(s - 1);
  if (isLetter(p)) return MAL;
  if (f.minus && p === U_MINUS) return MAL;
  if (p === 45 && f.signs) {
    const ctx = s - 1 === 0 || isWs(text.charCodeAt(s - 2)) || text.charCodeAt(s - 2) === 40;
    if (ctx) return f.negOk ? NEG : MAL;
    return OK;
  }
  if (f.paren && p === 40) return MAL;
  if (f.dotcomma && (p === 46 || p === 44)) return MAL;
  return OK;
}

const F_NUMBER = { minus: true, signs: true, negOk: true, paren: true, dotcomma: true };
const F_CURRENCY = { minus: true, signs: true, negOk: false, paren: true, dotcomma: false };
const F_UNIT = { minus: true, signs: true, negOk: false, paren: true, dotcomma: true };
const F_TIME = { minus: true, signs: true, negOk: false, paren: false, dotcomma: false };
const F_DATE = { minus: false, signs: false, negOk: false, paren: false, dotcomma: false };

// A token result is `{ end, tok }`: `end` is where the scan resumes; `tok` is undefined (nothing here),
// `{ mal: true, raw }` (shaped but invalid, unsure = red) or `{ value, raw }`.
const ignored = (end) => ({ end, tok: undefined });
const malformed = (text, from, end) => ({ end, tok: { mal: true, raw: text.slice(from, end) } });

/** The numeric run starting at the digit `s`: [s, e) is maximal over 0-9 , . ; t is e minus trailing . and , */
function numRun(text, s) {
  const n = text.length;
  let e = s;
  while (e < n) {
    const c = text.charCodeAt(e);
    if (isDigit(c) || c === 44 || c === 46) e++;
    else break;
  }
  let t = e;
  while (t > s) {
    const c = text.charCodeAt(t - 1);
    if (c === 44 || c === 46) t--;
    else break;
  }
  return { e, t };
}

function readNumber(text, s) {
  if (!isDigit(text.charCodeAt(s))) return ignored(s + 1);
  const { e, t } = numRun(text, s);
  const pre = prefixOf(text, s, F_NUMBER);
  const from = pre === OK || pre === NEG ? s : s - 1;
  if (pre === MAL || isLetter(text.charCodeAt(e))) return malformed(text, from, e);
  const dec = parseGrammar(text, s, t);
  if (dec === null) return malformed(text, s, e);
  if (pre === NEG && !(dec.int === "0" && dec.frac === "")) dec.neg = true;
  return { end: e, tok: { value: dec, raw: text.slice(s, t) } };
}

function readCurrency(text, s, symbol) {
  if (text.charAt(s) !== symbol || !isDigit(text.charCodeAt(s + 1))) return ignored(s + 1);
  const { e, t } = numRun(text, s + 1);
  const pre = prefixOf(text, s, F_CURRENCY);
  const from = pre === OK ? s : s - 1;
  if (pre !== OK || isLetter(text.charCodeAt(e))) return malformed(text, from, e);
  const dec = parseGrammar(text, s + 1, t);
  if (dec === null) return malformed(text, s, e);
  return { end: e, tok: { value: dec, raw: text.slice(s, t) } };
}

function readUnit(text, s, unit) {
  if (!isDigit(text.charCodeAt(s))) return ignored(s + 1);
  const { e, t } = numRun(text, s);
  const unitAt = (u) => text.startsWith(unit, u) && !isLetter(text.charCodeAt(u + unit.length));
  let matched = false;
  let end = e;
  if (text.charCodeAt(t) === 32 && unitAt(t + 1)) {
    matched = true;
    end = t + 1 + unit.length;
  } else {
    // letters glued to the number, then the unit (1.2k US dollars): shaped like a value, so unsure = red
    let L = t;
    while (isLetter(text.charCodeAt(L))) L++;
    if (L > t && text.charCodeAt(L) === 32 && unitAt(L + 1)) return malformed(text, s, L);
  }
  if (!matched) return ignored(e); // a number NOT followed by one space + the unit is not a value of this decide
  const pre = prefixOf(text, s, F_UNIT);
  if (pre !== OK) return malformed(text, s - 1, end);
  const dec = parseGrammar(text, s, t);
  if (dec === null) return malformed(text, s, end);
  return { end, tok: { value: dec, raw: text.slice(s, t) } };
}

// --- date ---------------------------------------------------------------------

function isLeap(y) {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function validDate(y, m, d) {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}

function readDate(text, s) {
  const n = text.length;
  const c0 = text.charCodeAt(s);
  if (!isDigit(c0) && c0 !== 45) return ignored(s + 1);
  let e = s;
  while (e < n) {
    const c = text.charCodeAt(e);
    if (isDigit(c) || c === 45) e++;
    else break;
  }
  if (e - s !== 10) return ignored(e);
  for (let k = 0; k < 10; k++) {
    const c = text.charCodeAt(s + k);
    if (k === 4 || k === 7 ? c !== 45 : !isDigit(c)) return ignored(e);
  }
  const y = +text.slice(s, s + 4);
  const m = +text.slice(s + 5, s + 7);
  const d = +text.slice(s + 8, s + 10);
  const pre = prefixOf(text, s, F_DATE);
  if (pre !== OK || isLetter(text.charCodeAt(e)) || !validDate(y, m, d)) return malformed(text, pre === OK ? s : s - 1, e);
  return { end: e, tok: { value: text.slice(s, e), raw: text.slice(s, e) } };
}

// --- time ---------------------------------------------------------------------

/**
 * Time token read forward from `s` (the first char of a run over 0-9 and ":"). A run with no ":" (or no
 * digit) is not a time. A run with ":" must be exactly d:dd or dd:dd. Then the suffix look-ahead: exactly
 * " AM" / " PM" (uppercase, one space, not followed by a letter) = 12-hour; a lowercase/mixed/dotted
 * spelling or an uppercase AM/PM with letters glued on = malformed; any other following word (a word that
 * merely starts "Am", like "American") leaves a 24-hour time. Value = minutes since midnight.
 */
function readTime(text, s) {
  const n = text.length;
  let e = s;
  let colon = false;
  let digit = false;
  while (e < n) {
    const c = text.charCodeAt(e);
    if (isDigit(c)) digit = true;
    else if (c === 58) colon = true;
    else break;
    e++;
  }
  if (e === s || !colon || !digit) return ignored(Math.max(e, s + 1));
  const pre = prefixOf(text, s, F_TIME);
  const from = pre === OK ? s : s - 1;
  const run = e - s;
  let h = 0;
  let m = 0;
  let shape = false;
  if (run === 4 && isDigit(text.charCodeAt(s)) && text.charCodeAt(s + 1) === 58 && isDigit(text.charCodeAt(s + 2)) && isDigit(text.charCodeAt(s + 3))) {
    h = text.charCodeAt(s) - 48;
    m = (text.charCodeAt(s + 2) - 48) * 10 + (text.charCodeAt(s + 3) - 48);
    shape = true;
  } else if (run === 5 && isDigit(text.charCodeAt(s)) && isDigit(text.charCodeAt(s + 1)) && text.charCodeAt(s + 2) === 58 && isDigit(text.charCodeAt(s + 3)) && isDigit(text.charCodeAt(s + 4))) {
    h = (text.charCodeAt(s) - 48) * 10 + (text.charCodeAt(s + 1) - 48);
    m = (text.charCodeAt(s + 3) - 48) * 10 + (text.charCodeAt(s + 4) - 48);
    shape = true;
  }
  if (pre !== OK || !shape || m > 59) return malformed(text, from, e);
  const after = text.charCodeAt(e);
  if (isLetter(after)) return malformed(text, from, e); // 08:10am, 9:27AM
  let suffix = ""; // "AM" | "PM" | ""
  if (isWs(after)) {
    let w0 = e + 1;
    while (isWs(text.charCodeAt(w0))) w0++;
    const single = w0 === e + 1 && after === 32; // exactly ONE space (two spaces or a tab is not the suffix)
    let w = w0;
    while (isLetter(text.charCodeAt(w))) w++;
    const L = w - w0;
    const c1 = text.charCodeAt(w0);
    const c2 = text.charCodeAt(w0 + 1);
    const lc1 = c1 | 32;
    if (L === 1 && (lc1 === 97 || lc1 === 112) && text.charCodeAt(w0 + 1) === 46 && (text.charCodeAt(w0 + 2) | 32) === 109) {
      return malformed(text, from, w0 + 3); // "a.m." / "p.m." (any case): the dotted spelling is not accepted
    }
    if (L >= 2 && (lc1 === 97 || lc1 === 112) && (c2 | 32) === 109) {
      const upperExact = (c1 === 65 || c1 === 80) && c2 === 77;
      if (L === 2) {
        if (!upperExact || !single) return malformed(text, from, w); // 9:27 am, 9:27 Am, 9:27  AM
        suffix = c1 === 65 ? "AM" : "PM";
      } else if (upperExact) {
        return malformed(text, from, w); // 9:27 AMX: a word glued to the suffix
      } // else a word that merely starts "Am" / "Pm" ("American"): the 24-hour time, then a word
    }
  }
  if (suffix === "") {
    if (h > 23) return malformed(text, from, e); // 24:00
    return { end: e, tok: { value: h * 60 + m, raw: text.slice(s, e) } };
  }
  const end = e + 3;
  if (h < 1 || h > 12) return malformed(text, from, end); // 0:30 AM, 13:05 PM
  const hh = h % 12 + (suffix === "PM" ? 12 : 0);
  return { end, tok: { value: hh * 60 + m, raw: text.slice(s, end) } };
}

function timeToString(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
}

// --- per-kind plumbing --------------------------------------------------------

/** The reader for a decide's valueKind: `(text, s) => {end, tok}`. Null for an unknown kind. */
function readerFor(d) {
  switch (d.valueKind) {
    case "number":
      return { read: readNumber, starts: (c) => isDigit(c), prefixes: true };
    case "money":
      if (typeof d.unit === "string") return { read: (t, s) => readUnit(t, s, d.unit), starts: (c) => isDigit(c), prefixes: true };
      return { read: (t, s) => readCurrency(t, s, d.currency), starts: (c) => d.currency !== undefined && c === d.currency.charCodeAt(0), prefixes: true };
    case "date":
      return { read: readDate, starts: (c) => isDigit(c) || c === 45, quick: quickDate, prefixes: false };
    case "time":
      return { read: readTime, starts: (c) => isDigit(c) || c === 58, quick: quickTime, prefixes: true };
    default:
      return null;
  }
}

// Allocation-free pre-checks for the scan loop: the end of a run that cannot be a token (-1 = might be one).
function quickDate(text, s) {
  let e = s;
  for (let c = text.charCodeAt(e); isDigit(c) || c === 45; c = text.charCodeAt(e)) e++;
  return e - s === 10 ? -1 : e;
}

function quickTime(text, s) {
  let e = s;
  let colon = false;
  let digit = false;
  for (let c = text.charCodeAt(e); isDigit(c) || c === 58; c = text.charCodeAt(e)) {
    if (c === 58) colon = true;
    else digit = true;
    e++;
  }
  return colon && digit ? -1 : Math.max(e, s + 1);
}

function displayOf(kind, v) {
  if (kind === "time") return timeToString(v);
  if (kind === "date") return v;
  return decToString(v);
}

/** Canonical comparable form of an extracted value: decimal string, YYYY-MM-DD string, or integer minutes. */
function canonOf(kind, v) {
  return kind === "time" ? v : kind === "date" ? v : decToString(v);
}

function cmpValues(kind, a, b) {
  if (kind === "time") return a < b ? -1 : a > b ? 1 : 0;
  if (kind === "date") return a < b ? -1 : a > b ? 1 : 0;
  return cmpDec(a, b);
}

// --- bounds -------------------------------------------------------------------

/**
 * Parse a signed bound (`value`, `lo`, `hi`) with the SAME parser as the quote. `number` / `money`: a finite JS
 * number whose `String(n)` is a plain decimal (no exponent). `date`: a string that is exactly one real ISO
 * date. `time`: a string that is exactly one time token (24-hour or `h:mm AM|PM`). Returns
 * `{ ok: true, value, canon }` (value = the internal exact form) or `{ ok: false }`. Never throws.
 */
export function parseBound(valueKind, raw) {
  try {
    if (valueKind === "number" || valueKind === "money") {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false };
      let s = String(raw);
      let neg = false;
      if (s.charCodeAt(0) === 45) {
        neg = true;
        s = s.slice(1);
      }
      const dec = parseGrammar(s, 0, s.length);
      if (dec === null) return { ok: false }; // exponent forms ("1e+21") fail the grammar
      if (neg && !(dec.int === "0" && dec.frac === "")) dec.neg = true;
      return { ok: true, value: dec, canon: decToString(dec) };
    }
    if (valueKind === "date" || valueKind === "time") {
      if (typeof raw !== "string" || raw.length === 0) return { ok: false };
      const r = valueKind === "date" ? readDate(raw, 0) : readTime(raw, 0);
      if (!r.tok || r.tok.mal || r.end !== raw.length) return { ok: false };
      return { ok: true, value: r.tok.value, canon: r.tok.value };
    }
  } catch {
    // fall through
  }
  return { ok: false };
}

/**
 * Compare two already-parsed bounds (the internal `value` of `parseBound`) of one `valueKind`: -1, 0, 1.
 * Used by `createRubric` to refuse `lo > hi`.
 */
export function compareBounds(valueKind, a, b) {
  return cmpValues(valueKind, a, b);
}

/** Display form of a canonical comparable value (what `extracted` / `parseClaimValue().canon` hold): decimal, YYYY-MM-DD, HH:MM. */
export function displayCanon(valueKind, canon) {
  return valueKind === "time" ? timeToString(canon) : String(canon);
}

/**
 * Parse the value a WORKER declared for a claim (docs/product/rubric-prd.md §4.6, RULED #49): a bare STRING
 * holding exactly one token of the decide's `valueKind` and nothing else (surrounding whitespace is fine,
 * after `normalizeForQuote`). Same grammar and readers as a value found in a quote:
 * `number` an exact decimal (a leading `-` is allowed), `money` a non-negative decimal with NO currency
 * symbol and NO unit text, `date` one ISO `YYYY-MM-DD`, `time` one 24-hour or `h:mm AM|PM` token.
 * Returns `{ ok: true, canon }` (canon = the comparable form `evalDecide` reports as `extracted`) or
 * `{ ok: false }`. A non-string (a JSON number, null, an object) is `{ ok: false }`. Never throws.
 */
export function parseClaimValue(valueKind, raw) {
  try {
    if (typeof raw !== "string") return { ok: false };
    const text = normalizeForQuote(raw);
    if (text === "") return { ok: false };
    let r;
    if (valueKind === "number") {
      const s = text.charCodeAt(0) === 45 ? 1 : 0; // a sign is judged by the token reader
      r = readNumber(text, s);
      if (r.tok && !r.tok.mal && s + r.tok.raw.length !== text.length) return { ok: false }; // trailing "." / "," or more text
    } else if (valueKind === "money") {
      if (!isDigit(text.charCodeAt(0))) return { ok: false }; // "-5", "$59", " 59" are not a money value here
      r = readNumber(text, 0);
      if (r.tok && !r.tok.mal && r.tok.raw.length !== text.length) return { ok: false };
    } else if (valueKind === "date") {
      r = readDate(text, 0);
    } else if (valueKind === "time") {
      r = readTime(text, 0);
    } else {
      return { ok: false };
    }
    if (!r.tok || r.tok.mal || r.end !== text.length) return { ok: false };
    return { ok: true, canon: canonOf(valueKind, r.tok.value) };
  } catch {
    return { ok: false };
  }
}

// --- extraction -----------------------------------------------------------------

/**
 * Extract the ONE value of a decide's `valueKind` from already-normalized `text`.
 * No anchor: exactly one token of the kind (zero = `value-none`, two or more = `value-many`, any malformed
 * token = `value-malformed`). With `anchor`: the anchor (normalized, case-sensitive) must occur exactly once
 * (`anchor-missing` / `anchor-ambiguous`) and the token must BEGIN right after it (only whitespace between),
 * else `value-none`; a malformed token there is `value-malformed`.
 * Returns `{ ok: true, value, canon }` or `{ ok: false, kind, ...fields }`. Never throws on any string.
 */
export function extractValue(decide, text) {
  const rd = readerFor(decide);
  if (typeof text !== "string" || rd === null) return { ok: false, kind: "value-none", ...(anchorField(decide)) };
  const kind = decide.valueKind;

  if (decide.anchor !== undefined) {
    const a = typeof decide.anchor === "string" ? normalizeForQuote(decide.anchor) : "";
    if (a === "") return { ok: false, kind: "anchor-missing", anchor: decide.anchor, measured: 0 };
    let count = 0;
    let first = -1;
    for (let at = text.indexOf(a); at !== -1 && count < 1000; at = text.indexOf(a, at + 1)) {
      if (count === 0) first = at;
      count++;
    }
    if (count === 0) return { ok: false, kind: "anchor-missing", anchor: decide.anchor, measured: 0 };
    if (count > 1) return { ok: false, kind: "anchor-ambiguous", anchor: decide.anchor, measured: count };
    let p = first + a.length;
    while (p < text.length && isWs(text.charCodeAt(p))) p++;
    let q = p;
    if (rd.prefixes) {
      const c = text.charCodeAt(p);
      if (c === 45 || c === U_MINUS || c === 40) q = p + 1; // a sign / "(" directly before the token is judged by the token
    }
    const r = q < text.length ? rd.read(text, q) : { tok: undefined };
    if (r.tok === undefined) return { ok: false, kind: "value-none", anchor: decide.anchor };
    if (r.tok.mal) return { ok: false, kind: "value-malformed", measured: clip(r.tok.raw) };
    return { ok: true, value: r.tok.value, canon: canonOf(kind, r.tok.value) };
  }

  const n = text.length;
  let count = 0;
  const items = [];
  let firstVal;
  let mal;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (!rd.starts(c)) {
      i++;
      continue;
    }
    if (rd.quick !== undefined) {
      const skip = rd.quick(text, i);
      if (skip !== -1) {
        i = skip;
        continue;
      }
    }
    const r = rd.read(text, i);
    if (r.tok !== undefined) {
      if (r.tok.mal) {
        mal = r.tok;
        break; // a malformed token is never counted away: unsure = red
      }
      if (count === 0) firstVal = r.tok.value;
      count++;
      if (items.length < MAX_ITEMS) items.push(clip(String(displayOf(kind, r.tok.value))));
    }
    i = r.end > i ? r.end : i + 1;
  }
  if (mal) return { ok: false, kind: "value-malformed", measured: clip(mal.raw) };
  if (count === 0) return { ok: false, kind: "value-none" };
  if (count > 1) {
    return { ok: false, kind: "value-many", measured: count, items, ...(count > MAX_ITEMS ? { itemsTotal: count } : {}) };
  }
  return { ok: true, value: firstVal, canon: canonOf(kind, firstVal) };
}

function anchorField(d) {
  return d && d.anchor !== undefined ? { anchor: d.anchor } : {};
}

// --- one decide ---------------------------------------------------------------

const DIRECTION = { lt: "below", lte: "at-most", gt: "above", gte: "at-least" };

/**
 * Evaluate ONE decide on an already-normalized quote. Returns
 * `{ type: "value"|"presence", ok, kind?, ...gapFields, extracted? }`:
 * `extracted` (value decides) is the canonical comparable value when one was extracted (decimal string,
 * YYYY-MM-DD, or integer minutes) and is what `outcomeKey` compares across reads.
 */
export function evalDecide(decide, text) {
  if (Array.isArray(decide.phrases)) return evalPresence(decide, text);
  const ex = extractValue(decide, text);
  if (!ex.ok) {
    const { kind, ok: _ok, ...fields } = ex;
    return { type: "value", ok: false, kind, ...fields };
  }
  const k = decide.valueKind;
  const op = decide.op;
  const v = ex.value;
  const display = (x) => displayOf(k, x);
  const bad = (kind, bound, direction) => ({
    type: "value",
    ok: false,
    kind,
    measured: display(v),
    limit: display(bound),
    direction,
    extracted: ex.canon,
  });
  if (op === "between") {
    const lo = parseBound(k, decide.lo);
    const hi = parseBound(k, decide.hi);
    if (!lo.ok || !hi.ok) return { type: "value", ok: false, kind: "value-malformed", measured: "bound", extracted: ex.canon };
    if (cmpValues(k, v, hi.value) > 0) return bad("value-over", hi.value, "at-most");
    if (cmpValues(k, v, lo.value) < 0) return bad("value-under", lo.value, "at-least");
    return { type: "value", ok: true, extracted: ex.canon };
  }
  const b = parseBound(k, decide.value);
  if (!b.ok || !(op in DIRECTION)) return { type: "value", ok: false, kind: "value-malformed", measured: "bound", extracted: ex.canon };
  const c = cmpValues(k, v, b.value);
  if (op === "lt" && !(c < 0)) return bad("value-over", b.value, "below");
  if (op === "lte" && !(c <= 0)) return bad("value-over", b.value, "at-most");
  if (op === "gt" && !(c > 0)) return bad("value-under", b.value, "above");
  if (op === "gte" && !(c >= 0)) return bad("value-under", b.value, "at-least");
  return { type: "value", ok: true, extracted: ex.canon };
}

function evalPresence(decide, text) {
  const lower = text.toLowerCase();
  for (const p of decide.phrases) {
    if (!carries(text, lower, p, false)) return { type: "presence", ok: false, kind: "phrase-missing", measured: p };
  }
  return { type: "presence", ok: true };
}

// --- the list on one quote ----------------------------------------------------

/**
 * Run the signed LIST of decides on ONE quote (co-location, RULED #36). The quote is normalized with
 * `normalizeForQuote` first; a non-string quote is the empty quote. ALL decides are evaluated (a failing
 * one hides nothing); the check passes only if every one passes.
 *
 * Returns `{ ok, kind?, ...firstRedFields, items, itemsTotal?, results }`:
 * `kind` + the kind-specific fields are the FIRST red decide's (signed order); `items` lists
 * `"d<i>:<kind>"` for every red decide (bounded 20, `itemsTotal` when cut); `results[i]` is decide i's
 * own result (with `index`). `decides` must be a non-empty array (a programmer error otherwise: throws).
 */
export function decideQuote(quote, decides) {
  if (!Array.isArray(decides) || decides.length === 0) throw new TypeError("decideQuote: decides must be a non-empty array");
  let text = "";
  try {
    text = typeof quote === "string" ? normalizeForQuote(quote) : "";
  } catch {
    text = "";
  }
  const results = [];
  const reds = [];
  for (let i = 0; i < decides.length; i++) {
    /** @type {any} */
    const r = { index: i, ...evalDecide(decides[i], text) };
    results.push(r);
    if (!r.ok) reds.push(r);
  }
  if (reds.length === 0) return { ok: true, results };
  const first = reds[0];
  // `items` is taken twice in the PRD (the d<i> list; value-many's listed values): the list-level gap keeps the
  // d<i> list under `items`, and the first red's own value list rides as `values` (see the Module 1 report).
  /** @type {any} */
  const { index: _i, type: _t, ok: _o, extracted: _e, items: firstItems, itemsTotal: firstTotal, ...gapFields } = first;
  if (firstItems !== undefined) gapFields.values = firstItems;
  if (firstTotal !== undefined) gapFields.valuesTotal = firstTotal;
  const list = reds.slice(0, MAX_ITEMS).map((r) => `d${r.index}:${r.kind}`);
  return {
    ok: false,
    ...gapFields,
    items: list,
    ...(reds.length > MAX_ITEMS ? { itemsTotal: reds.length } : {}),
    results,
  };
}

/**
 * The comparable canonical outcome of ONE read (RULED #38): overall green/red plus, per decide in signed
 * order, its red kind (or "ok") and the extracted value in exact normalized form (null when none could be
 * extracted; value-many carries its count and listed values). Raw quotes are NOT part of it. Two reads agree
 * iff their keys are equal.
 */
export function outcomeKey(decided) {
  const per = (decided && Array.isArray(decided.results) ? decided.results : []).map((r) => {
    const ext = r.extracted !== undefined ? r.extracted : r.kind === "value-many" ? { count: r.measured, items: r.items } : null;
    return [r.type, r.ok ? "ok" : r.kind, ext];
  });
  return JSON.stringify([!!(decided && decided.ok), per]);
}
