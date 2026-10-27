import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRubric, checkStep, rubricSha, rubricVocabulary } from "../src/index.js";
import { describeRule } from "../src/primitives/rubric.js";
import { decideQuote, parseClaimValue } from "../src/primitives/rubric-locate.js";
import { MONTH_LANGS, monthTable } from "../src/primitives/rubric-months.js";
import { readCellDate } from "../src/primitives/rubric-cells.js";

// Page forms (docs/product/rubric-prd.md §5.2 "Page forms", RULED #68): date `lang`/`months`, `decimal: ","`, a currency symbol glued after
// the digits. Real strings are the short snippets of bareloop's saved pages (fosdem, ccc, steam, cdiscount, kaufland, ikea, lidl, amazon).

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** What a bind-only decide reads from a quote: `{ values }` (every value, quote order) or `{ kind, measured? }` (the red). */
function read(decide, quote) {
  const r = decideQuote(quote, [decide], true);
  if (!r.ok) return { kind: r.kind, ...(r.measured !== undefined ? { measured: r.measured } : {}) };
  return { values: [...r.results[0].members].map(String) };
}
const date = (lang, quote) => read({ valueKind: "date", lang }, quote);
const num = (quote, extra = {}) => read({ valueKind: "number", decimal: ",", ...extra }, quote);
const eur = (quote, extra = {}) => read({ valueKind: "money", currency: "€", ...extra }, quote);
const iso = (v) => ({ values: [v] });

// --- dates ----------------------------------------------------------------------------------------

test("dates: no lang (and no months) reads ISO only, exactly as before", () => {
  assert.deepEqual(read({ valueKind: "date" }, "2026-10-21"), iso("2026-10-21"));
  for (const q of ["21 October 2026", "September 29, 2026", "03 Jul 2025", "13. Oktober 2026"]) assert.deepEqual(read({ valueKind: "date" }, q), { kind: "value-none" }, q);
  assert.deepEqual(read({ valueKind: "date" }, "2026-02-30"), { kind: "value-malformed", measured: "2026-02-30" });
});

test("dates: day-month-year in every built-in language, short forms with and without the dot, zero-padded days", () => {
  // bareloop's real English short forms (no dot, zero-padded): the most common shape on its pages
  assert.deepEqual(date("en", "03 Jul 2025"), iso("2025-07-03"));
  assert.deepEqual(date("en", "18 Dec 2025"), iso("2025-12-18"));
  assert.deepEqual(date("en", "30 Jul 2026"), iso("2026-07-30"));
  assert.deepEqual(date("en", "24 Sep 2026"), iso("2026-09-24"));
  assert.deepEqual(date("en", "5 October 2026"), iso("2026-10-05")); // fosdem.org
  assert.deepEqual(date("en", "21 October 2026"), iso("2026-10-21"));
  assert.deepEqual(date("en", "7 Sept 2026"), iso("2026-09-07"));
  assert.deepEqual(date("de", "13. Oktober 2026"), iso("2026-10-13")); // events.ccc.de
  assert.deepEqual(date("de", "22 Okt. 2026"), iso("2026-10-22"));
  assert.deepEqual(date("de", "22 Okt 2026"), iso("2026-10-22"));
  assert.deepEqual(date("de", "3. März 2026"), iso("2026-03-03"));
  assert.deepEqual(date("de", "3. MÄRZ 2026"), iso("2026-03-03"), "case-insensitive");
  assert.deepEqual(date("de", "3. Jänner 2026"), iso("2026-01-03"));
  assert.deepEqual(date("fr", "21 février 2026"), iso("2026-02-21"));
  assert.deepEqual(date("fr", "1 août 2026"), iso("2026-08-01"));
  assert.deepEqual(date("fr", "9 janv. 2026"), iso("2026-01-09"));
  assert.deepEqual(date("it", "4 giugno 2026"), iso("2026-06-04"));
  assert.deepEqual(date("it", "4 sett 2026"), iso("2026-09-04"));
  assert.deepEqual(date("pt", "4 de março de 2026"), iso("2026-03-04"));
  assert.deepEqual(date("pt", "4 março 2026"), iso("2026-03-04"));
  assert.deepEqual(date("nl", "21 maart 2026"), iso("2026-03-21"));
  assert.deepEqual(date("nl", "21 mrt 2026"), iso("2026-03-21"));
});

test("dates: es / pt connectors are strictly both-or-neither, case-insensitive; other languages never read `de`", () => {
  assert.deepEqual(date("es", "5 de octubre de 2026"), iso("2026-10-05"));
  assert.deepEqual(date("es", "5 DE octubre De 2026"), iso("2026-10-05"));
  assert.deepEqual(date("es", "5 octubre 2026"), iso("2026-10-05"));
  assert.deepEqual(date("es", "5 de octubre 2026"), { kind: "value-none" });
  assert.deepEqual(date("es", "5 octubre de 2026"), { kind: "value-none" });
  assert.deepEqual(date("pt", "5 de outubro 2026"), { kind: "value-none" });
  assert.deepEqual(date("es", "5 de sept de 2026"), iso("2026-09-05"));
  assert.deepEqual(date("de", "5 de octubre de 2026"), { kind: "value-none" });
  assert.deepEqual(date("en", "5 de October de 2026"), { kind: "value-none" });
});

