import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRubric, rubricSha, rubricVocabulary, checkStep } from "../src/index.js";
import { describeRule } from "../src/primitives/rubric.js";

// ---------------------------------------------------------------------------
// createRubric / rubricSha / rubricVocabulary (docs/product/rubric-prd.md §3, §4, §9)
// ---------------------------------------------------------------------------

const spec = (checks, extra = {}) => ({
  schema: 1,
  goal: "Write the resume",
  checkpoints: { resume: { gating: true, checks } },
  ...extra,
});
const mw = (over = {}) => ({ id: "words-cap", rule: "maxWords", field: "text", value: 600, ...over });
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("createRubric: a valid spec returns a deep-frozen copy; the caller's object is not held", () => {
  const s = spec([mw()]);
  const r = createRubric(s);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.checkpoints) && Object.isFrozen(r.checkpoints.resume.checks[0]));
  s.checkpoints.resume.checks[0].value = 1; // post-construction mutation of the caller's object
  assert.equal(r.checkpoints.resume.checks[0].value, 600);
  assert.throws(() => { r.goal = "x"; }, TypeError);
});

const refusals = [
  ["unknown check type", spec([{ id: "a", rule: "frobnicate", field: "text" }]), /checks\[0\]\.rule is not a known check type: "frobnicate"/],
  ["judged (Next, not Day 1)", spec([{ id: "a", rule: "judged", kind: "verdict", ask: "q" }]), /not a known check type: "judged"/],
  ["unknown field on a check", spec([mw({ extra: 1 })]), /\.extra is not a recognised field/],
  ["missing required field", spec([{ id: "a", rule: "maxWords", field: "text" }]), /\.value is required for maxWords/],
  ["count 0", spec([mw({ value: 0 })]), /integer >= 1/],
  ["count negative", spec([mw({ value: -3 })]), /integer >= 1/],
  ["count non-integer", spec([mw({ value: 1.5 })]), /integer >= 1/],
  ["count a numeric string", spec([mw({ value: "600" })]), /integer >= 1/],
  ["strict not boolean", spec([mw({ strict: "yes" })]), /strict must be a boolean/],
  ["empty names list", spec([{ id: "a", rule: "sections", field: "text", names: [] }]), /non-empty array/],
  ["empty string in list", spec([{ id: "a", rule: "sections", field: "text", names: ["A", ""] }]), /names\[1\] must be a non-blank string/],
  ["whitespace-only string in list", spec([{ id: "a", rule: "sections", field: "text", names: ["  \t"] }]), /names\[0\] must be a non-blank string/],
  ["list is not an array", spec([{ id: "a", rule: "sections", field: "text", names: "A" }]), /non-empty array/],
  ["blockLines without size", spec([{ id: "a", rule: "blockLines", field: "text", phrases: ["x"] }]), /\.size is required for blockLines/],
  ["blockLines without phrases", spec([{ id: "a", rule: "blockLines", field: "text", size: 3 }]), /\.phrases is required for blockLines/],
  ["notWorse without direction", spec([{ id: "a", rule: "notWorse", baseline: 0 }]), /\.direction is required for notWorse/],
  ["notWorse direction not an enum member", spec([{ id: "a", rule: "notWorse", baseline: 0, direction: "lower" }]), /direction must be one of/],
  ["notWorse baseline a non-seed string", spec([{ id: "a", rule: "notWorse", baseline: "latest", direction: "lower-is-better" }]), /baseline must be a finite number or "seed"/],
  ["whitespace-only mustCarry phrase", spec([{ id: "a", rule: "mustCarry", field: "text", phrases: ["   "] }]), /phrases\[0\] must be a non-blank string/],
  ["empty mustCarry phrases list", spec([{ id: "a", rule: "mustCarry", field: "text", phrases: [] }]), /phrases must be a non-empty array/],
  ["mustCarry with the old single-phrase `text` and no phrases", spec([{ id: "a", rule: "mustCarry", field: "text", text: "hi" }]), /\.phrases is required for mustCarry/],
  ["blockLines with an empty phrase", spec([{ id: "a", rule: "blockLines", field: "text", size: 2, phrases: [""] }]), /phrases\[0\] must be a non-blank string/],
  ["blockLines with the old `mustCarry` list", spec([{ id: "a", rule: "blockLines", field: "text", size: 2, mustCarry: ["x"], phrases: ["x"] }]), /\.mustCarry is not a recognised field/],
  ["text (explanation) not a string", spec([mw({ text: 5 })]), /text must be a string/],
  ["noneExit on commandExit (a do-nothing param)", spec([{ id: "a", rule: "commandExit", noneExit: 1 }]), /\.noneExit is not a recognised field/],
  ["blank field name", spec([mw({ field: " " })]), /field must be a non-blank string/],
  ["field name too long", spec([mw({ field: "f".repeat(129) })]), /at most 128/],
  ["duplicate id in a checkpoint", spec([mw(), mw()]), /duplicates id "words-cap"/],
  ["id containing ':'", spec([mw({ id: "a:b" })]), /must not contain ":"/],
  ["id equal to a foundational name", spec([mw({ id: "happened" })]), /reserved foundational name/],
  ["atMost value not in order", spec([{ id: "a", rule: "atMost", field: "s", value: "z", order: ["a", "b"] }]), /must be one of order/],
  ["atMost duplicate order entries", spec([{ id: "a", rule: "atMost", field: "s", value: "a", order: ["a", "a"] }]), /duplicates/],
  ["complete with neither items nor itemsFrom", spec([{ id: "a", rule: "complete", claims: "c" }]), /exactly one of items, itemsFrom/],
  ["complete with both", spec([{ id: "a", rule: "complete", claims: "c", items: ["x"], itemsFrom: "caller" }]), /exactly one of items, itemsFrom/],
  ["complete itemsFrom not 'caller'", spec([{ id: "a", rule: "complete", claims: "c", itemsFrom: "judge" }]), /itemsFrom must be one of "caller"/],
  ["cited source not in inputs", spec([{ id: "a", rule: "cited", claims: "c", source: "doc" }]), /not in spec\.inputs/],
  ["requiresHuman on a non-gating checkpoint", { schema: 1, goal: "g", checkpoints: { c: { gating: false, requiresHuman: true, checks: [] } } }, /needs a gating checkpoint/],
  ["requiresHuman false", { schema: 1, goal: "g", checkpoints: { c: { gating: true, requiresHuman: false, checks: [] } } }, /must be true when present/],
  ["onExhausted ask (Later)", spec([mw()], { onExhausted: "ask" }), /"ask", which is not available yet/],
  ["onExhausted junk", spec([mw()], { onExhausted: "retry" }), /must be "fail"/],
  ["maxReds 0", spec([mw()], { maxReds: 0 }), /maxReds must be an integer >= 1/],
  ["reads 0", spec([mw()], { reads: 0 }), /reads must be an integer >= 1/],
  ["wrong schema", spec([mw()], { schema: 2 }), /schema must be 1/],
  ["blank goal", spec([mw()], { goal: "  " }), /goal must be a non-blank string/],
  ["unknown top-level key", spec([mw()], { advanceOn: "x" }), /spec\.advanceOn is not a recognised field/],
  ["no checkpoints", { schema: 1, goal: "g", checkpoints: {} }, /at least one checkpoint/],
  ["checkpoint id with ':'", { schema: 1, goal: "g", checkpoints: { "a:b": { gating: true, checks: [] } } }, /must not contain ":"/],
  ["gating not boolean", { schema: 1, goal: "g", checkpoints: { c: { gating: "yes", checks: [] } } }, /gating must be a boolean/],
  ["input with a bad sha", spec([mw()], { inputs: [{ name: "doc", sha256: "abc" }] }), /64-character lowercase hex/],
  ["duplicate input names", spec([mw()], { inputs: [{ name: "d", sha256: "a".repeat(64) }, { name: "d", sha256: "b".repeat(64) }] }), /duplicate input name/],
  ["judge without a model", spec([mw()], { judge: { provider: "jev" } }), /judge\.model must be a non-blank string/],
  ["spec not an object", [], /spec must be an object/],
  ["spec null", null, /spec must be an object/],
  ["NaN value", spec([{ id: "a", rule: "max", field: "x", value: NaN }]), /finite number/],
  ["Infinity value", spec([{ id: "a", rule: "max", field: "x", value: Infinity }]), /finite number/],
  ["undefined value", spec([mw({ strict: undefined })]), /unsupported type \(undefined\)/],
  ["function value", spec([mw({ strict: () => 1 })]), /unsupported type \(function\)/],
  ["class instance", spec([mw({ value: new Date() })]), /must be a plain object/],
];
for (const [label, s, re] of refusals) {
  test(`createRubric refuses: ${label}`, () => {
    assert.throws(() => createRubric(s), (e) => e instanceof Error && re.test(e.message), `expected ${re}`);
  });
}

