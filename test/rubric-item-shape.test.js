import test from "node:test";
import assert from "node:assert/strict";
import { createRubric, checkStep, rubricSha, rubricVocabulary, renderGaps } from "../src/index.js";

// itemShape (RULED #83): a deterministic shape check over a list of items.

const mkCheck = (fields, extra = {}) => ({ id: "shape", rule: "itemShape", field: "items", fields, ...extra });
const mk = (check) => createRubric({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [check] } } });
const PATH = "spec.checkpoints.a.checks[0]";
const refused = (check) => {
  try { mk(check); } catch (e) { return e; }
  assert.fail("expected createRubric to refuse");
};
const run = (fields, items, extra) => checkStep(mk(mkCheck(fields, extra)), "a", { items });
const reds = async (fields, items, extra) => {
  const r = await run(fields, items, extra);
  return r.verdict === "green" ? [] : r.gaps[0].items ?? [r.gaps[0].kind];
};
const green = async (fields, items, extra) => assert.deepEqual(await reds(fields, items, extra), [], JSON.stringify(items));

// ---- the documented example -----------------------------------------------------------------------------------------------------------

test("the vocabulary example is green, and its failing neighbours are red", async () => {
  const ex = rubricVocabulary.rules.itemShape.example;
  const r = await checkStep(mk(ex.check), "a", ex.output);
  assert.equal(r.verdict, "green");
  const bad = [{ title: "", status: "open", summary: "x".repeat(201), link: "ftp://x" }, { title: "t", status: "closed", summary: "s" }];
  assert.deepEqual((await checkStep(mk(ex.check), "a", { items: bad })).gaps[0].items, [
    "#0:link:bad-url", "#0:status:not-one-of", "#0:summary:too-long:chars:201>200", "#0:title:too-short:chars:0<1", "#1:link:missing",
  ]);
  assert.match(rubricVocabulary.rules.itemShape.description, /^itemShape\(\{ id, field:/);
});

// ---- whole-field gaps ---------------------------------------------------------------------------------------------------------------------

test("whole-field gaps: missing, unreadable, not-a-list, count-under, count-over", async () => {
  const c = mk(mkCheck({ a: { kind: "url" } }, { minItems: 2, maxItems: 3 }));
  const g = async (out) => (await checkStep(c, "a", out)).gaps[0];
  assert.equal((await g({ other: 1 })).kind, "missing");
  assert.equal((await g({ get items() { throw new Error("x"); } })).kind, "unreadable");
  for (const [v, m] of [["[]", "type:string"], [{}, "type:object"], [null, "type:null"], [5, "type:number"]]) {
    const gap = await g({ items: v });
    assert.equal(gap.kind, "not-a-list");
    assert.equal(gap.measured, m);
  }
  const u = await g({ items: [{ a: "http://x.io" }] });
  assert.deepEqual([u.kind, u.measured, u.limit, u.direction], ["count-under", 1, 2, "at-least"]);
  const o = await g({ items: [{}, {}, {}, {}] });
  assert.deepEqual([o.kind, o.measured, o.limit, o.direction], ["count-over", 4, 3, "at-most"]);
  assert.equal(((await checkStep(c, "a", { items: [{ a: "http://x.io" }, { a: "http://y.io" }] })).verdict), "green", "min edge");
  assert.equal(((await checkStep(c, "a", { items: [{}, {}, {}].map(() => ({ a: "http://x.io" })) })).verdict), "green", "max edge");
});

test("minItems 0 and maxItems 1 are the smallest legal bounds; an empty list passes with only maxItems", async () => {
  await green({ a: { kind: "url" } }, [], { maxItems: 1 });
  await green({ a: { kind: "url" } }, [], { minItems: 0 });
  assert.deepEqual(await reds({ a: { kind: "url" } }, [], { minItems: 1 }), ["count-under"]);
});

// ---- text ------------------------------------------------------------------------------------------------------------------------------------

test("text: type, chars and words boundaries AT / UNDER / OVER", async () => {
  const f = { s: { kind: "text", required: true, minChars: 3, maxChars: 5, minWords: 2, maxWords: 3 } };
  await green(f, [{ s: "ab cd" }], {});
  assert.deepEqual(await reds(f, [{ s: "a b" }]), []);
  assert.deepEqual(await reds(f, [{ s: "ab" }]), ["#0:s:too-short:chars:2<3", "#0:s:too-short:words:1<2"]);
  assert.deepEqual(await reds(f, [{ s: "abcdef" }]), ["#0:s:too-long:chars:6>5", "#0:s:too-short:words:1<2"]);
  assert.deepEqual(await reds(f, [{ s: "a b c d" }]), ["#0:s:too-long:chars:7>5", "#0:s:too-long:words:4>3"]);
  assert.deepEqual(await reds(f, [{ s: 5 }]), ["#0:s:wrong-type"]);
  assert.deepEqual(await reds(f, [{ s: null }]), ["#0:s:wrong-type"]);
});

test("maxChars 200 -> 199 / 200 / 201; minChars 1 -> 0 / 1", async () => {
  const f = { s: { kind: "text", required: true, minChars: 1, maxChars: 200 } };
  for (const n of [1, 199, 200]) await green(f, [{ s: "x".repeat(n) }]);
  assert.deepEqual(await reds(f, [{ s: "x".repeat(201) }]), ["#0:s:too-long:chars:201>200"]);
  assert.deepEqual(await reds(f, [{ s: "" }]), ["#0:s:too-short:chars:0<1"]);
});

test("text counts code points, not UTF-16 units; words are whitespace-separated runs", async () => {
  const f = { s: { kind: "text", maxChars: 2 } };
  await green(f, [{ s: "\u{1F600}\u{1F600}" }]);
  assert.deepEqual(await reds(f, [{ s: "\u{1F600}\u{1F600}a" }]), ["#0:s:too-long:chars:3>2"]);
  const w = { s: { kind: "text", maxWords: 2 } };
  await green(w, [{ s: "  a \n\t b  " }]);
  assert.deepEqual(await reds(w, [{ s: "a b c" }]), ["#0:s:too-long:words:3>2"], "NBSP is whitespace (\\s)");
  await green({ s: { kind: "text", minWords: 0 } }, [{ s: "" }]);
});

test("an optional text field with no minChars accepts \"\"; null is wrong-type, undefined is absent", async () => {
  await green({ s: { kind: "text", maxChars: 5 } }, [{ s: "" }, {}, { s: undefined }]);
  assert.deepEqual(await reds({ s: { kind: "text" } }, [{ s: null }]), ["#0:s:wrong-type"]);
  assert.deepEqual(await reds({ s: { kind: "text", required: true } }, [{ s: undefined }]), ["#0:s:missing"]);
});

// ---- number ------------------------------------------------------------------------------------------------------------------------------------

test("number: finite JS numbers only; min / max inclusive; AT / UNDER / OVER", async () => {
  const f = { n: { kind: "number", required: true, min: 1, max: 10 } };
  for (const n of [1, 5, 10]) await green(f, [{ n }]);
  assert.deepEqual(await reds(f, [{ n: 0.99 }]), ["#0:n:under"]);
  assert.deepEqual(await reds(f, [{ n: 10.01 }]), ["#0:n:over"]);
  for (const v of ["5", true, null, [5], {}]) assert.deepEqual(await reds(f, [{ n: v }]), ["#0:n:wrong-type"], String(v));
  for (const v of [NaN, Infinity, -Infinity]) assert.deepEqual(await reds(f, [{ n: v }]), ["#0:n:bad-number"], String(v));
});

test("number fromText: a JS number AND a readable string; an unreadable string is bad-number", async () => {
  const f = { n: { kind: "number", required: true, fromText: true, min: 100, max: 2000 } };
  for (const v of [166, "166", "1,234.50", "$166", " 166 "]) await green(f, [{ n: v }]);
  for (const v of ["abc", "1e3", "12%", "", "1,23"]) assert.deepEqual(await reds(f, [{ n: v }]), ["#0:n:bad-number"], v);
  assert.deepEqual(await reds(f, [{ n: "99" }]), ["#0:n:under"]);
  assert.deepEqual(await reds(f, [{ n: "2,000.01" }]), ["#0:n:over"]);
  assert.deepEqual(await reds(f, [{ n: true }]), ["#0:n:wrong-type"]);
  assert.deepEqual(await reds(f, [{ n: Infinity }]), ["#0:n:bad-number"]);
});

test("exclusive bounds gt / lt: lt 450 -> 449.99 green, 450 red, 449.995 green; gt 0 -> 0 red", async () => {
  const f = { n: { kind: "number", required: true, lt: 450 } };
  await green(f, [{ n: 449.99 }, { n: 449.995 }]);
  assert.deepEqual(await reds(f, [{ n: 450 }]), ["#0:n:over"]);
  assert.deepEqual(await reds(f, [{ n: 450.001 }]), ["#0:n:over"]);
  const g = { n: { kind: "number", required: true, gt: 0 } };
  await green(g, [{ n: 0.001 }]);
  assert.deepEqual(await reds(g, [{ n: 0 }]), ["#0:n:under"]);
  assert.deepEqual(await reds(g, [{ n: -1 }]), ["#0:n:under"]);
  const both = { n: { kind: "number", required: true, gt: 1, lt: 3 } };
  await green(both, [{ n: 2 }]);
  assert.deepEqual(await reds(both, [{ n: 1 }, { n: 3 }]), ["#0:n:under", "#1:n:over"]);
});

// ---- oneOf -------------------------------------------------------------------------------------------------------------------------------------

test("oneOf: exact by default, folded with ignoreCase, wrong-type for non-strings", async () => {
  const f = { s: { kind: "oneOf", required: true, values: ["Closed", "open"] } };
  await green(f, [{ s: "Closed" }, { s: "open" }]);
  assert.deepEqual(await reds(f, [{ s: "closed" }, { s: "open " }, { s: "" }]), ["#0:s:not-one-of", "#1:s:not-one-of", "#2:s:not-one-of"]);
  assert.deepEqual(await reds(f, [{ s: 1 }]), ["#0:s:wrong-type"]);
  const g = { s: { kind: "oneOf", required: true, values: ["Closed"], ignoreCase: true } };
  await green(g, [{ s: "cLOSED" }]);
  assert.deepEqual(await reds(g, [{ s: "closed " }]), ["#0:s:not-one-of"]);
});

// ---- money -------------------------------------------------------------------------------------------------------------------------------------

test("money: the whole string is exactly one value; currency / unit / decimal; bounds", async () => {
  const f = { m: { kind: "money", required: true, currency: "$", min: 10, max: 500 } };
  await green(f, [{ m: "$10" }, { m: "$499.99" }, { m: "$500" }, { m: " $43.50 " }, { m: "43$" }]);
  assert.deepEqual(await reds(f, [{ m: "$9.99" }]), ["#0:m:under"]);
  assert.deepEqual(await reds(f, [{ m: "$500.01" }]), ["#0:m:over"]);
  for (const v of ["about $43", "$43 and $44", "43", "$43 USD", "€43", "", "  ", "$", "**$43**", "$43\n$44"]) assert.deepEqual(await reds(f, [{ m: v }]), ["#0:m:bad-money"], JSON.stringify(v));
  assert.deepEqual(await reds(f, [{ m: 43 }]), ["#0:m:wrong-type"]);
  const u = { m: { kind: "money", required: true, unit: ["USD", "US dollars"], currency: ["$", "€"] } };
  await green(u, [{ m: "166 US dollars" }, { m: "43 USD" }, { m: "$43 USD" }, { m: "€43" }]);
  assert.deepEqual(await reds(u, [{ m: "43 EUR" }]), ["#0:m:bad-money"]);
  const d = { m: { kind: "money", required: true, currency: "€", decimal: ",", lt: 100 } };
  await green(d, [{ m: "€43,50" }, { m: "€1.234,50".replace("1.234,50", "99,99") }]);
  assert.deepEqual(await reds(d, [{ m: "€100" }]), ["#0:m:over"]);
  assert.deepEqual(await reds([{ m: "€43,5x" }].length ? d : d, [{ m: "€43,5x" }]), ["#0:m:bad-money"]);
  const gt = { m: { kind: "money", required: true, currency: "$", gt: 10 } };
  assert.deepEqual(await reds(gt, [{ m: "$10" }, { m: "$10.01" }]), ["#0:m:under"]);
  assert.deepEqual(await reds(f, [{ m: "$" + "9".repeat(250) }]), ["#0:m:bad-money"], "over the 200-char read cap");
});

// ---- date --------------------------------------------------------------------------------------------------------------------------------------

test("date: ISO by default; lang / months; inclusive min / max and exclusive gt / lt", async () => {
  const f = { d: { kind: "date", required: true, min: "2026-01-01", max: "2026-12-31" } };
  await green(f, [{ d: "2026-01-01" }, { d: "2026-12-31" }, { d: " 2026-06-15 " }]);
  assert.deepEqual(await reds(f, [{ d: "2025-12-31" }]), ["#0:d:under"]);
  assert.deepEqual(await reds(f, [{ d: "2027-01-01" }]), ["#0:d:over"]);
  for (const v of ["2026-13-01", "2026-02-30", "Nov 18, 2026", "on 2026-06-15", "2026-06-15 2026-06-16", "26-06-15", ""]) assert.deepEqual(await reds(f, [{ d: v }]), ["#0:d:bad-date"], JSON.stringify(v));
  assert.deepEqual(await reds(f, [{ d: 20260615 }]), ["#0:d:wrong-type"]);
  const en = { d: { kind: "date", required: true, lang: "en" } };
  await green(en, [{ d: "Nov 18, 2026" }, { d: "2026-11-18" }]);
  assert.deepEqual(await reds(en, [{ d: "Nov 18, 2026 at noon" }]), ["#0:d:bad-date"]);
  const de = { d: { kind: "date", required: true, lang: "de" } };
  await green(de, [{ d: "18. November 2026" }]);
  assert.deepEqual(await reds(de, [{ d: "18. Nov 2026 abc" }]), ["#0:d:bad-date"]);
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Des"];
  await green({ d: { kind: "date", required: true, months } }, [{ d: "18 Okt 2026" }]);
  const ex = { d: { kind: "date", required: true, gt: "2026-01-01", lt: "2026-01-03" } };
  await green(ex, [{ d: "2026-01-02" }]);
  assert.deepEqual(await reds(ex, [{ d: "2026-01-01" }, { d: "2026-01-03" }]), ["#0:d:under", "#1:d:over"]);
});

// ---- time --------------------------------------------------------------------------------------------------------------------------------------

test("time: forms, inclusive 05:00..21:59 includes both ends, exclusive gt / lt", async () => {
  const f = { t: { kind: "time", required: true, min: "05:00", max: "21:59" } };
  await green(f, [{ t: "05:00" }, { t: "21:59" }, { t: "2:30 PM" }, { t: "14:30" }, { t: "9:05 PM" }]);
  assert.deepEqual(await reds(f, [{ t: "04:59" }]), ["#0:t:under"]);
  assert.deepEqual(await reds(f, [{ t: "22:00" }, { t: "10:00 PM" }]), ["#0:t:over", "#1:t:over"]);
  for (const v of ["25:00", "14:30 and more", "at 14:30", "2:30 pm", "14:30 14:31", "", "noon"]) assert.deepEqual(await reds(f, [{ t: v }]), ["#0:t:bad-time"], JSON.stringify(v));
  assert.deepEqual(await reds(f, [{ t: 1430 }]), ["#0:t:wrong-type"]);
  const ex = { t: { kind: "time", required: true, gt: "05:00", lt: "06:00" } };
  await green(ex, [{ t: "05:01" }, { t: "05:59" }]);
  assert.deepEqual(await reds(ex, [{ t: "05:00" }, { t: "06:00" }]), ["#0:t:under", "#1:t:over"]);
});

// ---- url ---------------------------------------------------------------------------------------------------------------------------------------

test("url: absolute http(s) with a host and no whitespace", async () => {
  const f = { u: { kind: "url", required: true } };
  await green(f, [{ u: "http://example.com" }, { u: "https://example.com/a?b=1#c" }, { u: " https://example.com " }, { u: "HTTPS://EXAMPLE.COM" }, { u: "http://127.0.0.1:8080/x" }, { u: "https://x.org" }, { u: "http://a.b/c?d#e" }]);
  for (const v of ["", "example.com", "ftp://example.com", "javascript:alert(1)", "http://", "http:example.com", "https:///path", "http:////x", "https:\\\\x.org", "https:/x.org", "https:x.org", "https://x.org\\y", "https://exa mple.com", "https://example.com/a b", "//example.com", "mailto:a@b.c"]) {
    assert.deepEqual(await reds(f, [{ u: v }]), ["#0:u:bad-url"], JSON.stringify(v));
  }
  assert.deepEqual(await reds(f, [{ u: 5 }]), ["#0:u:wrong-type"]);
});

// ---- items: required, unknown, not-object, gap bounds ---------------------------------------------------------------------------

test("required vs optional absent; unknown-field; item-not-object is exactly #<i>:item-not-object", async () => {
  const f = { a: { kind: "text", required: true }, b: { kind: "text" } };
  await green(f, [{ a: "x" }, { a: "x", b: "y" }]);
  assert.deepEqual(await reds(f, [{ b: "y" }, { a: "x", zzz: 1 }]), ["#0:a:missing", "#1:unknown-field:zzz"]);
  assert.deepEqual(await reds(f, [null, 5, "s", [], [{ a: "x" }], true]), ["#0:item-not-object", "#1:item-not-object", "#2:item-not-object", "#3:item-not-object", "#4:item-not-object", "#5:item-not-object"]);
  assert.deepEqual(await reds(f, [{ a: "x", ["k".repeat(300)]: 1 }]), [`#0:unknown-field:${"k".repeat(120)}`], "a worker key is clipped");
});

test("an inherited name is not a field of the item; __proto__ / constructor keys of the worker are plain unknown keys", async () => {
  const f = { a: { kind: "text", required: true } };
  assert.deepEqual(await reds(f, [Object.create({ a: "x" })]), ["#0:a:missing"]);
  assert.deepEqual(await reds(f, [JSON.parse('{"a":"x","__proto__":{"p":1}}')]), ["#0:unknown-field:__proto__"]);
  assert.deepEqual(await reds(f, [{ a: "x", constructor: 1 }]), ["#0:unknown-field:constructor"]);
});

test("gaps are bounded at 20 items with itemsTotal, in item order; never carry worker values", async () => {
  const f = { a: { kind: "text", required: true, maxChars: 3 } };
  const items = Array.from({ length: 30 }, (_, i) => ({ a: `SECRET-VALUE-${i}` }));
  const r = await run(f, items);
  const g = r.gaps[0];
  assert.equal(g.kind, "item-shape");
  assert.equal(g.items.length, 20);
  assert.equal(g.itemsTotal, 30);
  assert.equal(g.items[0], "#0:a:too-long:chars:14>3");
  assert.equal(g.items[19], "#19:a:too-long:chars:15>3");
  assert.equal(g.field, "items");
  assert.ok(!JSON.stringify(r).includes("SECRET"), "no worker text anywhere in the result");
  const exact = await run(f, items.slice(0, 20));
  assert.equal(exact.gaps[0].itemsTotal, undefined, "no itemsTotal when nothing was cut");
  assert.ok(renderGaps(r.gaps).startsWith('["a:shape'), "renders through the generic row");
});

test("fields are read in sorted-name order (the same signed spec always gives the same gap order)", async () => {
  const items = [{}];
  assert.deepEqual(await reds({ b: { kind: "text", required: true }, a: { kind: "text", required: true } }, items), ["#0:a:missing", "#0:b:missing"]);
});

// ---- object (nested) ---------------------------------------------------------------------------------------------------------------------

const NESTED = {
  quote: { kind: "text", required: true },
  values: { kind: "object", required: true, fields: { price: { kind: "number", required: true, fromText: true, min: 100, max: 1000 }, "departure time": { kind: "time", required: true } } },
};

test("object: real shape green; dropped / out-of-range / extra key / wrong shape reds with dotted paths", async () => {
  const ok = { quote: "...From 166 US dollars...", values: { price: "166", "departure time": "10:24 AM" } };
  await green(NESTED, [ok]);
  assert.deepEqual(await reds(NESTED, [{ ...ok, values: { "departure time": "10:24 AM" } }]), ["#0:values.price:missing"]);
  assert.deepEqual(await reds(NESTED, [{ ...ok, values: { price: "99", "departure time": "10:24 AM" } }]), ["#0:values.price:under"]);
  assert.deepEqual(await reds(NESTED, [{ ...ok, values: { price: "1,000.5", "departure time": "10:24 AM" } }]), ["#0:values.price:over"]);
  assert.deepEqual(await reds(NESTED, [{ ...ok, values: { ...ok.values, foo: 1 } }]), ["#0:values:unknown-field:foo"]);
  assert.deepEqual(await reds(NESTED, [{ quote: "q" }]), ["#0:values:missing"]);
  for (const v of [null, 5, "s", []]) assert.deepEqual(await reds(NESTED, [{ ...ok, values: v }]), ["#0:values:wrong-type"], JSON.stringify(v));
  assert.deepEqual(await reds(NESTED, [{ ...ok, values: { price: "x", "departure time": "later" } }]), ["#0:values.departure time:bad-time", "#0:values.price:bad-number"]);
});

test("object: two levels deep every red, optional object absent is fine, optional present is checked", async () => {
  const f = { o: { kind: "object", fields: { p: { kind: "object", required: true, fields: { n: { kind: "number", required: true } } } } } };
  await green(f, [{}, { o: { p: { n: 1 } } }]);
  assert.deepEqual(await reds(f, [{ o: {} }, { o: { p: { n: "1" } } }, { o: { p: { n: 1, z: 1 } } }, { o: { p: [] } }, { o: { y: 1, p: { n: 1 } } }]),
    ["#0:o.p:missing", "#1:o.p.n:wrong-type", "#2:o.p:unknown-field:z", "#3:o.p:wrong-type", "#4:o:unknown-field:y"]);
});

test("object: createRubric refuses a third object level (path at the offending kind) and accepts exactly two", () => {
  const two = { a: { kind: "object", fields: { b: { kind: "object", fields: { c: { kind: "text" } } } } } };
  assert.doesNotThrow(() => mk(mkCheck(two)));
  const three = { a: { kind: "object", fields: { b: { kind: "object", fields: { c: { kind: "object", fields: { d: { kind: "text" } } } } } } } };
  assert.equal(refused(mkCheck(three)).path, `${PATH}.fields.a.fields.b.fields.c.kind`);
  assert.equal(refused(mkCheck({ a: { kind: "object" } })).path, `${PATH}.fields.a.fields`);
  assert.equal(refused(mkCheck({ a: { kind: "object", fields: {} } })).path, `${PATH}.fields.a.fields`);
});

test("hostile nested: a throwing getter / revoked Proxy gives #<i>:<path>:unreadable", async () => {
  const bad = { quote: "q", get values() { throw new Error("x"); } };
  assert.deepEqual(await reds(NESTED, [bad]), ["#0:values:unreadable"]);
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.deepEqual(await reds(NESTED, [{ quote: "q", values: proxy }]), ["#0:values:unreadable"]);
  const inner = { quote: "q", values: { get price() { throw new Error("x"); }, "departure time": "10:24 AM" } };
  assert.deepEqual(await reds(NESTED, [inner]), ["#0:values.price:unreadable"]);
});

// ---- createRubric refusals, each with its path ----------------------------------------------------------------------------------

test("createRubric refusals carry e.path", () => {
  const url = { kind: "url" };
  const cases = [
    [mkCheck({ a: url }, { minItems: -1 }), `${PATH}.minItems`],
    [mkCheck({ a: url }, { minItems: 1.5 }), `${PATH}.minItems`],
    [mkCheck({ a: url }, { maxItems: 0 }), `${PATH}.maxItems`],
    [mkCheck({ a: url }, { minItems: 3, maxItems: 2 }), `${PATH}.maxItems`],
    [mkCheck({}), `${PATH}.fields`],
    [mkCheck([url]), `${PATH}.fields`],
    [mkCheck("x"), `${PATH}.fields`],
    [{ id: "s", rule: "itemShape", fields: { a: url } }, `${PATH}.field is required for itemShape`.split(" ")[0]],
    [{ id: "s", rule: "itemShape", field: "items" }, `${PATH}.fields`],
    [mkCheck({ a: "url" }), `${PATH}.fields.a`],
    [mkCheck({ a: {} }), `${PATH}.fields.a.kind`],
    [mkCheck({ a: { kind: "int" } }), `${PATH}.fields.a.kind`],
    [mkCheck({ a: { kind: "url", required: "yes" } }), `${PATH}.fields.a.required`],
    [mkCheck({ a: { kind: "url", extra: 1 } }), `${PATH}.fields.a.extra`],
    [mkCheck({ a: { kind: "text", fromText: true } }), `${PATH}.fields.a.fromText`],
    [mkCheck({ a: { kind: "text", minChars: -1 } }), `${PATH}.fields.a.minChars`],
    [mkCheck({ a: { kind: "text", maxChars: 0 } }), `${PATH}.fields.a.maxChars`],
    [mkCheck({ a: { kind: "text", minChars: 5, maxChars: 4 } }), `${PATH}.fields.a.maxChars`],
    [mkCheck({ a: { kind: "text", minWords: 3, maxWords: 2 } }), `${PATH}.fields.a.maxWords`],
    [mkCheck({ a: { kind: "text", maxWords: 1.5 } }), `${PATH}.fields.a.maxWords`],
    [mkCheck({ a: { kind: "number", min: "1" } }), `${PATH}.fields.a.min`],
    [mkCheck({ a: { kind: "number", min: 5, max: 4 } }), `${PATH}.fields.a.max`],
    [mkCheck({ a: { kind: "number", fromText: "yes" } }), `${PATH}.fields.a.fromText`],
    [mkCheck({ a: { kind: "oneOf" } }), `${PATH}.fields.a.values`],
    [mkCheck({ a: { kind: "oneOf", values: [] } }), `${PATH}.fields.a.values`],
    [mkCheck({ a: { kind: "oneOf", values: ["a", "a"] } }), `${PATH}.fields.a.values`],
    [mkCheck({ a: { kind: "oneOf", values: ["a", " "] } }), `${PATH}.fields.a.values[1]`],
    [mkCheck({ a: { kind: "oneOf", values: Array.from({ length: 51 }, (_, i) => `v${i}`) } }), `${PATH}.fields.a.values`],
    [mkCheck({ a: { kind: "oneOf", values: ["Mashy", "mashy"], ignoreCase: true } }), `${PATH}.fields.a.values`],
    [mkCheck({ a: { kind: "money" } }), `${PATH}.fields.a.currency`],
    [mkCheck({ a: { kind: "money", currency: "x" } }), `${PATH}.fields.a.currency`],
    [mkCheck({ a: { kind: "money", currency: "$", decimal: ";" } }), `${PATH}.fields.a.decimal`],
    [mkCheck({ a: { kind: "money", unit: ["USD", "USD"] } }), `${PATH}.fields.a.unit`],
    [mkCheck({ a: { kind: "money", currency: "$", min: "5" } }), `${PATH}.fields.a.min`],
    [mkCheck({ a: { kind: "money", currency: "$", min: 5, max: 4 } }), `${PATH}.fields.a.max`],
    [mkCheck({ a: { kind: "date", lang: "xx" } }), `${PATH}.fields.a.lang`],
    [mkCheck({ a: { kind: "date", lang: "en", months: ["a"] } }), `${PATH}.fields.a.months`],
    [mkCheck({ a: { kind: "date", min: "2026-02-30" } }), `${PATH}.fields.a.min`],
    [mkCheck({ a: { kind: "date", min: "2026-02-02", max: "2026-02-01" } }), `${PATH}.fields.a.max`],
    [mkCheck({ a: { kind: "date", currency: "$" } }), `${PATH}.fields.a.currency`],
    [mkCheck({ a: { kind: "time", min: "25:00" } }), `${PATH}.fields.a.min`],
    [mkCheck({ a: { kind: "time", min: "06:00", max: "05:00" } }), `${PATH}.fields.a.max`],
    [mkCheck({ a: { kind: "time", decimal: "," } }), `${PATH}.fields.a.decimal`],
    [mkCheck({ a: { kind: "url", min: 1 } }), `${PATH}.fields.a.min`],
    // exclusive bounds
    [mkCheck({ a: { kind: "number", min: 1, gt: 0 } }), `${PATH}.fields.a.gt`],
    [mkCheck({ a: { kind: "number", max: 5, lt: 9 } }), `${PATH}.fields.a.lt`],
    [mkCheck({ a: { kind: "number", gt: 5, lt: 5 } }), `${PATH}.fields.a.lt`],
    [mkCheck({ a: { kind: "number", min: 5, lt: 5 } }), `${PATH}.fields.a.lt`],
    [mkCheck({ a: { kind: "number", gt: 5, max: 5 } }), `${PATH}.fields.a.max`],
    [mkCheck({ a: { kind: "number", gt: 6, lt: 5 } }), `${PATH}.fields.a.lt`],
    [mkCheck({ a: { kind: "number", min: 6, max: 5 } }), `${PATH}.fields.a.max`],
    [mkCheck({ a: { kind: "money", currency: "$", gt: 5, lt: 5 } }), `${PATH}.fields.a.lt`],
    [mkCheck({ a: { kind: "date", gt: "2026-01-02", lt: "2026-01-02" } }), `${PATH}.fields.a.lt`],
    [mkCheck({ a: { kind: "time", min: "05:00", lt: "05:00" } }), `${PATH}.fields.a.lt`],
    [mkCheck({ a: { kind: "time", gt: "5 PM" } }), `${PATH}.fields.a.gt`],
    [mkCheck({ a: { kind: "text", gt: 1 } }), `${PATH}.fields.a.gt`],
    [mkCheck({ a: { kind: "text", lt: 1 } }), `${PATH}.fields.a.lt`],
    // names
    [mkCheck({ "a.b": url }), `${PATH}.fields.a.b`],
    [mkCheck({ "a:b": url }), `${PATH}.fields.a:b`],
    [mkCheck({ a: { kind: "object", fields: { "x.y": url } } }), `${PATH}.fields.a.fields.x.y`],
    [mkCheck({ a: { kind: "object", fields: { "x:y": url } } }), `${PATH}.fields.a.fields.x:y`],
    [mkCheck({ " ": url }), `${PATH}.fields`],
    [mkCheck({ ["n".repeat(129)]: url }), null],
    [mkCheck({ a: { kind: "object", fields: { __proto__x: 1 } } }), `${PATH}.fields.a.fields.__proto__x`],
  ];
  for (const [check, path] of cases) {
    const e = refused(check);
    if (path !== null) assert.equal(e.path, path, JSON.stringify(check));
    assert.match(e.message, /^invalid rubric: /);
  }
  assert.equal(refused(mkCheck({ a: { kind: "url" }, ["__proto__"]: 1 })).path.startsWith(PATH), true);
  assert.throws(() => mk({ id: "s", rule: "itemShape", field: "items", fields: JSON.parse('{"__proto__":{"kind":"url"}}') }), /reserved/);
});

test("field-name caps: 50 per fields object accepted, 51 refused; 200 specs across the check", () => {
  const names = (n, p = "f") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${p}${i}`, { kind: "url" }]));
  assert.doesNotThrow(() => mk(mkCheck(names(50))));
  assert.equal(refused(mkCheck(names(51))).path, `${PATH}.fields`);
  // 4 objects of 49 + 4 holders = 200 specs: ok; one more spec: refused
  const holder = (n) => Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`o${i}`, { kind: "object", fields: names(n, `g${i}_`) }]));
  assert.doesNotThrow(() => mk(mkCheck(holder(49))));
  const e = refused(mkCheck(holder(50)));
  assert.equal(e.path, `${PATH}.fields.o3.fields`);
  assert.match(e.message, /200 field specs/);
});

test("signed field name length: 128 accepted", () => {
  assert.doesNotThrow(() => mk(mkCheck({ ["n".repeat(128)]: { kind: "url" } })));
});

// ---- rubricSha / vocabulary ------------------------------------------------------------------------------------------------------------

test("a new rule leaves every existing rubricSha unchanged (shas computed on the commit before itemShape)", () => {
  const specs = [
    { schema: 1, goal: "Write the resume", checkpoints: { resume: { gating: true, checks: [{ id: "words-cap", rule: "maxWords", field: "text", value: 600 }] } } },
    { schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [{ id: "k", rule: "in", field: "f", values: ["x"], ignoreCase: true }, { id: "c", rule: "cited", claims: "c", source: "s", decides: [{ valueKind: "money", currency: "$", op: "lt", value: 5 }] }], b: { gating: false, checks: [{ id: "n", rule: "nonEmpty", field: "t" }] } } }, inputs: [{ name: "s", sha256: "a".repeat(64) }] },
  ];
  assert.deepEqual(specs.map(rubricSha), ["0e54a885f0b3fc0ea7b45d68a32b8b38b1dc42e1c011373689562fc9cb57bacd", "99bb46997db23319ffe49e84f8d877324de551a18b41ad083e7dc44b9cbfc8f0"]);
});

test("the sha of an itemShape spec does not depend on field order, and changes with any signed bound", () => {
  const a = createRubric({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [mkCheck({ x: { kind: "url" }, y: { kind: "text", maxChars: 5 } })] } } });
  const b = createRubric({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [mkCheck({ y: { maxChars: 5, kind: "text" }, x: { kind: "url" } })] } } });
  const c = createRubric({ schema: 1, goal: "g", checkpoints: { a: { gating: true, checks: [mkCheck({ x: { kind: "url" }, y: { kind: "text", maxChars: 6 } })] } } });
  assert.equal(rubricSha(a), rubricSha(b));
  assert.notEqual(rubricSha(a), rubricSha(c));
});

test("vocabulary: itemShape is the last rule, lists every kind and each option; the description is generated", () => {
  const v = rubricVocabulary.rules.itemShape;
  assert.equal(Object.keys(rubricVocabulary.rules).at(-1), "itemShape");
  assert.deepEqual(v.fields.fields.common.kind.enum, ["text", "number", "oneOf", "money", "date", "time", "url", "object"]);
  assert.deepEqual(Object.keys(v.fields.fields.kinds.number), ["min", "max", "gt", "lt", "fromText"]);
  assert.equal(v.fields.fields.maxFields, 50);
  assert.equal(v.fields.fields.maxTotalFields, 200);
  assert.equal(v.fields.fields.maxObjectDepth, 2);
  for (const k of ["itemShape", "minItems", "maxItems", "fromText", "ignoreCase", "currency"]) assert.ok(v.description.includes(k), k);
});

// ---- hostile output ---------------------------------------------------------------------------------------------------------------------

test("hostile outputs never throw: getters, revoked Proxy, lying length, cycles, __proto__, huge strings", async () => {
  const f = { a: { kind: "text", maxChars: 3 }, d: { kind: "date" }, m: { kind: "money", currency: "$" }, n: { kind: "object", fields: { x: { kind: "text" } } } };
  const c = mk(mkCheck(f));
  const go = (items) => checkStep(c, "a", { items });
  const { proxy: dead, revoke } = Proxy.revocable([], {});
  revoke();
  const liar = new Proxy([], { get: (t, k) => (k === "length" ? 2 ** 32 - 1 : Reflect.get(t, k)) });
  const liar2 = new Proxy([], { get: (t, k) => (k === "length" ? 3 : undefined) });
  const throwingLen = new Proxy([], { get: (t, k) => { if (k === "length") throw new Error("len"); return Reflect.get(t, k); } });
  const cyc = { a: "x" }; cyc.self = cyc; cyc.n = cyc;
  const arrCyc = []; arrCyc.push(arrCyc);
  const keyThrow = new Proxy({}, { ownKeys() { throw new Error("keys"); } });
  const outs = [dead, liar, liar2, throwingLen, [cyc], [arrCyc], [keyThrow], [dead], [{ get a() { throw new Error("g"); } }], [new Proxy({}, { get() { throw new Error("p"); } })],
    [JSON.parse('{"__proto__":1,"a":"x"}')], [{ a: "x".repeat(5_000_000), d: "9".repeat(5_000_000), m: "$".repeat(1_000_000) }], [Object.create(null)], [{ n: Object.create(null) }], [{ n: cyc }]];
  for (const out of outs) {
    const r = await go(out);
    assert.ok(["red", "green"].includes(r.verdict), `verdict ${r.verdict}`);
  }
  assert.equal((await go(liar)).gaps[0].kind, "too-many");
  assert.deepEqual((await go([{ get a() { throw new Error("g"); } }])).gaps[0].items, ["#0:a:unreadable"]);
  assert.deepEqual((await go([keyThrow])).gaps[0].items, ["#0:unreadable"]);
  assert.deepEqual((await go([dead])).gaps[0].items, ["#0:unreadable"], "a revoked Proxy item");
  assert.deepEqual((await go([cyc])).gaps[0].items, ["#0:n:unknown-field:a", "#0:n:unknown-field:self", "#0:n:unknown-field:n", "#0:unknown-field:self"], "a cyclic item is read to the signed depth only");
  assert.deepEqual((await go([{ a: "x".repeat(5_000_000) }])).gaps[0].items, ["#0:a:too-long:chars:5000000>3"]);
  assert.deepEqual((await go([{ d: "9".repeat(5_000_000) }])).gaps[0].items, ["#0:d:bad-date"]);
});

test("a hostile item with a throwing getter AFTER other reds keeps only #<i>:<path>:unreadable for that field", async () => {
  const f = { a: { kind: "text", maxChars: 1 }, b: { kind: "text" } };
  const item = { a: "xyz", get b() { throw new Error("x"); } };
  assert.deepEqual(await reds(f, [item]), ["#0:a:too-long:chars:3>1", "#0:b:unreadable"]);
});

// ---- linearity --------------------------------------------------------------------------------------------------------------------------

test("cost is linear in the output: 4x the items costs under 10x (best of 3)", async () => {
  const c = mk(mkCheck({
    t: { kind: "text", maxChars: 10, maxWords: 3 }, n: { kind: "number", fromText: true, min: 0 }, s: { kind: "oneOf", values: ["a", "b"] },
    m: { kind: "money", currency: "$", unit: "USD" }, d: { kind: "date", lang: "en" }, h: { kind: "time" }, u: { kind: "url" }, o: { kind: "object", fields: { x: { kind: "text" } } },
  }));
  const mkItems = (n) => Array.from({ length: n }, (_, i) => ({ t: "word ".repeat(i % 7), n: `${i}`, s: "a", m: `$${i}`, d: "Nov 18, 2026", h: "2:30 PM", u: "https://example.com/x", o: { x: "y", z: i }, extra: 1 }));
  const best = async (items) => {
    let b = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = process.hrtime.bigint();
      await checkStep(c, "a", { items });
      b = Math.min(b, Number(process.hrtime.bigint() - t));
    }
    return b;
  };
  await best(mkItems(200));
  const small = await best(mkItems(2_000));
  const large = await best(mkItems(8_000));
  assert.ok(large < Math.max(small, 2_000_000) * 10, `${small} ns -> ${large} ns is not linear`);
  // one huge string and one wide item are linear too
  const wide = await best([Object.fromEntries(Array.from({ length: 40_000 }, (_, i) => [`k${i}`, 1]))]);
  assert.ok(wide < 2_000_000_000);
});