test("dates: English month-day-year needs lang en and the comma; weekday prefixes are ignored text", () => {
  assert.deepEqual(date("en", "September 29, 2026"), iso("2026-09-29"));
  assert.deepEqual(date("en", "Sep 29, 2026"), iso("2026-09-29"));
  assert.deepEqual(date("en", "Sep. 29, 2026"), iso("2026-09-29"));
  assert.deepEqual(date("en", "September 29 2026"), { kind: "value-none" }, "the comma is required");
  assert.deepEqual(date("de", "September 29, 2026"), { kind: "value-none" }, "month-first is English only");
  assert.deepEqual(date("en", "Tue, September 29, 2026"), iso("2026-09-29")); // steam-portal2: "Tue, September 29, 2026"
  assert.deepEqual(date("de", "Mi, 14. Oktober 2026"), iso("2026-10-14"));
  assert.deepEqual(date("en", "Wed 21 October 2026"), iso("2026-10-21"));
  assert.deepEqual(date("en", "An update was released Tue, September 29, 2026. Done"), iso("2026-09-29"));
});

test("dates: the real calendar; ordinals and letters glued on are malformed; a missing year, another language's month are not read", () => {
  assert.deepEqual(date("en", "31 February 2026"), { kind: "value-malformed", measured: "31 February 2026" });
  assert.deepEqual(date("en", "30 April 2026"), iso("2026-04-30"));
  assert.deepEqual(date("en", "31 April 2026"), { kind: "value-malformed", measured: "31 April 2026" });
  assert.deepEqual(date("en", "29 February 2028"), iso("2028-02-29"));
  assert.deepEqual(date("en", "29 February 2026"), { kind: "value-malformed", measured: "29 February 2026" });
  assert.deepEqual(date("en", "February 30, 2026"), { kind: "value-malformed", measured: "February 30, 2026" });
  assert.deepEqual(date("en", "00 Jul 2025"), { kind: "value-malformed", measured: "00 Jul 2025" });
  assert.deepEqual(date("en", "5th October 2026"), { kind: "value-malformed", measured: "5th October 2026" });
  assert.deepEqual(date("en", "October 5th, 2026"), { kind: "value-malformed", measured: "October 5th, 2026" });
  assert.deepEqual(date("en", "5th of October"), { kind: "value-none" }, "an ordinal without a complete date shape is just text");
  assert.deepEqual(date("en", "x21 October 2026"), { kind: "value-malformed", measured: "x21 October 2026" });
  assert.deepEqual(date("en", "21 October 2026x"), { kind: "value-malformed", measured: "21 October 2026" });
  assert.deepEqual(date("en", "21 October 20267"), { kind: "value-none" }, "five year digits are no date shape");
  assert.deepEqual(date("de", "13. September"), { kind: "value-none" });
  assert.deepEqual(date("en", "October 2026"), { kind: "value-none" });
  assert.deepEqual(date("en", "13. Mai 2026"), { kind: "value-none" }, "a German month under en");
  assert.deepEqual(date("de", "May 5, 2026"), { kind: "value-none" });
  assert.deepEqual(date("de", "5 May 2026"), { kind: "value-none" }, "May is not a German month");
});

test("dates: month tables are accent-exact and case-folded with toLowerCase", () => {
  assert.deepEqual(date("de", "14. März 2026"), iso("2026-03-14"));
  assert.deepEqual(date("de", "14. Marz 2026"), { kind: "value-none" });
  assert.deepEqual(date("fr", "14 fevrier 2026"), { kind: "value-none" });
  assert.deepEqual(date("fr", "14 février 2026"), iso("2026-02-14"));
  assert.deepEqual(date("fr", "14 Février 2026"), iso("2026-02-14"));
});

test("dates: ISO keeps reading under every lang, and a date next to ISO is one more value", () => {
  for (const lang of MONTH_LANGS) assert.deepEqual(date(lang, "2026-10-21"), iso("2026-10-21"), lang);
  assert.deepEqual(date("en", "2026-02-30"), { kind: "value-malformed", measured: "2026-02-30" });
  assert.deepEqual(read({ valueKind: "date", lang: "en" }, "21 October 2026 (2026-10-21)"), iso("2026-10-21"), "same value, one member");
  const r = decideQuote("From 21 October 2026 to 25 October 2026", [{ valueKind: "date", lang: "en", op: "gte", value: "2026-01-01" }]);
  assert.equal(r.kind, "value-many");
  assert.deepEqual(r.measured, 2);
});