test("createRubric refuses __proto__ / constructor / prototype keys at any depth (own keys, via JSON.parse)", () => {
  const top = JSON.parse('{"schema":1,"goal":"g","checkpoints":{"c":{"gating":true,"checks":[]}},"__proto__":{"x":1}}');
  assert.throws(() => createRubric(top), /spec\.__proto__ is a reserved key name/);
  const inCheck = JSON.parse('{"schema":1,"goal":"g","checkpoints":{"c":{"gating":true,"checks":[{"id":"a","rule":"nonEmpty","field":"t","__proto__":1}]}}}');
  assert.throws(() => createRubric(inCheck), /__proto__ is a reserved key name/);
  for (const k of ["constructor", "prototype"]) {
    const cp = { schema: 1, goal: "g", checkpoints: { [k]: { gating: true, checks: [] } } };
    assert.throws(() => createRubric(cp), new RegExp(`${k} is a reserved key name`));
  }
  assert.equal({}.x, undefined, "Object.prototype was not polluted");
});

test("createRubric: hostile spec (throwing getter, throwing Proxy, deep nesting, cycle) throws a clean Error, never anything else", () => {
  const getter = spec([mw()]);
  Object.defineProperty(getter, "goal", { enumerable: true, get() { throw new Error("boom"); } });
  assert.throws(() => createRubric(getter), /spec is unreadable \(boom\)/);
  const proxy = new Proxy({}, { ownKeys() { throw new Error("nope"); } });
  assert.throws(() => createRubric(proxy), /spec is unreadable/);
  const cyc = spec([mw()]);
  cyc.self = cyc;
  assert.throws(() => createRubric(cyc), /nested too deeply \(or cyclic\)/);
  assert.throws(() => rubricSha(cyc), /nested too deeply/);
});

