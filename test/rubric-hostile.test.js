import test from "node:test";
import assert from "node:assert/strict";
import { createRubric, checkStep, renderGaps } from "../src/index.js";

// ---------------------------------------------------------------------------
// checkStep never throws because of the OUTPUT or the caller's measurements:
// a read failure is red, a measurement failure is stopped (Laws 1 and 10; PRD §7 Security).
// ---------------------------------------------------------------------------

const checks = [
  { id: "n", rule: "nonEmpty", field: "text" },
  { id: "w", rule: "maxWords", field: "text", value: 5 },
  { id: "s", rule: "sections", field: "text", names: ["A"] },
  { id: "m", rule: "mustCarry", field: "text", text: "x" },
  { id: "b", rule: "blockLines", field: "text", size: 2, mustCarry: ["x"] },
  { id: "i", rule: "in", field: "text", values: ["x"] },
  { id: "mx", rule: "max", field: "text", value: 1 },
];
const rubric = createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks } } });
const go = (out, opts) => checkStep(rubric, "cp", out, opts);

test("non-string, non-object outputs are red 'happened' (wrong-type), never a throw", async () => {
  for (const out of [undefined, null, 42, NaN, true, 10n, Symbol("s"), () => 1, [], ["a"], new Date(0)]) {
    const r = await go(out);
    assert.equal(r.verdict, "red", String(typeof out));
    assert.deepEqual(r.gaps.map((g) => g.check), ["happened"]);
    assert.equal(r.outputSha, null);
  }
  // a Date has no own keys: empty -> red; a boxed String likewise is an object with index keys, still handled
  assert.doesNotThrow(() => go(new String("abc")));
});

test("a throwing GETTER on a checked field is red 'unreadable' for every rule that reads it", async () => {
  const out = { get text() { throw new Error("getter boom"); }, other: "fine" };
  const r = await go(out);
  assert.equal(r.verdict, "red");
  assert.equal(r.gaps.length, checks.length, "every field-reading check is red");
  assert.ok(r.gaps.every((g) => g.kind === "unreadable"));
  assert.equal(r.fault, null);
});

test("a Proxy output whose traps throw is red, not a throw (ownKeys, has, getOwnPropertyDescriptor, get)", async () => {
  const boom = () => { throw new Error("trap"); };
  for (const trap of ["ownKeys", "has", "getOwnPropertyDescriptor", "get", "getPrototypeOf"]) {
    const p = new Proxy({ text: "x" }, { [trap]: boom });
    const r = await go(p);
    assert.equal(r.verdict, "red", trap);
    assert.equal(r.fault, null);
  }
});

test("'__proto__' / 'constructor' keys in the output are plain data: not read as fields, nothing polluted", async () => {
  const out = JSON.parse('{"__proto__":{"text":"polluted words here"},"constructor":{"text":"x"}}');
  const r = await go(out);
  assert.equal(r.verdict, "red");
  assert.ok(r.gaps.every((g) => g.kind === "missing"), "field 'text' is not an own key");
  assert.equal(({}).text, undefined);
  const inherited = Object.create({ text: "inherited value" });
  inherited.own = 1;
  assert.ok((await go(inherited)).gaps.every((g) => g.kind === "missing"), "inherited fields are not read");
});

test("a 10 MB output is checked without a throw and the gap stays small and bounded", async () => {
  const big = "word ".repeat(2_000_000); // 10 MB
  const t0 = Date.now();
  const r = await go(big);
  assert.equal(r.verdict, "red");
  const w = r.gaps.find((g) => g.check === "maxWords");
  assert.equal(w.measured, 2_000_000);
  assert.ok(JSON.stringify(r.gaps).length < 5000, "no output bytes ride the gaps");
  assert.match(r.outputSha, /^[0-9a-f]{64}$/);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
});

test("a 10 MB value in a gap-bearing field is clipped, never echoed whole", async () => {
  const rub = createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "i", rule: "in", field: "v", values: ["a"] }] } } });
  const r = await checkStep(rub, "cp", { v: "z".repeat(10_000_000) });
  assert.equal(r.gaps[0].measured.length, 120);
  assert.ok(JSON.stringify(r).length < 3000);
});

test("a hostile claims array (Proxy that throws, huge length) is red, not a throw", async () => {
  const rub = createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "c", rule: "complete", claims: "claims", items: ["a"] }] } } });
  const bad = new Proxy([], { get(t, k) { if (k === "length") throw new Error("len"); return t[k]; } });
  assert.equal((await checkStep(rub, "cp", { claims: bad })).gaps[0].kind, "unreadable");
  const huge = { length: 1e9 };
  Object.setPrototypeOf(huge, Array.prototype);
  assert.doesNotThrow(() => checkStep(rub, "cp", { claims: huge }));
});