test("dates: signed `months` reads ONLY those 12 names: no built-in table, no de connector, no month-first", () => {
  const months = ["Januarie", "Februarie", "Maart", "April", "Mei", "Junie", "Julie", "Augustus", "September", "Oktober", "November", "Desember"];
  const d = { valueKind: "date", months };
  assert.deepEqual(read(d, "5 Oktober 2026"), iso("2026-10-05"));
  assert.deepEqual(read(d, "5. Februarie 2026"), iso("2026-02-05"));
  assert.deepEqual(read(d, "5 oktober 2026"), iso("2026-10-05"), "case-insensitive");
  assert.deepEqual(read(d, "5 October 2026"), { kind: "value-none" }, "no built-in table");
  assert.deepEqual(read(d, "5 de Oktober de 2026"), { kind: "value-none" }, "no connectors");
  assert.deepEqual(read(d, "Oktober 5, 2026"), { kind: "value-none" }, "no month-first form");
  assert.deepEqual(read(d, "2026-10-05"), iso("2026-10-05"));
  // a name signed WITH its dot is read only with it; one signed without is read without the dot following as part of the token
  const dotted = { valueKind: "date", months: months.map((m, i) => (i === 9 ? "Okt." : m)) };
  assert.deepEqual(read(dotted, "5 Okt. 2026"), iso("2026-10-05"));
  assert.deepEqual(read(dotted, "5 Okt 2026"), { kind: "value-none" });
  assert.deepEqual(read(d, "5 Oktober. 2026"), { kind: "value-none" }, "a full name takes no dot");
});

test("dates: the built-in tables are consistent (12 months each, no short form shared by two months, every full name present)", () => {
  for (const lang of MONTH_LANGS) {
    const t = monthTable(lang);
    assert.deepEqual([...new Set(t.values())].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], lang);
    for (const k of t.keys()) assert.equal(k, k.toLowerCase(), `${lang}:${k} is stored lower-case`);
  }
  assert.equal(monthTable("xx"), null);
  assert.equal(monthTable("__proto__"), null);
  assert.equal(monthTable("toString"), null);
});

test("dates: the cells reader is untouched (D MMM YYYY stays English 3-letter, Sept unread)", () => {
  assert.notEqual(readCellDate("22 Oct 2026", "D MMM YYYY"), null);
  assert.equal(readCellDate("22 Sept 2026", "D MMM YYYY"), null);
  assert.equal(readCellDate("22 October 2026", "D MMM YYYY"), null);
});

// --- decimal comma ---------------------------------------------------------------------------------

test("decimal ',': the grouping grammar, every listed example and every MALFORMED case", () => {
  const vals = (q) => num(q);
  assert.deepEqual(vals("1.234,99"), iso("1234.99"));
  assert.deepEqual(vals("12 832,99"), iso("12832.99"));
  assert.deepEqual(vals("649,99"), iso("649.99"));
  assert.deepEqual(vals("1,299"), iso("1.299"));
  assert.deepEqual(vals("1.234"), iso("1234"));
  assert.deepEqual(vals("1234,5"), iso("1234.5"));
  assert.deepEqual(vals("1 234 567,89"), iso("1234567.89"));
  assert.deepEqual(vals("12.345.678"), iso("12345678"));
  assert.deepEqual(vals("99,00"), iso("99")); // kaufland-de
  for (const bad of ["1.23", "1.2345", "1,234.56", "1.234 567,8", "12.34.56", "1234.567", "1,2,3"]) assert.equal(vals(bad).kind, "value-malformed", bad);
  // the trailing sentence mark is cut, a leading mark is malformed, letters glued on are malformed
  assert.deepEqual(vals("Total 12,50."), iso("12.5"));
  assert.equal(vals("x ,5").kind, "value-malformed");
  assert.equal(vals("12,5k").kind, "value-malformed");
});

test("decimal ',': a space joins a run only after 1-3 digits and before exactly three, with no comma read yet", () => {
  assert.deepEqual(num("2026 123").values, ["2026", "123"], "the group before has 4 digits: two numbers");
  assert.deepEqual(num("12,50 123").values, ["12.5", "123"], "a comma was read: no join");
  assert.deepEqual(num("5 1234").values, ["5", "1234"], "four digits after the space: no join");
  assert.deepEqual(num("5 12").values, ["5", "12"]);
  assert.deepEqual(num("Rated 4 832 times"), iso("4832"), "the documented limit: space grouping is read");
});

test("decimal '.': the default grammar is unchanged (1,299 is 1299), explicit-or-absent alike", () => {
  assert.deepEqual(read({ valueKind: "number" }, "1,299"), iso("1299"));
  assert.deepEqual(read({ valueKind: "number", decimal: "." }, "1,299"), iso("1299"));
  assert.deepEqual(read({ valueKind: "number" }, "12 832,99").kind, "value-malformed");
  assert.deepEqual(read({ valueKind: "number" }, "649,99").kind, "value-malformed");
});