test("createRubric bounds: a huge count is accepted (no maximum); 1 is the minimum", () => {
  for (const v of [1, 1e9, Number.MAX_SAFE_INTEGER, 1e300]) assert.doesNotThrow(() => createRubric(spec([mw({ value: v })])), `value ${v}`);
  assert.throws(() => createRubric(spec([mw({ value: 0 })])));
  const r = createRubric(spec([{ id: "b", rule: "blockLines", field: "text", size: 1e9, phrases: ["x"] }], { reads: 1e9, maxReds: 1e9 }));
  assert.equal(r.checkpoints.resume.checks[0].size, 1e9);
});

test("createRubric accepts every rule's minimal valid shape, and ordered/value rules take any finite number", () => {
  assert.doesNotThrow(() => createRubric(spec([
    { id: "a", rule: "max", field: "x", value: -5 },
    { id: "b", rule: "min", field: "x", value: 0 },
    { id: "c", rule: "commandExit", expectExit: 3, text: "the signer's note" },
    { id: "d", rule: "notWorse", direction: "higher-is-better", baseline: "seed" },
  ])));
});

test("createRubric with opts.sha256: verifies the signed fingerprint (unsigned or tampered is refused)", () => {
  const s = spec([mw()]);
  assert.doesNotThrow(() => createRubric(s, { sha256: rubricSha(s) }));
  assert.throws(() => createRubric(spec([mw({ value: 601 })]), { sha256: rubricSha(s) }), /does not match the rubric: unsigned or tampered/);
  assert.throws(() => createRubric(s, {}), /opts\.sha256 is required/);
  assert.throws(() => createRubric(s, { sha256: rubricSha(s).toUpperCase() }), /does not match/);
});