test("a measurement that throws is STOPPED (exception), never an empty set or a zero", async () => {
  const mk = (check) => createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "m", ...check }] } } });
  const nw = mk({ rule: "notWorse", direction: "lower-is-better", baseline: 0 });
  const throwingValue = { exit: 0, matchedPreScope: 5, get value() { throw new Error("measure boom"); } };
  const throwingHits = { exit: 0, matchedPreScope: 5, get hits() { throw new Error("hits boom"); } };
  const throwingPaths = { exit: 0, matchedPreScope: 5, get paths() { throw new Error("paths boom"); } };
  const throwingProxy = new Proxy({}, { has() { throw new Error("p"); }, getOwnPropertyDescriptor() { throw new Error("p"); }, get() { throw new Error("p"); } });
  const cases = [
    [nw, throwingValue], [nw, throwingProxy],
    [mk({ rule: "patternAbsent", patterns: ["p"] }), throwingHits],
    [mk({ rule: "filesChanged", allowPrefixes: ["/tmp"], requireNonEmpty: false }), throwingPaths],
    [mk({ rule: "commandExit" }), { get exit() { throw new Error("exit boom"); } }],
  ];
  for (const [rub, m] of cases) {
    const r = await checkStep(rub, "cp", { text: "x" }, { measurements: { m } });
    assert.equal(r.verdict, "stopped");
    assert.equal(r.fault.kind, "exception");
    assert.match(r.fault.detail, /boom|p$/);
    assert.deepEqual(r.gaps, []);
  }
});

test("opts.measurements itself hostile (throwing getter on opts, Proxy map) is STOPPED for the check that needs it, not a throw", async () => {
  const rub = createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "m", rule: "commandExit" }] } } });
  const opts = { get measurements() { throw new Error("opts boom"); } };
  const r = await checkStep(rub, "cp", { text: "x" }, opts);
  assert.deepEqual([r.verdict, r.fault.kind], ["stopped", "exception"]);
  const proxyMap = new Proxy({}, { has() { throw new Error("x"); }, getOwnPropertyDescriptor() { throw new Error("x"); } });
  assert.equal((await checkStep(rub, "cp", { text: "x" }, { measurements: proxyMap })).verdict, "stopped");
  // a rubric with no measured check never touches the hostile option
  assert.equal((await checkStep(createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [] } } }), "cp", "x", opts)).verdict, "green");
});

test("a fault's detail is bounded even when the exception message is enormous or its getter throws", async () => {
  const rub = createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "m", rule: "commandExit" }] } } });
  const big = { get exit() { throw new Error("E".repeat(1_000_000)); } };
  const r = await checkStep(rub, "cp", "x", { measurements: { m: big } });
  assert.ok(r.fault.detail.length <= 200);
  const nasty = { get exit() { throw { get message() { throw new Error("inner"); }, toString() { throw new Error("ts"); } }; } };
  const r2 = await checkStep(rub, "cp", "x", { measurements: { m: nasty } });
  assert.deepEqual([r2.verdict, r2.fault.kind], ["stopped", "exception"]);
});

// --- caller misuse is a TypeError (the only throws) ----------------------------------------

test("checkStep throws TypeError ONLY for caller misuse: foreign rubric, unknown checkpoint, bad opts, a judge", async () => {
  await assert.rejects(checkStep({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [] } } }, "cp", "x"), TypeError);
  await assert.rejects(checkStep(null, "cp", "x"), TypeError);
  await assert.rejects(checkStep(rubric, "nope", "x"), /unknown checkpoint "nope"/);
  await assert.rejects(checkStep(rubric, "constructor", "x"), /unknown checkpoint/, "inherited names are not checkpoints");
  await assert.rejects(checkStep(rubric, undefined, "x"), /unknown checkpoint/);
  await assert.rejects(checkStep(rubric, "cp", "x", "opts"), /opts must be an object/);
  await assert.rejects(checkStep(rubric, "cp", "x", null), /opts must be an object/);
  await assert.rejects(checkStep(rubric, "cp", "x", { judge: async () => ({}), deadlineMs: 1000 }), /judge is not available/);
  await assert.rejects(checkStep(rubric, "cp", "x", { get judge() { throw new Error("g"); } }), /judge is not available/);
  // judge: undefined / null are the same as absent
  await assert.doesNotReject(checkStep(rubric, "cp", "x", { judge: undefined }));
  await assert.doesNotReject(checkStep(rubric, "cp", "x", { judge: null }));
});

test("rubric immutability: a created rubric cannot be altered to run a different check", async () => {
  assert.throws(() => { rubric.checkpoints.cp.checks[1].value = 9999; }, TypeError);
  assert.throws(() => { rubric.checkpoints.cp.checks.push({}); }, TypeError);
  assert.throws(() => { rubric.checkpoints.other = {}; }, TypeError);
  const r = await go("one two three four five six");
  assert.equal(r.gaps.find((g) => g.check === "maxWords").limit, 5);
});

test("stability: the same input always mints a deep-equal verdict (deterministic, no hidden state)", async () => {
  const out = "## A\nx y z";
  const a = await go(out);
  const b = await go(out);
  assert.deepEqual(a, b);
  assert.equal(renderGaps(a.gaps), renderGaps(b.gaps));
});
