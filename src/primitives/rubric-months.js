// Month names and the real-calendar check, shared by the date readers (docs/product/rubric-prd.md §5.2 "Page forms", RULED #68)
// and the `cells` D MMM YYYY reader. Pure data and two tiny functions; no regex, no input-built patterns.
//
// Names are matched by the caller after `toLowerCase()` (the fold used everywhere in the rubric) and are ACCENT-EXACT: `märz` is
// a month, `marz` is not. A short form may carry one trailing "." in the page; `monthTable` lists each short form with and without it.

/** The English 3-letter months of the `cells` `D MMM YYYY` format (Jan..Dec, lower case). The `cells` reader's own table: never extended. */
export const EN_MONTHS_3 = Object.freeze(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]);

/** The built-in `lang` codes of a `date` decide (RULED #68). */
export const MONTH_LANGS = Object.freeze(["en", "de", "fr", "es", "it", "pt", "nl"]);

/** The longest signed month name (and the most letters a page word is read for): `months` entries are at most this long. */
export const MONTH_NAME_MAX = 40;

/** Is `d` a real day of month `m` in year `y`? Years 0001-9999, Gregorian. */
export function isRealDay(y, m, d) {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= (m === 2 ? (leap ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31);
}

// Per language, Jan..Dec: "full names (alternatives) | short forms".
const SOURCE = {
  en: ["january|jan", "february|feb", "march|mar", "april|apr", "may|", "june|jun", "july|jul", "august|aug", "september|sep sept", "october|oct", "november|nov", "december|dec"],
  de: ["januar jänner|jan jän", "februar|feb", "märz|mär mrz", "april|apr", "mai|", "juni|jun", "juli|jul", "august|aug", "september|sep sept", "oktober|okt", "november|nov", "dezember|dez"],
  fr: ["janvier|janv", "février|févr", "mars|", "avril|avr", "mai|", "juin|", "juillet|juil", "août|", "septembre|sept", "octobre|oct", "novembre|nov", "décembre|déc"],
  es: ["enero|ene", "febrero|feb", "marzo|mar", "abril|abr", "mayo|may", "junio|jun", "julio|jul", "agosto|ago", "septiembre setiembre|sep sept set", "octubre|oct", "noviembre|nov", "diciembre|dic"],
  it: ["gennaio|gen", "febbraio|feb", "marzo|mar", "aprile|apr", "maggio|mag", "giugno|giu", "luglio|lug", "agosto|ago", "settembre|set sett", "ottobre|ott", "novembre|nov", "dicembre|dic"],
  pt: ["janeiro|jan", "fevereiro|fev", "março|mar", "abril|abr", "maio|mai", "junho|jun", "julho|jul", "agosto|ago", "setembro|set", "outubro|out", "novembro|nov", "dezembro|dez"],
  nl: ["januari|jan", "februari|feb", "maart|mrt", "april|apr", "mei|", "juni|jun", "juli|jul", "augustus|aug", "september|sep sept", "oktober|okt", "november|nov", "december|dec"],
};

/** @type {Map<string, Map<string, number>>} */
const TABLES = new Map();

/**
 * The lookup for a built-in language: lower-cased page word -> month 1..12. A short form is listed twice, plain and with a trailing "."
 * (`okt`, `okt.`); a full name has no dotted form. Built once, then shared. Null for an unknown code.
 * @param {string} lang
 * @returns {Map<string, number> | null}
 */
export function monthTable(lang) {
  if (!Object.hasOwn(SOURCE, lang)) return null;
  const cached = TABLES.get(lang);
  if (cached !== undefined) return cached;
  /** @type {Map<string, number>} */
  const t = new Map();
  SOURCE[lang].forEach((row, i) => {
    const [full, short] = row.split("|");
    for (const n of full.split(" ")) t.set(n, i + 1);
    for (const n of short.split(" ")) {
      if (n === "") continue;
      t.set(n, i + 1);
      t.set(n + ".", i + 1);
    }
  });
  TABLES.set(lang, t);
  return t;
}

/**
 * The lookup for a signed `months` list (exactly 12 names, Jan..Dec): exactly those names, lower-cased, nothing built in.
 * A name signed with a trailing "." is read only with it.
 * @param {string[]} months
 * @returns {Map<string, number>}
 */
export function customMonthTable(months) {
  const t = new Map();
  months.forEach((n, i) => t.set(n.toLowerCase(), i + 1));
  return t;
}
