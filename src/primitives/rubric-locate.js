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
import { isRealDay, monthTable, customMonthTable, MONTH_NAME_MAX } from "./rubric-months.js";

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
function parseGrammar(text, a, b, comma = false) {
  if (comma) return parseGrammarComma(text, a, b);
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

/**
 * RULED #68, `decimal: ","`: the mirrored grammar `D+ | D{1,3} (SEP D{3})+` then optionally `"," D+`, SEP being "." or a single space, ONE
 * kind per run (mixing is malformed). The first group is 1-3 digits when grouped, later groups exactly 3. Null = malformed.
 */
function parseGrammarComma(text, a, b) {
  let i = a;
  while (i < b && isDigit(text.charCodeAt(i))) i++;
  const first = i - a;
  if (first === 0) return null;
  let int;
  const sep = text.charCodeAt(i);
  if (i < b && (sep === 46 || sep === 32)) {
    if (first > 3) return null;
    const parts = [text.slice(a, i)];
    while (i < b && text.charCodeAt(i) === sep) {
      if (i + 4 > b) return null; // need SEP + ddd fully inside the run
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
    if (text.charCodeAt(i) !== 44) return null; // after the grouping only the decimal comma may follow (this also refuses a mixed SEP)
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
const malformed = (text, from, end) => ({ end, tok: { mal: true, raw: text.slice(from, end), vs: from, ve: end } });

/** The numeric run starting at the digit `s`: [s, e) is maximal over 0-9 , . ; t is e minus trailing . and , */
function numRun(text, s, comma = false) {
  const n = text.length;
  let e = s;
  if (!comma) {
    while (e < n) {
      const c = text.charCodeAt(e);
      if (isDigit(c) || c === 44 || c === 46) e++;
      else break;
    }
  } else {
    // RULED #68: with `decimal: ","` a single space joins the run only after 1-3 digits of a group, before exactly three digits
    // (not followed by a digit), and only while no "," has been read (so "2026 123" and "12,50 123" do not join).
    let g = 0; // digits since the last separator
    let seenComma = false;
    while (e < n) {
      const c = text.charCodeAt(e);
      if (isDigit(c)) g++;
      else if (c === 46 || c === 44) {
        if (c === 44) seenComma = true;
        g = 0;
      } else if (c === 32 && g >= 1 && g <= 3 && !seenComma && isDigit(text.charCodeAt(e + 1)) && isDigit(text.charCodeAt(e + 2)) && isDigit(text.charCodeAt(e + 3)) && !isDigit(text.charCodeAt(e + 4))) {
        g = 0;
      } else break;
      e++;
    }
  }
  let t = e;
  while (t > s) {
    const c = text.charCodeAt(t - 1);
    if (c === 44 || c === 46) t--;
    else break;
  }
  return { e, t };
}

function readNumber(text, s, comma = false) {
  if (!isDigit(text.charCodeAt(s))) return ignored(s + 1);
  const { e, t } = numRun(text, s, comma);
  const pre = prefixOf(text, s, F_NUMBER);
  const from = pre === OK || pre === NEG ? s : s - 1;
  if (pre === MAL || isLetter(text.charCodeAt(e))) return malformed(text, from, e);
  const dec = parseGrammar(text, s, t, comma);
  if (dec === null) return malformed(text, s, e);
  if (pre === NEG && !(dec.int === "0" && dec.frac === "")) dec.neg = true;
  return { end: e, tok: { value: dec, raw: text.slice(s, t), vs: pre === NEG ? s - 1 : s, ve: t } };
}

/** Does `unit` stand at `u` (exact case, not followed by an ASCII letter)? The one unit-match rule, shared by readUnit and readCurrency. */
function unitAt(text, u, unit) {
  return text.startsWith(unit, u) && !isLetter(text.charCodeAt(u + unit.length));
}

function readCurrency(text, s, symbol, units, comma, symCodes) {
  if (text.charAt(s) !== symbol || !isDigit(text.charCodeAt(s + 1))) return ignored(s + 1);
  const { e, t } = numRun(text, s + 1, comma);
  const pre = prefixOf(text, s, F_CURRENCY);
  const from = pre === OK ? s : s - 1;
  if (pre !== OK || isLetter(text.charCodeAt(e))) return malformed(text, from, e);
  // RULED #68: a signed symbol on BOTH sides ("$43$", "€43€", "$43€" with both signed) is unsure = red
  if (t === e && symCodes.has(text.charCodeAt(e))) return malformed(text, s, e + 1);
  const dec = parseGrammar(text, s + 1, t, comma);
  if (dec === null) return malformed(text, s, e);
  const tok = { value: dec, raw: text.slice(s, t), vs: s + 1, ve: t, cs: s, ce: s + 1 };
  // RULED #66: the unit directly after a symbol form ("$43 US dollars") is located here, as evidence only: `end`, the value and
  // the scan's resume point are untouched. Longest signed unit that matches wins.
  if (units !== undefined && units.length > 0 && text.charCodeAt(t) === 32) {
    let best = -1;
    for (const u of units) {
      if (unitAt(text, t + 1, u) && t + 1 + u.length > best) best = t + 1 + u.length;
    }
    if (best !== -1) {
      tok.us = t + 1;
      tok.ue = best;
    }
  }
  return { end: e, tok };
}

/**
 * RULED #68: a signed currency symbol glued AFTER the digits ("499€", "29,99€"), whole numbers included. Starts at the first digit of
 * the run. No signed symbol directly after the digits = not a value of this form (ignored, the whole run skipped). A letter or digit
 * after the symbol, or a bad prefix, is malformed (as for the unit form); the value's span is the digits, the `currency` span the symbol.
 */
function readCurrencyAfter(text, s, symCodes, comma) {
  const { e, t } = numRun(text, s, comma);
  if (t !== e || !symCodes.has(text.charCodeAt(e))) return ignored(e);
  const sym = e + 1;
  const pre = prefixOf(text, s, F_UNIT);
  if (pre !== OK || (sym < text.length && isWordCp(text.codePointAt(sym)))) return malformed(text, pre === OK ? s : s - 1, sym);
  const dec = parseGrammar(text, s, t, comma);
  if (dec === null) return malformed(text, s, sym);
  return { end: sym, tok: { value: dec, raw: text.slice(s, t), vs: s, ve: t, cs: e, ce: sym } };
}

function readUnit(text, s, unit, comma = false) {
  if (!isDigit(text.charCodeAt(s))) return ignored(s + 1);
  const { e, t } = numRun(text, s, comma);
  let matched = false;
  let end = e;
  if (text.charCodeAt(t) === 32 && unitAt(text, t + 1, unit)) {
    matched = true;
    end = t + 1 + unit.length;
  } else {
    // letters glued to the number, then the unit (1.2k US dollars): shaped like a value, so unsure = red
    let L = t;
    while (isLetter(text.charCodeAt(L))) L++;
    if (L > t && text.charCodeAt(L) === 32 && unitAt(text, L + 1, unit)) return malformed(text, s, L);
  }
  if (!matched) return ignored(e); // a number NOT followed by one space + the unit is not a value of this decide
  const pre = prefixOf(text, s, F_UNIT);
  if (pre !== OK) return malformed(text, s - 1, end);
  const dec = parseGrammar(text, s, t, comma);
  if (dec === null) return malformed(text, s, end);
  return { end, tok: { value: dec, raw: text.slice(s, t), vs: s, ve: t, us: t + 1, ue: end } };
}

// --- date ---------------------------------------------------------------------

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
  if (pre !== OK || isLetter(text.charCodeAt(e)) || !isRealDay(y, m, d)) return malformed(text, pre === OK ? s : s - 1, e);
  return { end: e, tok: { value: text.slice(s, e), raw: text.slice(s, e), vs: s, ve: e } };
}

// --- date in a signed language (RULED #68) --------------------------------------
// `lang` / `months` add three forms to the ISO one, each ONE token read left to right by the hand-coded reader below:
//   day-month-year   D[.] <month> YYYY            every signed lang and `months`
//   with connectors  D de <month> de YYYY         es / pt only; both connectors or neither
//   month-day-year   <month> D, YYYY              lang "en" only; the comma is required
// The month word is a whole word (never preceded or followed by a letter, a short form's "." aside). The value is the ISO string.

const UNI_LETTER = /^[\p{L}\p{M}]$/u;
const isLetterCp = (cp) => UNI_LETTER.test(String.fromCodePoint(cp));
const letterAt = (t, i) => i < t.length && isLetterCp(t.codePointAt(i));
/** Is the code point ENDING at `i` (exclusive) a letter or mark? */
const letterBefore = (t, i) => i >= 1 && isLetterCp(cpEndingAt(t, i));
const isDe = (t, p) => (t.charCodeAt(p) | 32) === 100 && (t.charCodeAt(p + 1) | 32) === 101 && t.charCodeAt(p + 2) === 32;

/** The month word at `p` (a whole word of letters, optionally with a short form's trailing "."): `{ month, end }` or null. */
function readMonthWord(text, p, table) {
  let b = p;
  let count = 0;
  while (b < text.length && count <= MONTH_NAME_MAX) {
    const cp = text.codePointAt(b);
    if (!isLetterCp(cp)) break;
    b += cp > 0xffff ? 2 : 1;
    count++;
  }
  if (b === p || count > MONTH_NAME_MAX) return null;
  const key = text.slice(p, b).toLowerCase();
  if (text.charCodeAt(b) === 46) {
    const dotted = table.get(key + ".");
    if (dotted !== undefined) return { month: dotted, end: b + 1 };
  }
  const month = table.get(key);
  return month === undefined ? null : { month, end: b };
}

/** Read exactly four digits at `p` (the year; not followed by a digit). Returns the year or -1. */
function yearAt(text, p) {
  for (let k = 0; k < 4; k++) if (!isDigit(text.charCodeAt(p + k))) return -1;
  return isDigit(text.charCodeAt(p + 4)) ? -1 : +text.slice(p, p + 4);
}

const pad2 = (n) => (n < 10 ? "0" : "") + n;

/** The finished token for a complete date shape [s, end): malformed on an ordinal, a letter before `s` / after the year, or a non-calendar day. */
function dateToken(text, s, end, y, m, d, ordinal, checkBefore) {
  const bad = ordinal || (checkBefore && letterBefore(text, s)) || letterAt(text, end) || !isRealDay(y, m, d);
  if (bad) return malformed(text, checkBefore && letterBefore(text, s) ? s - 1 : s, end);
  const iso = String(y).padStart(4, "0") + "-" + pad2(m) + "-" + pad2(d);
  return { end, tok: { value: iso, raw: text.slice(s, end), vs: s, ve: end } };
}

/** `D[.] <month> YYYY` (with the es/pt connectors) from the run of 1-2 digits [s, e). */
function readDayFirst(text, s, e, table, connector) {
  let p = e;
  let ordinal = false;
  if (letterAt(text, p)) {
    ordinal = true; // a day with a letter suffix ("5th"): malformed when the rest is a complete date shape, else ignored
    while (letterAt(text, p)) p += text.codePointAt(p) > 0xffff ? 2 : 1;
  } else if (text.charCodeAt(p) === 46) p++; // the day dot ("13. Oktober 2026")
  if (text.charCodeAt(p) !== 32) return ignored(e);
  p++;
  const de1 = connector && isDe(text, p);
  if (de1) p += 3;
  const m = readMonthWord(text, p, table);
  if (m === null || text.charCodeAt(m.end) !== 32) return ignored(e);
  p = m.end + 1;
  if (connector) {
    const de2 = isDe(text, p);
    if (de1 !== de2) return ignored(e); // both connectors or neither
    if (de2) p += 3;
  }
  const y = yearAt(text, p);
  if (y === -1) return ignored(e);
  return dateToken(text, s, p + 4, y, m.month, +text.slice(s, e), ordinal, true);
}

/** `<month> D, YYYY` (English) from the month word at `s`. */
function readMonthFirst(text, s, table) {
  if (letterBefore(text, s)) return ignored(s + 1); // not the start of a word
  const m = readMonthWord(text, s, table);
  if (m === null) return ignored(s + 1);
  let p = m.end;
  if (text.charCodeAt(p) !== 32) return ignored(m.end);
  p++;
  const ds = p;
  while (isDigit(text.charCodeAt(p)) && p - ds < 3) p++;
  if (p === ds || p - ds > 2) return ignored(m.end);
  const day = +text.slice(ds, p);
  let ordinal = false;
  if (letterAt(text, p)) {
    ordinal = true;
    while (letterAt(text, p)) p += text.codePointAt(p) > 0xffff ? 2 : 1;
  }
  if (text.charCodeAt(p) !== 44 || text.charCodeAt(p + 1) !== 32) return ignored(m.end);
  const y = yearAt(text, p + 2);
  if (y === -1) return ignored(m.end);
  return dateToken(text, s, p + 6, y, m.month, day, ordinal, false);
}

const customTables = new WeakMap(); // a signed `months` array -> its lookup (built once per array)

/** The reader of a `date` decide that signs `lang` or `months`. ISO `YYYY-MM-DD` keeps reading exactly as `readDate`. */
function dateLangReader(d) {
  let table;
  if (d.months !== undefined) {
    table = customTables.get(d.months);
    if (table === undefined) customTables.set(d.months, (table = customMonthTable(d.months)));
  } else table = monthTable(d.lang);
  if (table === null) return null;
  const monthFirst = d.months === undefined && d.lang === "en";
  const connector = d.months === undefined && (d.lang === "es" || d.lang === "pt");
  const runEnd = (text, s) => {
    let e = s;
    for (let c = text.charCodeAt(e); isDigit(c) || c === 45; c = text.charCodeAt(e)) e++;
    return e;
  };
  const shortDay = (text, s, e) => isDigit(text.charCodeAt(s)) && e - s <= 2 && (e - s === 1 || isDigit(text.charCodeAt(s + 1)));
  const read = (text, s) => {
    const c0 = text.charCodeAt(s);
    if (!isDigit(c0) && c0 !== 45) return monthFirst && isLetter(c0) ? readMonthFirst(text, s, table) : ignored(s + 1);
    const e = runEnd(text, s);
    if (e - s === 10) return readDate(text, s);
    return shortDay(text, s, e) ? readDayFirst(text, s, e, table, connector) : ignored(e);
  };
  const quick = (text, s) => {
    const c0 = text.charCodeAt(s);
    if (isLetter(c0)) return -1;
    const e = runEnd(text, s);
    return e - s === 10 || shortDay(text, s, e) ? -1 : e;
  };
  return { read, starts: (c) => isDigit(c) || c === 45 || (monthFirst && isLetter(c)), quick, prefixes: false };
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
    return { end: e, tok: { value: h * 60 + m, raw: text.slice(s, e), vs: s, ve: e } };
  }
  const end = e + 3;
  if (h < 1 || h > 12) return malformed(text, from, end); // 0:30 AM, 13:05 PM
  const hh = h % 12 + (suffix === "PM" ? 12 : 0);
  return { end, tok: { value: hh * 60 + m, raw: text.slice(s, end), vs: s, ve: end } };
}

function timeToString(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
}

// --- per-kind plumbing --------------------------------------------------------

/**
 * RULED #65: a money decide's reader is the UNION of its signed forms (each `currency` symbol, each `unit`), every form
 * keeping its own #37 / #43 grammar. A symbol start belongs to the currency forms, a digit start to the unit forms (a
 * symbol form consumes its digits, so "$43 US dollars" is one token). Among unit forms on one numeric run, a malformed
 * token wins, else the longest match, so the result never depends on the order the unit list was signed in.
 */
function moneyReader(d) {
  const symbols = d.currency === undefined ? [] : Array.isArray(d.currency) ? d.currency : [d.currency];
  const units = d.unit === undefined ? [] : Array.isArray(d.unit) ? d.unit : [d.unit];
  const symCodes = new Set(symbols.map((x) => x.charCodeAt(0)));
  const comma = d.decimal === ",";
  const read = (t, s) => {
    const c = t.charCodeAt(s);
    if (symCodes.has(c)) return readCurrency(t, s, t.charAt(s), units, comma, symCodes);
    if (symCodes.size > 0 && isDigit(c)) {
      const g = readCurrencyAfter(t, s, symCodes, comma); // RULED #68: the symbol glued after the digits
      if (g.tok !== undefined) return g;
    }
    /** @type {{ end: number, tok: any }} */
    let best = ignored(s + 1);
    for (const u of units) {
      const r = readUnit(t, s, u, comma);
      if (r.tok === undefined) {
        if (best.tok === undefined && r.end > best.end) best = r;
      } else if (r.tok.mal) return r;
      else if (best.tok === undefined || r.end > best.end) best = r;
    }
    return best;
  };
  return { read, starts: (c) => symCodes.has(c) || ((units.length > 0 || symCodes.size > 0) && isDigit(c)), prefixes: true, units };
}

/** The reader for a decide's valueKind: `(text, s) => {end, tok}`. Null for an unknown kind. */
function readerFor(d) {
  switch (d.valueKind) {
    case "number":
      return { read: d.decimal === "," ? (t, s) => readNumber(t, s, true) : readNumber, starts: (c) => isDigit(c), prefixes: true };
    case "money":
      return moneyReader(d);
    case "date":
      if (d.lang !== undefined || d.months !== undefined) return dateLangReader(d);
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
 * `{ ok: false }`. A non-string (a JSON number, null, an object) is `{ ok: false }`. The optional `decide` only matters for a `number` / `money` decide
 * that signs `decimal: ","`: a claim value containing a "," is `{ ok: false }`. Never throws.
 */
export function parseClaimValue(valueKind, raw, decide) {
  try {
    if (typeof raw !== "string") return { ok: false };
    const text = normalizeForQuote(raw);
    if (text === "") return { ok: false };
    // RULED #68: on a decide that signs `decimal: ","` the claim stays a canonical "."-decimal; a "," is never read (unsure = red)
    if (decide !== undefined && decide !== null && decide.decimal === "," && (valueKind === "number" || valueKind === "money") && text.includes(",")) return { ok: false };
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

// --- text (RULED #58) -----------------------------------------------------------

/** Longest `text` claim value, in UTF-16 code units, counted after normalization. */
export const TEXT_MAX = 200;

const WORD_CP = /^[\p{L}\p{M}\p{Nd}]$/u; // ONE code point is tested at a time: a fixed class, linear, never built from input
const isWordCp = (cp) => WORD_CP.test(String.fromCodePoint(cp));
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

const DIGIT_CP = /^\p{Nd}$/u;
const isDigitCp = (cp) => DIGIT_CP.test(String.fromCodePoint(cp));
/** The code point ENDING at `e` (exclusive) in `t`; `e` must be >= 1. */
function cpEndingAt(t, e) {
  const u = t.charCodeAt(e - 1);
  return isLow(u) && e >= 2 && isHigh(t.charCodeAt(e - 2)) ? t.codePointAt(e - 2) : u;
}
const isGlueChar = (c) => c === 0x2e || c === 0x2c; // "." or ","
const WORD_START = /^[\p{L}\p{Nd}]$/u;
const isLetterOrDigitCp = (cp) => WORD_START.test(String.fromCodePoint(cp));

/**
 * True when a match starting at `i` in `t` has a whole-token boundary before it (start, or not a letter / mark /
 * digit). DIGIT GLUE (RULED #60): a `.` or `,` with a digit on both sides (the match's first char and the char before
 * the mark) holds a number together and is NOT a boundary.
 */
function boundaryBefore(t, i) {
  if (i === 0) return true;
  const u = t.charCodeAt(i - 1);
  if (isHigh(u) && isLow(t.charCodeAt(i))) return false; // the match would start inside a surrogate pair
  const cp = isLow(u) && i >= 2 && isHigh(t.charCodeAt(i - 2)) ? t.codePointAt(i - 2) : u;
  if (isGlueChar(cp) && i >= 2 && isDigitCp(t.codePointAt(i)) && isDigitCp(cpEndingAt(t, i - 1))) return false;
  // HYPHEN DIGIT GLUE (RULED #62): "-" after a digit and before a letter/digit joins "0.41.0-rc1", "2026-10-12"
  if (u === 0x2d && i >= 2 && isLetterOrDigitCp(t.codePointAt(i)) && isDigitCp(cpEndingAt(t, i - 1))) return false;
  return !isWordCp(cp);
}

/**
 * True when a match ending at `e` (exclusive) in `t` has a whole-token boundary after it (end, or not a letter /
 * mark / digit). DIGIT GLUE (RULED #60): a `.` or `,` after a digit and before a digit is NOT a boundary.
 * HYPHEN DIGIT GLUE (RULED #62): a `-` after a digit and before a letter or digit is NOT a boundary.
 */
function boundaryAfter(t, e) {
  if (e >= t.length) return true;
  if (isHigh(t.charCodeAt(e - 1)) && isLow(t.charCodeAt(e))) return false; // the match would end inside a surrogate pair
  const cp = t.codePointAt(e);
  if (isGlueChar(cp) && e >= 1 && e + 1 < t.length && isDigitCp(cpEndingAt(t, e)) && isDigitCp(t.codePointAt(e + 1))) return false;
  if (cp === 0x2d && e >= 1 && e + 1 < t.length && isDigitCp(cpEndingAt(t, e)) && isLetterOrDigitCp(t.codePointAt(e + 1))) return false;
  return !isWordCp(cp);
}

/**
 * Normalize a worker's `text` value: trim, collapse every whitespace run to one space. Returns
 * `{ ok: true, text }` (case kept, for the gap item) or `{ ok: false, text: "" }` for a non-string, an empty or
 * whitespace-only string, or one longer than TEXT_MAX after normalization (`text` is "" then). Never throws.
 * @returns {{ ok: boolean, text: string }}
 */
export function parseClaimText(raw) {
  try {
    if (typeof raw !== "string") return { ok: false, text: "" };
    const text = raw.replace(/\s+/g, " ").trim();
    if (text === "" || text.length > TEXT_MAX) return { ok: false, text: "" };
    return { ok: true, text };
  } catch {
    return { ok: false, text: "" };
  }
}

/**
 * Unanchored `text` presence: is the folded value in the folded quote as a whole-token sequence? One qualifying
 * occurrence is enough. Both arguments are already `toLowerCase()`d. Linear in the quote (the value is at most
 * TEXT_MAX long): native `indexOf`, then an O(1) boundary test per occurrence.
 */
export function textPresent(foldedQuote, foldedValue) {
  for (let at = foldedQuote.indexOf(foldedValue); at !== -1; at = foldedQuote.indexOf(foldedValue, at + 1)) {
    if (boundaryBefore(foldedQuote, at) && boundaryAfter(foldedQuote, at + foldedValue.length)) return true;
  }
  return false;
}

/**
 * Map a span [fs, fe) in `text.toLowerCase()` back to `text`. U+0130 (İ) is the only code point whose default lower-casing
 * changes length (1 -> 2 units, "i" + U+0307), so a folded offset is the original offset plus the number of İ before it.
 * Returns `{ start, end }` in `text`, or null when an edge lands inside one İ's 2-unit expansion (no original offset exists).
 * Pure; used only when the fold changed the length.
 */
function foldedSpanToOriginal(text, fs, fe) {
  let start = -1;
  let f = 0;
  for (let o = 0; o <= text.length; o++) {
    if (start === -1 && f === fs) start = o;
    if (f === fe) return start === -1 ? null : { start, end: o };
    if (o === text.length) break;
    f += text.charCodeAt(o) === 0x130 ? 2 : 1;
  }
  return null;
}

/**
 * Evidence (RULED #66): where `textPresent` found the value, as `{ start, end }` in `quote` (the first qualifying whole-token
 * occurrence), or null (not present, or an edge falls inside one İ's lower-cased expansion). When lower-casing changed the quote's
 * length the folded span is mapped back to `quote`.
 */
export function textSpanPresent(quote, foldedQuote, foldedValue) {
  const same = foldedQuote.length === quote.length;
  for (let at = foldedQuote.indexOf(foldedValue); at !== -1; at = foldedQuote.indexOf(foldedValue, at + 1)) {
    if (boundaryBefore(foldedQuote, at) && boundaryAfter(foldedQuote, at + foldedValue.length)) {
      return same ? { start: at, end: at + foldedValue.length } : foldedSpanToOriginal(quote, at, at + foldedValue.length);
    }
  }
  return null;
}

/** Evidence (RULED #66): where `textAfter` matched, as `{ start, end }` in `quote`, or null (no match, or an edge falls inside one İ's lower-cased expansion). */
export function textSpanAfter(quote, from, foldedValue) {
  const n = foldedValue.length;
  if (!textAfter(quote, from, foldedValue)) return null;
  if (quote.slice(from, from + n).toLowerCase() === foldedValue) return { start: from, end: from + n };
  // the fold changed lengths inside the matched run: map the slice-local folded span [0, n) back
  const m = foldedSpanToOriginal(quote.slice(from), 0, n);
  return m === null ? null : { start: from + m.start, end: from + m.end };
}

/**
 * Anchored `text`: the folded value must START at `from` (right after the anchor and its whitespace) and END on a
 * whole-token boundary. The segment is folded after the cut, so offsets never cross a length-changing lower-casing.
 */
export function textAfter(quote, from, foldedValue) {
  const seg = quote.slice(from).toLowerCase();
  return seg.startsWith(foldedValue) && boundaryAfter(seg, foldedValue.length);
}

// --- evidence spans (RULED #66) --------------------------------------------------
// Positions are carried by the SAME reads that produce the verdict (tokens hold their offsets); nothing here searches again.
// A raw span is `{ role, start, end, canon?, ck? }`: `canon` is the display form of a bind-only value, `ck` its comparable key.

/** Push one token's spans: its value run, plus the currency symbol / unit text the token itself recorded when it was read. */
function pushTok(sp, rd, kind, text, tok, bindOnly) {
  if (tok.mal) {
    sp.push({ role: "value", start: tok.vs, end: tok.ve });
    return;
  }
  const v = { role: "value", start: tok.vs, end: tok.ve };
  if (bindOnly) {
    v.canon = String(displayOf(kind, tok.value));
    v.ck = String(canonOf(kind, tok.value));
  }
  sp.push(v);
  if (tok.cs !== undefined) {
    sp.push({ role: "currency", start: tok.cs, end: tok.ce });
  }
  if (tok.us !== undefined) sp.push({ role: "unit", start: tok.us, end: tok.ue });
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
export function extractValue(decide, text, sp) {
  const rd = readerFor(decide);
  if (typeof text !== "string" || rd === null) return { ok: false, kind: "value-none", ...(anchorField(decide)) };
  const kind = decide.valueKind;

  if (decide.anchor !== undefined) {
    const at = locateAnchor(decide, text, sp);
    if (at.gap) return { ok: false, ...at.gap };
    const p = at.p;
    let q = p;
    if (rd.prefixes) {
      const c = text.charCodeAt(p);
      if (c === 45 || c === U_MINUS || c === 40) q = p + 1; // a sign / "(" directly before the token is judged by the token
    }
    const r = q < text.length ? rd.read(text, q) : { tok: undefined };
    if (r.tok === undefined) return { ok: false, kind: "value-none", ...anchorField(decide) };
    if (sp !== undefined) pushTok(sp, rd, kind, text, r.tok, decide.op === undefined);
    if (r.tok.mal) return { ok: false, kind: "value-malformed", measured: clip(r.tok.raw) };
    return { ok: true, value: r.tok.value, canon: canonOf(kind, r.tok.value) };
  }

  const s = scanValues(rd, kind, text, null, sp, false);
  if (s.mal) return { ok: false, kind: "value-malformed", measured: clip(s.mal.raw) };
  if (s.count === 0) return { ok: false, kind: "value-none" };
  // RULED #65 SAME AMOUNT = ONE PRICE: a money op decide whose tokens all carry one canonical amount reads as that one value
  const onePrice = s.count > 1 && kind === "money" && decide.op !== undefined && s.allSame;
  if (s.count > 1 && !onePrice) {
    return { ok: false, kind: "value-many", measured: s.count, items: s.items, ...(s.count > MAX_ITEMS ? { itemsTotal: s.count } : {}) };
  }
  return { ok: true, value: s.firstVal, canon: canonOf(kind, s.firstVal) };
}

/**
 * RULED #64 LABEL WORD EDGES: an occurrence of a signed label (`anchor`, `until`) at `at` qualifies only when a word-character
 * edge of the label sits on a token boundary (same helpers as the text boundaries, digit glue included). An edge that is
 * punctuation or a space is unaffected.
 */
function edgesOk(t, label, at) {
  if (label === "") return false;
  const first = label.codePointAt(0);
  if (isWordCp(first) && !boundaryBefore(t, at)) return false;
  const end = at + label.length;
  const last = cpEndingAt(label, label.length);
  if (isWordCp(last) && !boundaryAfter(t, end)) return false;
  return true;
}

/**
 * The signed anchor (normalized, case-sensitive) must occur exactly once in `text`. Returns `{ p, end }` (`end`: the index just past the anchor; `p`: the first non-whitespace character after it) or `{ gap }` (`anchor-missing` / `anchor-ambiguous` with the
 * gap fields). Shared by value decides and `text` decides.
 */
function locateAnchor(decide, text, sp) {
  const a = typeof decide.anchor === "string" ? normalizeForQuote(decide.anchor) : "";
  if (a === "") return { gap: { kind: "anchor-missing", anchor: decide.anchor, measured: 0 } };
  let count = 0;
  let first = -1;
  for (let at = text.indexOf(a); at !== -1 && count < 1000; at = text.indexOf(a, at + 1)) {
    if (!edgesOk(text, a, at)) continue; // RULED #64: a non-qualifying occurrence is skipped, not counted
    if (count === 0) first = at;
    count++;
    if (sp !== undefined) sp.push({ role: "anchor", start: at, end: at + a.length });
  }
  if (count === 0) return { gap: { kind: "anchor-missing", anchor: decide.anchor, measured: 0 } };
  if (count > 1) return { gap: { kind: "anchor-ambiguous", anchor: decide.anchor, measured: count } };
  const end = first + a.length;
  let p = end;
  while (p < text.length && isWs(text.charCodeAt(p))) p++;
  return { p, end };
}

/**
 * One left-to-right pass over `text` reading every token of the decide's kind. Stops at the first malformed
 * token (`mal`: unsure = red, never counted away). `count` counts every value; `items` keeps the first
 * MAX_ITEMS as clipped display strings; with `canons` (a Set) every value's comparable form is added (membership).
 */
function scanValues(rd, kind, text, canons, sp, bindOnly) {
  const n = text.length;
  let count = 0;
  const items = [];
  let firstVal;
  let firstCanon;
  let allSame = true; // RULED #65: every value has the same canonical amount (money only is acted on)
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
        if (sp !== undefined) pushTok(sp, rd, kind, text, r.tok, false);
        break;
      }
      if (sp !== undefined) pushTok(sp, rd, kind, text, r.tok, bindOnly);
      if (count === 0) {
        firstVal = r.tok.value;
        if (kind === "money") firstCanon = canonOf(kind, firstVal);
      } else if (allSame && kind === "money" && canonOf(kind, r.tok.value) !== firstCanon) allSame = false;
      count++;
      let fresh = true; // membership lists DISTINCT values (RULED #63)
      if (canons !== null) {
        const cs = String(canonOf(kind, r.tok.value));
        fresh = !canons.has(cs);
        canons.add(cs);
      }
      if (fresh && items.length < MAX_ITEMS) items.push(clip(String(displayOf(kind, r.tok.value))));
    }
    i = r.end > i ? r.end : i + 1;
  }
  return { count, items, firstVal, allSame, mal };
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
 * YYYY-MM-DD, or integer minutes).
 */
export function evalDecide(decide, text, sp) {
  if (Array.isArray(decide.phrases)) return evalPresence(decide, text, sp);
  if (decide.valueKind === "text") return evalText(decide, text, sp);
  if (decide.op === undefined && decide.anchor === undefined) return evalMembership(decide, text, sp); // bind-only, no anchor (RULED #56)
  const ex = extractValue(decide, text, sp);
  if (!ex.ok) {
    const { kind, ok: _ok, ...fields } = ex;
    return { type: "value", ok: false, kind, ...fields };
  }
  if (decide.op === undefined) return { type: "value", ok: true, extracted: ex.canon }; // bind-only anchored: extraction only, the binding compares it
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

/**
 * A bind-only decide WITHOUT an anchor (RULED #56): every value of the kind in the quote, for the binding's
 * membership test. Zero = `value-none`, any malformed token = `value-malformed`; `value-many` never fires. An ok
 * result carries `members` (the Set of comparable forms of ALL values), `shown` (the first 20 DISTINCT display strings,
 * first-occurrence order) and `total` (the count of distinct values).
 */
function evalMembership(decide, text, sp) {
  const rd = readerFor(decide);
  if (typeof text !== "string" || rd === null) return { type: "value", ok: false, kind: "value-none" };
  const members = new Set();
  const s = scanValues(rd, decide.valueKind, text, members, sp, true);
  if (s.mal) return { type: "value", ok: false, kind: "value-malformed", measured: clip(s.mal.raw) };
  if (s.count === 0) return { type: "value", ok: false, kind: "value-none" };
  return { type: "value", ok: true, members, shown: s.items, total: members.size }; // DISTINCT values (RULED #63)
}

/**
 * A `text` decide (RULED #58): nothing is extracted, so the only reds of its own are its anchor's
 * (`anchor-missing` / `anchor-ambiguous`) and, with `until` (RULED #61), `until-missing` / `value-none`. Ok carries `textFrom`
 * (where the claim value must start, anchored, or 0) or, with `until`, `textField` (the whole field the claim must equal).
 */
function evalText(decide, text, sp) {
  if (decide.anchor === undefined) return { type: "value", ok: true, textFrom: 0 };
  const at = locateAnchor(decide, text, sp);
  if (at.gap) return { type: "value", ok: false, ...at.gap };
  if (decide.until === undefined) return { type: "value", ok: true, textFrom: at.p };
  // RULED #61: the field is the quote strictly between the anchor's end and the FIRST `until` after it. `until` is matched
  // on the normalized quote, case-sensitive, with whitespace runs collapsed but NOT trimmed (a signed " at" keeps its
  // leading space; RULED #64 then requires its word-character edges on a token boundary); the anchor's own trim is untouched.
  const u = normalizeUntil(decide.until);
  let ue = u === "" ? -1 : text.indexOf(u, at.end);
  while (ue !== -1 && !edgesOk(text, u, ue)) ue = text.indexOf(u, ue + 1); // RULED #64: skip non-qualifying, keep searching
  if (ue === -1) return { type: "value", ok: false, kind: "until-missing", until: decide.until, measured: 0 };
  if (sp !== undefined) sp.push({ role: "until", start: ue, end: ue + u.length });
  const raw = text.slice(at.end, ue);
  const field = raw.trim();
  if (field === "") return { type: "value", ok: false, kind: "value-none", ...anchorField(decide) };
  const res = { type: "value", ok: true, textField: field };
  if (sp !== undefined) res.fieldAt = at.end + (raw.length - raw.trimStart().length); // where the field starts (evidence only)
  return res;
}

/** A signed `until`, normalized like the quote (markers stripped, whitespace collapsed) but NOT trimmed. */
function normalizeUntil(s) {
  return s.split("**").join("").split("__").join("").replace(/\s+/g, " ");
}

function evalPresence(decide, text, sp) {
  const lower = text.toLowerCase();
  let missing;
  const aligned = lower.length === text.length; // else the folded offset is mapped back (U+0130)
  for (const p of decide.phrases) {
    if (!carries(text, lower, p, false)) {
      if (missing === undefined) missing = p;
      if (sp === undefined) break; // verdict only: the first missing phrase decides; with evidence the rest are still located
      continue;
    }
    if (sp !== undefined) {
      const pl = p.toLowerCase();
      const at = lower.indexOf(pl); // the FIRST case-insensitive occurrence, exactly what `carries` found
      if (at !== -1) {
        const m = aligned ? { start: at, end: at + pl.length } : foldedSpanToOriginal(text, at, at + pl.length);
        if (m !== null) sp.push({ role: "phrase", start: m.start, end: m.end });
      }
    }
  }
  if (missing !== undefined) return { type: "presence", ok: false, kind: "phrase-missing", measured: missing };
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
export function decideQuote(quote, decides, wantSpans = false) {
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
    const sp = wantSpans ? [] : undefined;
    /** @type {any} */
    const r = { index: i, ...evalDecide(decides[i], text, sp) };
    if (sp !== undefined) r.sp = sp; // evidence spans (RULED #66); only when asked, so a plain result is unchanged
    results.push(r);
    if (!r.ok) reds.push(r);
  }
  if (reds.length === 0) return { ok: true, results };
  const first = reds[0];
  // `items` is taken twice in the PRD (the d<i> list; value-many's listed values): the list-level gap keeps the
  // d<i> list under `items`, and the first red's own value list rides as `values` (see the Module 1 report).
  /** @type {any} */
  const { index: _i, type: _t, ok: _o, extracted: _e, sp: _sp, fieldAt: _fa, items: firstItems, itemsTotal: firstTotal, ...gapFields } = first;
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