// --- rubricSha ---------------------------------------------------------------

test("rubricSha: known answer pins the canonical form (sorted-key JSON, no whitespace, sha256 hex)", () => {
  const got = rubricSha({ schema: 1, goal: "g", checkpoints: {} });
  assert.equal(got, sha('{"checkpoints":{},"goal":"g","schema":1}'));
  assert.match(got, /^[0-9a-f]{64}$/);
});

test("rubricSha: key order never matters; array order does; a rubric hashes the same as its spec", () => {
  const a = { schema: 1, goal: "g", checkpoints: { c: { gating: true, checks: [mw(), { id: "b", rule: "nonEmpty", field: "text" }] } } };
  const b = { checkpoints: { c: { checks: [{ field: "text", rule: "maxWords", value: 600, id: "words-cap" }, { rule: "nonEmpty", id: "b", field: "text" }], gating: true } }, goal: "g", schema: 1 };
  assert.equal(rubricSha(a), rubricSha(b));
  const swapped = structuredClone(a);
  swapped.checkpoints.c.checks.reverse();
  assert.notEqual(rubricSha(a), rubricSha(swapped));
  assert.equal(rubricSha(createRubric(a)), rubricSha(a));
});

test("rubricSha: changing ANY leaf changes the hash (goal, ids, values, judge identity, inputs, flags)", () => {
  const base = spec([mw(), { id: "m", rule: "mustCarry", field: "text", phrases: ["hi"] }], {
    inputs: [{ name: "doc", sha256: "a".repeat(64) }],
    judge: { provider: "jev", model: "jev-1.13.0", cutoff: 0.5, band: 0.1 },
    reads: 2, maxReds: 3, onExhausted: "fail",
  });
  const baseSha = rubricSha(base);
  let leaves = 0;
  const walk = (node, path) => {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v !== null && typeof v === "object") { walk(v, [...path, k]); continue; }
      leaves++;
      const copy = structuredClone(base);
      let t = copy;
      for (const p of path) t = t[p];
      t[k] = typeof v === "string" ? v + "x" : typeof v === "number" ? v + 1 : !v;
      assert.notEqual(rubricSha(copy), baseSha, `leaf ${[...path, k].join(".")} must change the hash`);
    }
  };
  walk(base, []);
  assert.equal(leaves, 20, "walked every scalar leaf of the spec");
});

test("rubricSha: refuses non-JSON data instead of hashing a lossy form (NaN would otherwise collide with null)", () => {
  assert.throws(() => rubricSha({ a: NaN }), /finite number/);
  assert.throws(() => rubricSha({ a: undefined }), /unsupported type/);
  assert.throws(() => rubricSha({ a: 10n }), /unsupported type/);
  assert.throws(() => rubricSha(JSON.parse('{"__proto__":1}')), /reserved key name/);
});

// --- rubricVocabulary ---------------------------------------------------------

const DAY1_RULES = [
  "atMost", "blockLines", "cited", "commandExit", "complete", "filesChanged", "in", "max", "maxLines", "maxWords",
  "min", "minWords", "mustCarry", "nonEmpty", "notIn", "notWorse", "patternAbsent", "sectionOrder", "sections",
];