test("decimal ',' on money: symbol, unit and the glued-after forms; real prices from cdiscount, kaufland, lidl", () => {
  assert.deepEqual(read({ valueKind: "money", unit: "€", decimal: "," }, "649,99 €"), iso("649.99")); // cdiscount
  assert.deepEqual(read({ valueKind: "money", unit: "€", decimal: "," }, "Mütze 99,00 € 49,99 € Verkäufer").values.sort(), ["49.99", "99"]); // kaufland-de
  assert.equal(read({ valueKind: "money", unit: "€", decimal: "," }, "99,00 € -49,01 € 49,99 €").kind, "value-malformed", "a negative sign stays malformed for money");
  assert.deepEqual(read({ valueKind: "money", unit: "€", decimal: "," }, "12 832,99 €"), iso("12832.99"));
  assert.deepEqual(read({ valueKind: "money", unit: "€", decimal: "," }, "1.234,99 €"), iso("1234.99"));
  assert.deepEqual(read({ valueKind: "money", currency: "€", decimal: "," }, "€1.234,99"), iso("1234.99"));
  assert.deepEqual(read({ valueKind: "money", unit: "€", decimal: "," }, "Preis: 29.99 €*d)").kind, "value-malformed", "'.' grouping needs three digits");
  assert.deepEqual(read({ valueKind: "money", unit: "€" }, "Preis: 29.99 €*d)"), iso("29.99"), "the lidl-de form under the default decimal");
  assert.equal(read({ valueKind: "money", unit: "€" }, "649,99 €").kind, "value-malformed", "no decimal signed: still the known limit");
});

test("decimal ',': a claim value containing ',' is claim-value-malformed; default decides keep the old claim grammar", () => {
  const d = { valueKind: "number", decimal: "," };
  assert.deepEqual(parseClaimValue("number", "1234.99", d), { ok: true, canon: "1234.99" });
  assert.deepEqual(parseClaimValue("number", "1,299", d), { ok: false });
  assert.deepEqual(parseClaimValue("number", "1234,99", d), { ok: false });
  assert.deepEqual(parseClaimValue("money", "649,99", { valueKind: "money", unit: "€", decimal: "," }), { ok: false });
  assert.deepEqual(parseClaimValue("money", "649.99", { valueKind: "money", unit: "€", decimal: "," }), { ok: true, canon: "649.99" });
  // no decide, a decide without decimal, and decimal "." keep today's claim grammar
  assert.deepEqual(parseClaimValue("number", "1,234.56"), { ok: true, canon: "1234.56" });
  assert.deepEqual(parseClaimValue("number", "1,234.56", { valueKind: "number" }), { ok: true, canon: "1234.56" });
  assert.deepEqual(parseClaimValue("number", "1,234.56", { valueKind: "number", decimal: "." }), { ok: true, canon: "1234.56" });
});

// --- symbol glued after the number ----------------------------------------------------------------

test("glued-after symbol: whole numbers, decimals, comma decimal, the three symbols; real ikea strings", () => {
  assert.deepEqual(eur("499€"), iso("499"));
  assert.deepEqual(eur("699.00€"), iso("699"));
  assert.deepEqual(eur("Preis 299.00€"), iso("299")); // ikea-de
  assert.deepEqual(eur("Preis 1299.00€"), iso("1299"));
  assert.deepEqual(eur("Cuadro 29,99€ El precio", { decimal: "," }), iso("29.99")); // ikea-es
  assert.deepEqual(eur("29,99€", { decimal: "," }), iso("29.99"));
  assert.equal(eur("29,99€").kind, "value-malformed", "no decimal signed: 29,99 is not a default-grammar number");
  assert.deepEqual(read({ valueKind: "money", currency: "$" }, "499$"), iso("499"));
  assert.deepEqual(read({ valueKind: "money", currency: "£" }, "12.50£"), iso("12.5"));
  assert.deepEqual(read({ valueKind: "money", currency: "€" }, "499$"), { kind: "value-none" }, "only the signed symbol counts");
  assert.deepEqual(eur("1,299€"), iso("1299"));
  assert.deepEqual(eur("29.99€*d)"), iso("29.99"), "punctuation or * may follow");
  assert.deepEqual(eur("29.99€."), iso("29.99"));
});