const sampleValue = (name, d) => {
  switch (d.type) {
    case "name": case "string": return "a";
    case "integer": return d.min ?? 1;
    case "number": return 1;
    case "boolean": return true;
    case "string-list": return ["a"];
    case "enum": return d.enum[0];
    case "number-or-enum": return 1;
    default: throw new Error(`test has no sample for type ${d.type}`);
  }
};
const sampleCheck = (rule, def) => {
  const c = { id: "chk", rule };
  const skip = new Set(def.exactlyOne ? def.exactlyOne.slice(1) : []);
  for (const [n, d] of Object.entries(def.fields)) if ((d.required || (def.exactlyOne ?? []).includes(n)) && !skip.has(n)) c[n] = sampleValue(n, d);
  return c;
};
const withInputs = (checks) => spec(checks, { inputs: [{ name: "a", sha256: "a".repeat(64) }] });

test("rubricVocabulary: deep-frozen, and lists exactly the Day-1 rules", () => {
  const deepFrozen = (o) => o === null || typeof o !== "object" || (Object.isFrozen(o) && Object.values(o).every(deepFrozen));
  assert.ok(deepFrozen(rubricVocabulary));
  assert.deepEqual(Object.keys(rubricVocabulary.rules).sort(), DAY1_RULES);
  assert.deepEqual(rubricVocabulary.common.rule.enum.slice().sort(), DAY1_RULES);
  assert.equal(rubricVocabulary.rules.judged, undefined, "judged is Next, not in the Day-1 vocabulary");
});

test("rubricVocabulary: documents bounds and defaults (count >= 1 no max, strict default false, expectExit default 0)", () => {
  const v = rubricVocabulary.rules;
  assert.deepEqual(v.maxWords.fields.value, { type: "integer", required: true, min: 1, max: null });
  assert.deepEqual(v.maxWords.fields.strict, { type: "boolean", required: false, default: false });
  assert.equal(v.commandExit.fields.expectExit.default, 0);
  assert.deepEqual(v.blockLines.fields.size, { type: "integer", required: true, min: 1, max: null });
  assert.equal(v.blockLines.fields.phrases.required, true);
  assert.equal(v.mustCarry.fields.phrases.required, true);
  assert.deepEqual(v.maxWords.fields.text, { type: "explanation", required: false });
  assert.equal(v.commandExit.fields.noneExit, undefined, "commandExit has no noneExit");
  assert.ok(v.patternAbsent.fields.noneExit && v.notWorse.fields.noneExit && v.filesChanged.fields.noneExit);
  assert.equal(v.notWorse.fields.direction.required, true);
  assert.deepEqual(v.sections.fields.names, { type: "string-list", required: true, minItems: 1, itemType: "string", nonBlank: true, itemMaxLength: 1000 });
  assert.equal(rubricVocabulary.bounds.stringList.itemMaxLength, 1000);
  assert.deepEqual(rubricVocabulary.bounds.signedString, { maxLength: 1000 });
  assert.equal(rubricVocabulary.bounds.quoteSourceMaxBytes, 5 * 1024 * 1024);
});

for (const rule of DAY1_RULES) {
  test(`rubricVocabulary <-> implementation, both directions: ${rule}`, async () => {
    const def = rubricVocabulary.rules[rule];
    const build = (c) => withInputs([c]);
    // vocab -> implemented: its minimal valid check is accepted, and dispatch reaches a real runner
    const ok = sampleCheck(rule, def);
    const rubric = createRubric(build(ok));
    const r = await checkStep(rubric, "resume", { a: "x", text: "x" }, {});
    assert.notEqual(r.fault?.kind, "exception", `${rule} has a runner (no dispatch exception): ${r.fault?.detail}`);
    // implemented -> vocab: nothing is accepted that the vocab does not list
    assert.throws(() => createRubric(build({ ...ok, notInVocab: 1 })), /not a recognised field/);
    for (const [n, d] of Object.entries(def.fields)) {
      if (d.required && !(def.exactlyOne ?? []).includes(n)) {
        const { [n]: _drop, ...without } = ok;
        assert.throws(() => createRubric(build(without)), new RegExp(`${n} is required`), `${rule}.${n} required`);
      }
      // every field rejects a value of an impossible type
      assert.throws(() => createRubric(build({ ...ok, [n]: { nested: true } })), /\.|must/, `${rule}.${n} rejects an object`);
    }
    // generated description names every field
    assert.equal(def.description, describeRule(rule));
    for (const n of Object.keys(def.fields)) assert.ok(def.description.includes(n), `${rule} description mentions ${n}`);
  });
}