test("glued-after symbol: both sides signed, a letter or digit after, a space before the symbol", () => {
  for (const q of ["$43$", "€43€"]) assert.equal(read({ valueKind: "money", currency: [q[0]] }, q).kind, "value-malformed", q);
  assert.deepEqual(read({ valueKind: "money", currency: ["$", "€"] }, "$43€"), { kind: "value-malformed", measured: "$43€" });
  // a symbol of ANY of $ € £ on both sides is malformed, signed or not (unsure = red), in both directions
  assert.deepEqual(read({ valueKind: "money", currency: "$" }, "$43€"), { kind: "value-malformed", measured: "$43€" });
  assert.deepEqual(read({ valueKind: "money", currency: "$" }, "€43$"), { kind: "value-malformed", measured: "€43$" });
  assert.deepEqual(read({ valueKind: "money", currency: "€" }, "£43€"), { kind: "value-malformed", measured: "£43€" });
  assert.deepEqual(read({ valueKind: "money", currency: "£" }, "$43£").kind, "value-malformed");
  assert.deepEqual(read({ valueKind: "money", currency: "€" }, "€43£").kind, "value-malformed");
  assert.deepEqual(read({ valueKind: "money", currency: "$" }, "€43 ok"), { kind: "value-none" }, "one unsigned symbol alone is still ignored");
  assert.deepEqual(eur("499€x"), { kind: "value-malformed", measured: "499€" });
  assert.deepEqual(eur("499€5").kind, "value-malformed");
  assert.deepEqual(eur("43€ €"), iso("43"), "the second symbol has no digits glued to it");
  assert.deepEqual(eur("29.99 €"), { kind: "value-none" }, "a symbol after a space is the unit form");
  assert.deepEqual(eur("v499€").kind, "value-malformed", "letter adjacency before the digits");
  assert.deepEqual(eur("-499€").kind, "value-malformed", "a sign");
  assert.deepEqual(eur("499 €"), { kind: "value-none" });
});

test("glued-after symbol: anchored with the same adjacency (anchor, optional whitespace, number, symbol)", () => {
  const d = { valueKind: "money", currency: "€", op: "lt", value: 600, anchor: "Preis" };
  const ok = decideQuote("Preis 499€ Sale", [d]);
  assert.equal(ok.ok, true);
  assert.equal(ok.results[0].extracted, "499");
  assert.equal(decideQuote("Preis: 499€", [d]).kind, "value-none", "only whitespace may sit between the anchor and the number");
  assert.equal(decideQuote("Preis\t499€", [d]).ok, true, "any whitespace after the anchor");
  assert.equal(decideQuote("Preis 799€", [d]).kind, "value-over");
  assert.equal(decideQuote("Preis ab 499€", [d]).kind, "value-none", "something between the anchor and the number");
  assert.equal(decideQuote("Preis $43$", [{ ...d, currency: "$" }]).kind, "value-malformed");
});

test("one decide may sign the same symbol in currency and unit: glued is a currency token, spaced a unit token, same amount = one price", () => {
  const both = { valueKind: "money", currency: "€", unit: "€", decimal: ",", op: "lt", value: 100 };
  const r1 = decideQuote("Preis 29,99€ statt 29,99 €", [both]);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.results[0].extracted, "29.99");
  const r2 = decideQuote("Preis 29,99€ statt 39,99 €", [both]);
  assert.equal(r2.kind, "value-many");
  assert.equal(r2.measured, 2);
  assert.deepEqual(read({ ...both, op: undefined }, "29,99€ 29,99 €"), iso("29.99"));
  assert.deepEqual(read({ ...both, op: undefined }, "29,99€ and 39,99 €").values.sort(), ["29.99", "39.99"]);
  // createRubric takes the pair today
  assert.doesNotThrow(() => mk([{ valueKind: "money", currency: "€", unit: "€" }]));
  // each form on its own still reads
  assert.deepEqual(read({ valueKind: "money", currency: "€", unit: "€", decimal: "," }, "29,99 €"), iso("29.99"));
  assert.deepEqual(read({ valueKind: "money", currency: "€", unit: "€", decimal: "," }, "29,99€"), iso("29.99"));
});

test("existing money forms are untouched: $43, 43 US dollars, a code before the number, US$43", () => {
  const usd = { valueKind: "money", currency: "$", unit: "US dollars" };
  assert.deepEqual(read(usd, "From $43 US dollars."), iso("43"));
  assert.deepEqual(read(usd, "$43 and 43 US dollars"), iso("43"));
  assert.deepEqual(read({ valueKind: "money", currency: "$" }, "CHF 126.65"), { kind: "value-none" });
  assert.deepEqual(read({ valueKind: "money", unit: "CHF" }, "126.65 CHF"), iso("126.65"));
  assert.equal(read({ valueKind: "money", currency: "$" }, "US$43").kind, "value-malformed");
  assert.deepEqual(read({ valueKind: "money", currency: "€" }, "€43 ist ok"), iso("43"));
});

// --- createRubric ----------------------------------------------------------------------------------

const REAL = "Preis 29,99€ am 13. Oktober 2026";
function mk(decides, source = REAL) {
  return createRubric({
    schema: 1,
    goal: "g",
    inputs: [{ name: "offers", sha256: sha(source) }],
    checkpoints: { cp: { gating: true, checks: [{ id: "c", rule: "cited", claims: "claims", source: "offers", decides }] } },
  });
}
const P = "spec.checkpoints.cp.checks[0].decides[0]";
function refusedAt(decides, path) {
  try {
    mk(decides);
  } catch (e) {
    assert.equal(e.path, path, `${JSON.stringify(decides).slice(0, 150)} -> ${e.message}`);
    return;
  }
  assert.fail(`not refused: ${JSON.stringify(decides).slice(0, 150)}`);
}
const MONTHS12 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