test("describeRule: unknown rule throws (the description is generated, never free text)", () => {
  assert.throws(() => describeRule("frobnicate"), /unknown rubric rule/);
  assert.throws(() => describeRule("constructor"), /unknown rubric rule/, "inherited names are not rules");
});

test("an inherited Object.prototype name is not a check type", () => {
  for (const rule of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assert.throws(() => createRubric(spec([{ id: "a", rule, field: "t" }])), /not a known check type/);
  }
});

// --- RULED (hamr, 2026-10-08): signed names are never clipped; bounded at createRubric; no trailing ":" ---

test("a signed name/phrase/value is refused past 1000 characters at createRubric, accepted AT 1000 (every signed string path)", () => {
  const at = "n".repeat(1000);
  const over = "n".repeat(1001);
  const cases = [
    (v) => ({ id: "a", rule: "sections", field: "text", names: [v] }),
    (v) => ({ id: "a", rule: "sectionOrder", field: "text", names: [v] }),
    (v) => ({ id: "a", rule: "mustCarry", field: "text", phrases: [v] }),
    (v) => ({ id: "a", rule: "blockLines", field: "text", size: 1, phrases: [v] }),
    (v) => ({ id: "a", rule: "in", field: "text", values: [v] }),
    (v) => ({ id: "a", rule: "notIn", field: "text", values: [v] }),
    (v) => ({ id: "a", rule: "atMost", field: "text", value: v, order: [v, "z"] }),
    (v) => ({ id: "a", rule: "atMost", field: "text", value: "z", order: [v, "z"] }),
    (v) => ({ id: "a", rule: "patternAbsent", patterns: [v] }),
    (v) => ({ id: "a", rule: "filesChanged", allowPrefixes: [v], requireNonEmpty: false }),
    (v) => ({ id: "a", rule: "notWorse", direction: "lower-is-better", baseline: 1, terms: [v] }),
  ];
  for (const mk of cases) {
    assert.doesNotThrow(() => createRubric(spec([mk(at)])), `${mk(at).rule} at 1000`);
    assert.throws(() => createRubric(spec([mk(over)])), /must be at most 1000 characters/, `${mk(over).rule} at 1001`);
  }
  assert.throws(() => createRubric(spec([{ id: "a", rule: "complete", claims: "c", items: [over] }])), /must be at most 1000 characters/);
});

test("a section name ending in ':' (after trim) is refused at createRubric and the error names it; sections AND sectionOrder; mustCarry unaffected", () => {
  for (const rule of ["sections", "sectionOrder"]) {
    for (const bad of ["Summary:", "Skills :", "Skills:  ", " Experience: "]) {
      assert.throws(
        () => createRubric(spec([{ id: "a", rule, field: "text", names: ["Fine", bad] }])),
        (e) => e.path === "spec.checkpoints.resume.checks[0].names[1]" && e.message.includes(JSON.stringify(bad)) && /ends in ":"/.test(e.message),
        `${rule} ${JSON.stringify(bad)}`,
      );
    }
    assert.doesNotThrow(() => createRubric(spec([{ id: "a", rule, field: "text", names: ["Summary", "a:b", ":lead"] }])), "an inner/leading ':' is fine");
  }
  assert.doesNotThrow(() => createRubric(spec([{ id: "a", rule: "mustCarry", field: "text", phrases: ["Total:"] }])), "a phrase may end in ':'");
});