test("createRubric: lang / months / decimal accepted on their kinds", () => {
  for (const lang of MONTH_LANGS) assert.doesNotThrow(() => mk([{ valueKind: "date", lang }]), lang);
  assert.doesNotThrow(() => mk([{ valueKind: "date", months: MONTHS12 }]));
  assert.doesNotThrow(() => mk([{ valueKind: "date", months: [...MONTHS12.slice(0, 11), "Dez."] }]));
  assert.doesNotThrow(() => mk([{ valueKind: "date", lang: "de", op: "gte", value: "2026-01-01", anchor: "am" }]));
  assert.doesNotThrow(() => mk([{ valueKind: "number", decimal: "," }]));
  assert.doesNotThrow(() => mk([{ valueKind: "number", decimal: "." }]));
  assert.doesNotThrow(() => mk([{ valueKind: "money", unit: "€", decimal: ",", op: "lt", value: 5 }]));
  assert.doesNotThrow(() => mk([{ valueKind: "date", months: ["Ärz", ...MONTHS12.slice(1)] }]), "letters with marks");
});

test("createRubric: every refusal names the exact field path", () => {
  // wrong kind
  for (const kind of ["number", "money", "time", "text"]) {
    const base = kind === "money" ? { currency: "$" } : {};
    refusedAt([{ valueKind: kind, ...base, lang: "en" }], `${P}.lang`);
    refusedAt([{ valueKind: kind, ...base, months: MONTHS12 }], `${P}.months`);
  }
  for (const kind of ["date", "time", "text"]) refusedAt([{ valueKind: kind, decimal: "," }], `${P}.decimal`);
  // bad values
  refusedAt([{ valueKind: "date", lang: "xx" }], `${P}.lang`);
  refusedAt([{ valueKind: "date", lang: "EN" }], `${P}.lang`);
  refusedAt([{ valueKind: "date", lang: ["en"] }], `${P}.lang`);
  refusedAt([{ valueKind: "date", lang: 5 }], `${P}.lang`);
  refusedAt([{ valueKind: "number", decimal: ";" }], `${P}.decimal`);
  refusedAt([{ valueKind: "number", decimal: 1 }], `${P}.decimal`);
  refusedAt([{ valueKind: "money", currency: "$", decimal: [","] }], `${P}.decimal`);
  // months list
  refusedAt([{ valueKind: "date", months: "Jan" }], `${P}.months`);
  refusedAt([{ valueKind: "date", months: [] }], `${P}.months`);
  refusedAt([{ valueKind: "date", months: MONTHS12.slice(0, 11) }], `${P}.months`);
  refusedAt([{ valueKind: "date", months: [...MONTHS12, "Extra"] }], `${P}.months`);
  refusedAt([{ valueKind: "date", months: [...MONTHS12.slice(0, 11), "Dec", ] .map((m, i) => (i === 3 ? "jan" : m)) }], `${P}.months`); // duplicate ignoring case
  refusedAt([{ valueKind: "date", months: MONTHS12.map((m, i) => (i === 4 ? "" : m)) }], `${P}.months[4]`);
  refusedAt([{ valueKind: "date", months: MONTHS12.map((m, i) => (i === 4 ? "  " : m)) }], `${P}.months[4]`);
  refusedAt([{ valueKind: "date", months: MONTHS12.map((m, i) => (i === 5 ? "Ju ne" : m)) }], `${P}.months[5]`);
  refusedAt([{ valueKind: "date", months: MONTHS12.map((m, i) => (i === 5 ? "Jun3" : m)) }], `${P}.months[5]`);
  refusedAt([{ valueKind: "date", months: MONTHS12.map((m, i) => (i === 5 ? "Ju.n" : m)) }], `${P}.months[5]`);
  refusedAt([{ valueKind: "date", months: MONTHS12.map((m, i) => (i === 5 ? "Jun.." : m)) }], `${P}.months[5]`);
  refusedAt([{ valueKind: "date", months: MONTHS12.map((m, i) => (i === 5 ? "a".repeat(41) : m)) }], `${P}.months[5]`);
  assert.doesNotThrow(() => mk([{ valueKind: "date", months: MONTHS12.map((m, i) => (i === 5 ? "a".repeat(40) : m)) }]), "40 characters is allowed");
  refusedAt([{ valueKind: "date", months: MONTHS12.map((m, i) => (i === 5 ? 6 : m)) }], `${P}.months[5]`);
  refusedAt([{ valueKind: "date", months: MONTHS12.map((m, i) => (i === 5 ? "JAN" : m)) }], `${P}.months`);
  // lang AND months: the error names months, even for lang en
  refusedAt([{ valueKind: "date", lang: "de", months: MONTHS12 }], `${P}.months`);
  refusedAt([{ valueKind: "date", lang: "en", months: MONTHS12 }], `${P}.months`);
  // path index follows the decide
  try {
    mk([{ phrases: ["a"] }, { valueKind: "date", lang: "zz" }]);
    assert.fail("not refused");
  } catch (e) {
    assert.equal(e.path, "spec.checkpoints.cp.checks[0].decides[1].lang");
  }
});

test("rubricSha: absent fields leave an existing signed spec's sha unchanged; each new field is a signed change", () => {
  const spec = (decides) => ({ schema: 1, goal: "g", inputs: [{ name: "offers", sha256: "a".repeat(64) }], checkpoints: { cp: { gating: true, checks: [{ id: "c", rule: "cited", claims: "claims", source: "offers", decides }] } } });
  const old = [
    { valueKind: "money", currency: "$", unit: ["US dollars"], op: "lt", value: 450, anchor: "From" },
    { valueKind: "number", op: "gte", value: 1 },
    { valueKind: "date", op: "gte", value: "2026-01-01" },
    { phrases: ["Nonstop"] },
  ];
  // computed with the code BEFORE #68 (0.26.2) on exactly this spec
  assert.equal(rubricSha(spec(old)), "48276923367ba164066efd4636020bfb5778badb53bc1659a3663395beaa10c2");
  const base = rubricSha(spec(old));
  assert.notEqual(base, rubricSha(spec(old.map((d) => (d.valueKind === "number" ? { ...d, decimal: "," } : d)))));
  assert.notEqual(base, rubricSha(spec(old.map((d) => (d.valueKind === "number" ? { ...d, decimal: "." } : d)))), "an explicit default is a re-sign");
  assert.notEqual(base, rubricSha(spec(old.map((d) => (d.valueKind === "date" ? { ...d, lang: "en" } : d)))));
  const m = rubricSha(spec(old.map((d) => (d.valueKind === "date" ? { ...d, months: MONTHS12 } : d))));
  assert.notEqual(base, m);
  assert.notEqual(m, rubricSha(spec(old.map((d) => (d.valueKind === "date" ? { ...d, months: [MONTHS12[1], MONTHS12[0], ...MONTHS12.slice(2)] } : d)))), "months hash in order");
  assert.doesNotThrow(() => mk(old.slice(0, 2).map((d) => d), "x"), "the old shapes still validate");
});

test("rubricVocabulary lists lang, months and decimal with types and defaults; the description is generated", () => {
  const f = rubricVocabulary.rules.cited.fields.decides.shapes.value.fields;
  assert.deepEqual(f.lang, { type: "enum", required: false, enum: ["en", "de", "fr", "es", "it", "pt", "nl"] });
  assert.equal(f.lang.default, undefined, "lang has no default: absent = ISO only");
  assert.equal(f.months.type, "string-list");
  assert.equal(f.months.exactItems, 12);
  assert.equal(f.months.itemMaxLength, 40);
  assert.equal(f.months.required, false);
  assert.deepEqual(f.decimal, { type: "enum", required: false, enum: [".", ","], default: "." });
  const d = rubricVocabulary.rules.cited.description;
  assert.equal(d, describeRule("cited"));
  for (const w of ['lang?: "en" | "de"', "months?: list of exactly 12 month names", 'decimal?: "." | "," = "."', "date only and mutually exclusive"]) assert.ok(d.includes(w), w);
  assert.ok(Object.isFrozen(f.months) && Object.isFrozen(f.lang.enum));
  // the other fields of the shape are as before
  assert.deepEqual(Object.keys(f), ["valueKind", "op", "value", "lo", "hi", "currency", "unit", "anchor", "until", "lang", "months", "decimal"]);
});

// --- end to end through checkStep ------------------------------------------------------------------

function run(source, decides, claims) {
  return checkStep(mk(decides, source), "cp", { claims }, { inputs: { offers: source } });
}
const marks = (e) => e.spans.map((s) => `${s.role}:${s.decide}:${e.text.slice(s.start, s.end)}`);

test("end to end: a German date and a comma price, claim values canonical (ISO, '.'-decimal)", async () => {
  const q = "Preis 29,99€ am 13. Oktober 2026";
  const decides = [
    { valueKind: "money", currency: "€", decimal: ",", op: "lt", value: 40, anchor: "Preis" },
    { valueKind: "date", lang: "de", op: "gte", value: "2026-10-01", anchor: "am" },
  ];
  const ok = await run(q, decides, [{ claim: "29,99€ am 13. Oktober 2026", quote: q, values: { d0: "29.99", d1: "2026-10-13" } }]);
  assert.equal(ok.verdict, "green", JSON.stringify(ok.gaps));
  const comma = await run(q, decides, [{ claim: "x", quote: q, values: { d0: "29,99", d1: "2026-10-13" } }]);
  assert.equal(comma.verdict, "red");
  assert.deepEqual(comma.gaps[0].items, ["#0:d0:claim-value-malformed"]);
  const text = await run(q, decides, [{ claim: "x", quote: q, values: { d0: "29.99", d1: "13. Oktober 2026" } }]);
  assert.deepEqual(text.gaps[0].items, ["#0:d1:claim-value-malformed"], "a non-ISO claim date is malformed");
  const wrong = await run(q, decides, [{ claim: "x", quote: q, values: { d0: "29.99", d1: "2026-10-14" } }]);
  assert.deepEqual(wrong.gaps[0].items, ["#0:d1:claim-value-mismatch:2026-10-14!=2026-10-13"]);
});

test("end to end: bind-only default-decimal decide still takes '1,234.56' in a claim", async () => {
  const q = "Total $1,234.56 today";
  const r = await run(q, [{ valueKind: "money", currency: "$" }], [{ claim: "x", quote: q, values: { d0: "1,234.56" } }]);
  assert.equal(r.verdict, "green", JSON.stringify(r.gaps));
});

test("end to end: a quote in another language is not read (value-none), bareguard never detects a language", async () => {
  const q = "Preis am 13. Oktober 2026";
  const r = await run(q, [{ valueKind: "date", lang: "en" }], [{ claim: "x", quote: q, values: { d0: "2026-10-13" } }]);
  assert.equal(r.verdict, "red");
  assert.deepEqual(r.gaps[0].items, ["#0:d0:value-none"]);
});

test("evidence spans: a date token is the whole token from the day (or month word) to the last digit; glued-after gets a currency span after the number", async () => {
  const dq = (decide, quote) => decideQuote(quote, [decide], true).results[0].sp.map((s) => `${s.role}:${quote.slice(s.start, s.end)}`);
  assert.deepEqual(dq({ valueKind: "date", lang: "de" }, "am Mi, 14. Oktober 2026 um"), ["value:14. Oktober 2026"]);
  assert.deepEqual(dq({ valueKind: "date", lang: "de" }, "am 22 Okt. 2026 um"), ["value:22 Okt. 2026"]);
  assert.deepEqual(dq({ valueKind: "date", lang: "es" }, "el 5 de octubre de 2026."), ["value:5 de octubre de 2026"]);
  assert.deepEqual(dq({ valueKind: "date", lang: "en" }, "Tue, September 29, 2026 update"), ["value:September 29, 2026"]);
  assert.deepEqual(dq({ valueKind: "date", lang: "en" }, "on 31 February 2026"), ["value:31 February 2026"], "a malformed token gives the shaped range");
  assert.deepEqual(dq({ valueKind: "money", currency: "€", decimal: "," }, "nur 1.234,99€ heute"), ["value:1.234,99", "currency:€"]);
  assert.deepEqual(dq({ valueKind: "money", currency: "€" }, "nur 499€ heute"), ["value:499", "currency:€"]);
  assert.deepEqual(dq({ valueKind: "money", currency: "$" }, "a $43$ b"), ["value:$43$"], "both sides: the shaped range, malformed");
  assert.deepEqual(dq({ valueKind: "money", currency: "€" }, "€43 b"), ["value:43", "currency:€"], "the symbol before is unchanged");
  // end to end: full.evidence carries the spans, bind-only canon is the ISO date
  const q = "Preis 29,99€ am 13. Oktober 2026";
  const decides = [
    { valueKind: "money", currency: "€", decimal: "," },
    { valueKind: "date", lang: "de" },
  ];
  const r = await run(q, decides, [{ claim: "x", quote: q, values: { d0: "29.99", d1: "2026-10-13" } }]);
  assert.equal(r.verdict, "green", JSON.stringify(r.gaps));
  const [e] = r.full.evidence;
  assert.deepEqual(marks(e), ["value:0:29,99", "currency:0:€", "value:1:13. Oktober 2026"]);
  const date = e.spans.find((s) => s.decide === 1);
  assert.equal(date.canon, "2026-10-13");
  assert.equal(date.matched, true);
  assert.equal(e.spans[0].canon, "29.99");
});

test("hostile and large input: the new readers stay linear and never throw", () => {
  const long = (u) => u.repeat(Math.ceil(4000 / u.length)).slice(0, 4000);
  const cases = [
    [{ valueKind: "date", lang: "en" }, "1 ".repeat(2000)],
    [{ valueKind: "date", lang: "en" }, long("Sep ")],
    [{ valueKind: "date", lang: "es" }, long("5 de ")],
    [{ valueKind: "date", lang: "de" }, long("1. ")],
    [{ valueKind: "date", lang: "en" }, "a".repeat(4000)],
    [{ valueKind: "date", lang: "en" }, long("9ab ")],
    [{ valueKind: "number", decimal: "," }, long("1 234 ")],
    [{ valueKind: "number", decimal: "," }, long("12.345,")],
    [{ valueKind: "money", currency: "€", decimal: "," }, long("1 234€")],
    [{ valueKind: "money", currency: "€" }, "9".repeat(4000)],
    [{ valueKind: "money", currency: "€", unit: "€" }, long("1,2 ")],
  ];
  const t0 = Date.now();
  for (const [d, q] of cases) assert.doesNotThrow(() => decideQuote(q, [d], true), JSON.stringify(d));
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});
