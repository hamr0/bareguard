import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRubric, checkStep } from "../src/index.js";

// ---------------------------------------------------------------------------
// checkStep — caller-measured rules + liveness proof (docs/product/rubric-prd.md §4.3)
// The caller measures; bareguard only compares. Missing or failed proof = STOPPED.
// ---------------------------------------------------------------------------

const run = (check, measurement, opts = {}) =>
  checkStep(
    createRubric({ schema: 1, goal: "g", checkpoints: { cp: { gating: true, checks: [{ id: "m", ...check }] } } }),
    "cp",
    { text: "an output" },
    { ...opts, measurements: { m: measurement } },
  );
const gap = (r) => r.gaps[0];
const stopped = (r, kind) => {
  assert.equal(r.verdict, "stopped");
  assert.equal(r.fault.kind, kind, r.fault.detail);
  assert.deepEqual(r.gaps, [], "stopped gives the worker NO gap");
  assert.equal(r.fault.key, "cp:m");
  assert.deepEqual(r.full.faults, [r.fault]);
};

// --- commandExit -------------------------------------------------------------------

test("commandExit: exit equals expectExit (default 0) is green; otherwise red with exit, expected and bounded output lines", async () => {
  assert.equal((await run({ rule: "commandExit" }, { exit: 0 })).verdict, "green");
  const r = await run({ rule: "commandExit" }, { exit: 1, outputLines: ["boom", "at line 3", 5, ...Array.from({ length: 50 }, (_, i) => `l${i}`)] });
  assert.equal(r.verdict, "red");
  assert.deepEqual([gap(r).kind, gap(r).measured, gap(r).limit], ["exit", 1, 0]);
  assert.equal(gap(r).items.length, 20);
  assert.equal(gap(r).items[0], "boom");
  assert.equal((await run({ rule: "commandExit", expectExit: 2 }, { exit: 2 })).verdict, "green");
  assert.equal((await run({ rule: "commandExit", expectExit: 2 }, { exit: 0 })).verdict, "red");
});

test("commandExit: missing / non-integer exit, or no measurement at all, is STOPPED (only the first liveness line applies)", async () => {
  for (const m of [{}, { exit: "0" }, { exit: null }, { exit: NaN }, { exit: 0.5 }, null, undefined, "0"]) {
    stopped(await run({ rule: "commandExit" }, m), "missing-measurement");
  }
  // matchedPreScope is NOT required for commandExit, and a non-zero exit is simply red, not stopped
  assert.equal((await run({ rule: "commandExit" }, { exit: 127 })).verdict, "red");
});

// --- liveness proof (notWorse / patternAbsent / filesChanged) --------------------------

const nw = { rule: "notWorse", direction: "lower-is-better", baseline: 5 };

test("liveness: exit != 0 AND matchedPreScope 0 -> STOPPED ('crashed tool: unknown, not zero')", async () => {
  stopped(await run(nw, { value: 0, exit: 1, matchedPreScope: 0 }), "liveness");
  stopped(await run({ rule: "patternAbsent", patterns: ["p"] }, { exit: 2, matchedPreScope: 0, hits: [] }), "liveness");
  stopped(await run({ rule: "filesChanged", allowPrefixes: ["/tmp"], requireNonEmpty: false }, { exit: 127, matchedPreScope: 0, paths: [] }), "liveness");
});

test("liveness: exit 2 with matchedPreScope 67 and value 0 is GREEN (the tool ran; bareloop mslsnnzk) — NOT stopped", async () => {
  const r = await run(nw, { value: 0, exit: 2, matchedPreScope: 67 });
  assert.equal(r.verdict, "green");
  assert.equal(r.fault, null);
  assert.equal((await run({ rule: "patternAbsent", patterns: ["p"] }, { exit: 1, matchedPreScope: 67, hits: [] })).verdict, "green");
});

test("liveness is read BEFORE any scope filter: scope-filtered-to-zero but non-zero pre-scope count is live", async () => {
  const r = await run({ rule: "patternAbsent", patterns: ["p"] }, { exit: 1, matchedPreScope: 3, hits: [] });
  assert.equal(r.verdict, "green", "3 matches existed before the scope filter removed them");
});

test("liveness: exit 0 with zero matches is a live zero (the clean case)", async () => {
  assert.equal((await run(nw, { value: 0, exit: 0, matchedPreScope: 0 })).verdict, "green");
});

test("noneExit: exit == noneExit with zero matches is a live zero; any other non-zero exit with zero matches is still stopped; no softened default", async () => {
  const withNone = { rule: "patternAbsent", patterns: ["p"], noneExit: 1 };
  assert.equal((await run(withNone, { exit: 1, matchedPreScope: 0, hits: [] })).verdict, "green", "grep-style: exit 1 = none found");
  stopped(await run(withNone, { exit: 2, matchedPreScope: 0, hits: [] }), "liveness");
  stopped(await run({ rule: "patternAbsent", patterns: ["p"] }, { exit: 1, matchedPreScope: 0, hits: [] }), "liveness");
  assert.equal((await run({ ...nw, noneExit: 1 }, { value: 0, exit: 1, matchedPreScope: 0 })).verdict, "green");
});

test("liveness: missing or malformed proof is STOPPED (no measurement, no exit, no matchedPreScope, wrong types)", async () => {
  for (const m of [undefined, null, {}, { value: 0 }, { value: 0, exit: 0 }, { value: 0, matchedPreScope: 3 },
    { value: 0, exit: "0", matchedPreScope: 3 }, { value: 0, exit: 0, matchedPreScope: -1 }, { value: 0, exit: 0, matchedPreScope: 1.5 },
    { value: 0, exit: 0, matchedPreScope: "3" }, { value: 0, exit: NaN, matchedPreScope: 3 }]) {
    stopped(await run(nw, m), "missing-measurement");
  }
  stopped(await run({ rule: "patternAbsent", patterns: ["p"] }, { exit: 0, hits: [] }), "missing-measurement");
  stopped(await run({ rule: "filesChanged", allowPrefixes: ["/tmp"], requireNonEmpty: false }, { exit: 0, paths: [] }), "missing-measurement");
});

test("a measurement that is an inherited / prototype value is not read (own keys only)", async () => {
  const m = Object.create({ exit: 0, matchedPreScope: 5, value: 0 });
  stopped(await run(nw, m), "missing-measurement");
});

// --- notWorse -------------------------------------------------------------------------

test("notWorse lower-is-better: value <= baseline is green (equal = green), above is red with direction", async () => {
  const f = (value) => run({ ...nw, baseline: 5 }, { value, exit: 0, matchedPreScope: 5 });
  assert.equal((await f(4)).verdict, "green");
  assert.equal((await f(5)).verdict, "green", "equal = green");
  const r = await f(6);
  assert.equal(r.verdict, "red");
  assert.deepEqual([gap(r).kind, gap(r).measured, gap(r).limit, gap(r).direction], ["worse", 6, 5, "lower-is-better"]);
});

test("notWorse higher-is-better: value >= baseline is green (equal = green), below is red with its signed direction", async () => {
  const hb = { rule: "notWorse", direction: "higher-is-better", baseline: 5 };
  const f = (value) => run(hb, { value, exit: 0, matchedPreScope: 5 });
  assert.equal((await f(6)).verdict, "green");
  assert.equal((await f(5)).verdict, "green", "equal = green");
  const r = await f(4);
  assert.equal(r.verdict, "red");
  assert.deepEqual([gap(r).measured, gap(r).limit, gap(r).direction], [4, 5, "higher-is-better"]);
});

test("notWorse: value must be a finite number or the measurement is malformed (STOPPED, never a silent zero)", async () => {
  for (const value of [undefined, NaN, Infinity, "3", null]) stopped(await run(nw, { value, exit: 0, matchedPreScope: 5 }), "missing-measurement");
});

test("notWorse literal baseline 0 works as an alternative to patternAbsent", async () => {
  const z = { rule: "notWorse", direction: "lower-is-better", baseline: 0 };
  assert.equal((await run(z, { value: 0, exit: 0, matchedPreScope: 9 })).verdict, "green");
  assert.equal((await run(z, { value: 1, exit: 0, matchedPreScope: 9 })).verdict, "red");
});

test("notWorse: a baseline passed per call when the spec's baseline is a literal is refused (STOPPED baseline-conflict)", async () => {
  stopped(await run(nw, { value: 1, exit: 0, matchedPreScope: 5, baseline: 99 }), "baseline-conflict");
});

test("notWorse seed: the runner passes baseline + baselineSource {anchor, route}; it is returned for the gate to record", async () => {
  const seed = { rule: "notWorse", direction: "lower-is-better", baseline: "seed" };
  const m = { value: 3, exit: 0, matchedPreScope: 4, baseline: 3, baselineSource: { anchor: "abc123", route: "git-stash-count" } };
  const r = await run(seed, m);
  assert.equal(r.verdict, "green");
  assert.deepEqual(r.baselines, { m: { baseline: 3, baselineSource: { anchor: "abc123", route: "git-stash-count" } } });
  const worse = await run(seed, { ...m, value: 4 });
  assert.deepEqual([worse.verdict, gap(worse).limit], ["red", 3], "compared against the seed baseline");
  assert.equal(worse.baselines.m.baseline, 3, "a red run still reports the baseline it used");
});

test("notWorse seed: missing baseline / baselineSource (or blank anchor/route) is STOPPED", async () => {
  const seed = { rule: "notWorse", direction: "lower-is-better", baseline: "seed" };
  const base = { value: 3, exit: 0, matchedPreScope: 4 };
  const src = { anchor: "a", route: "r" };
  for (const m of [base, { ...base, baseline: 3 }, { ...base, baselineSource: src }, { ...base, baseline: "3", baselineSource: src },
    { ...base, baseline: 3, baselineSource: { anchor: "", route: "r" } }, { ...base, baseline: 3, baselineSource: { anchor: "a", route: " " } },
    { ...base, baseline: 3, baselineSource: "anchor" }]) {
    stopped(await run(seed, m), "missing-measurement");
  }
});

test("notWorse seed: a baseline different from the one already recorded for this run is STOPPED baseline-conflict (tamper); the same is fine", async () => {
  const seed = { rule: "notWorse", direction: "lower-is-better", baseline: "seed" };
  const m = { value: 3, exit: 0, matchedPreScope: 4, baseline: 3, baselineSource: { anchor: "a", route: "r" } };
  assert.equal((await run(seed, m, { priorBaselines: { m: 3 } })).verdict, "green");
  stopped(await run(seed, { ...m, baseline: 10 }, { priorBaselines: { m: 3 } }), "baseline-conflict");
  assert.equal((await run(seed, { ...m, baseline: 10 }, { priorBaselines: { other: 3 } })).verdict, "green", "another check's record is unrelated");
});

test("notWorse: the optional per-term breakdown rides the red gap (signed term ids only, bounded)", async () => {
  const withTerms = { ...nw, terms: ["lint", "types"] };
  const r = await run(withTerms, { value: 9, exit: 0, matchedPreScope: 9, terms: [{ id: "lint", contributes: 4 }, { id: "types", contributes: 5 }, { id: "rogue", contributes: 1 }, { id: "lint", contributes: "x" }] });
  assert.deepEqual(gap(r).items, ["lint=4", "types=5"]);
  assert.equal(gap(await run(nw, { value: 9, exit: 0, matchedPreScope: 9, terms: [{ id: "lint", contributes: 4 }] })).items, undefined);
});

// --- patternAbsent ----------------------------------------------------------------------

const pa = { rule: "patternAbsent", patterns: ["no-todo", "no-console"] };

test("patternAbsent: zero hits green; >=1 hit red with a bounded hit list (ids and locations, not the matched text)", async () => {
  assert.equal((await run(pa, { exit: 0, matchedPreScope: 10, hits: [] })).verdict, "green");
  const hits = Array.from({ length: 30 }, (_, i) => ({ id: i % 2 ? "no-todo" : "no-console", path: `src/f${i}.js`, line: i + 1, text: "SECRET-LINE-TEXT".repeat(100) }));
  const r = await run(pa, { exit: 0, matchedPreScope: 30, hits });
  assert.equal(r.verdict, "red");
  assert.deepEqual([gap(r).kind, gap(r).measured, gap(r).limit, gap(r).itemsTotal], ["present", 30, 0, 30]);
  assert.equal(gap(r).items.length, 20);
  assert.equal(gap(r).items[0], "no-console@src/f0.js:1");
  assert.ok(!JSON.stringify(r).includes("SECRET-LINE-TEXT"), "matched text never rides the gap");
});

test("patternAbsent: a hit whose id is not in the signed list is STOPPED (unknown-pattern), even alongside valid hits", async () => {
  stopped(await run(pa, { exit: 0, matchedPreScope: 3, hits: [{ id: "unsigned", path: "a", line: 1 }] }), "unknown-pattern");
  stopped(await run(pa, { exit: 0, matchedPreScope: 3, hits: [{ id: "no-todo", path: "a", line: 1 }, { id: "unsigned", path: "b", line: 2 }] }), "unknown-pattern");
  stopped(await run(pa, { exit: 0, matchedPreScope: 3, hits: [{ path: "a", line: 1 }] }), "unknown-pattern");
  stopped(await run(pa, { exit: 0, matchedPreScope: 3, hits: ["no-todo"] }), "unknown-pattern");
  stopped(await run(pa, { exit: 0, matchedPreScope: 3, hits: [{ id: "constructor", path: "a", line: 1 }] }), "unknown-pattern");
});

test("patternAbsent: hits missing or not an array is STOPPED (an absent list is not an empty list)", async () => {
  for (const hits of [undefined, null, "none", {}]) stopped(await run(pa, { exit: 0, matchedPreScope: 3, hits }), "missing-measurement");
});

// --- filesChanged -----------------------------------------------------------------------

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rubric-fc-")));
const inside = path.join(root, "inside");
const outside = path.join(root, "outside");
fs.mkdirSync(path.join(inside, "sub"), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(inside, "a.txt"), "a");
fs.writeFileSync(path.join(inside, "sub", "b.txt"), "b");
fs.writeFileSync(path.join(outside, "secret.txt"), "s");
// Windows without admin/Developer Mode cannot create symlinks (EPERM): only the symlink-dependent tests skip.
let symlinkSkip = null;
try {
  fs.symlinkSync(outside, path.join(inside, "escape"));                 // inside/escape -> outside
  fs.symlinkSync(path.join(inside, "sub"), path.join(inside, "alias")); // inside/alias  -> inside/sub (stays inside)
  fs.symlinkSync(path.join(root, "nowhere"), path.join(inside, "dangling"));
  fs.symlinkSync(inside, path.join(root, "link-to-inside"));            // a symlinked PREFIX
} catch (e) {
  symlinkSkip = `symlink creation unsupported (${e.code || e.message})`;
}
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const fc = (paths, over = {}, exit = 0, pre = 5) =>
  run({ rule: "filesChanged", allowPrefixes: [inside], requireNonEmpty: true, ...over }, { exit, matchedPreScope: pre, paths });

test("filesChanged: every path under an allowed prefix is green (prefix itself, nested, not-yet-existing files)", async () => {
  assert.equal((await fc([path.join(inside, "a.txt"), path.join(inside, "sub", "b.txt")])).verdict, "green");
  assert.equal((await fc([path.join(inside, "new", "deep", "created.txt")])).verdict, "green", "a not-yet-created file inside the prefix");
  assert.equal((await fc([inside])).verdict, "green");
});

test("filesChanged: a path OUTSIDE the prefixes is red and named; a sibling with the same leading characters is outside", async () => {
  const r = await fc([path.join(inside, "a.txt"), path.join(outside, "secret.txt"), inside + "-evil/x"]);
  assert.equal(r.verdict, "red");
  assert.deepEqual([gap(r).kind, gap(r).items, gap(r).measured, gap(r).limit], ["outside-prefixes", [path.join(outside, "secret.txt"), inside + "-evil/x"], 2, 3]);
  assert.equal((await fc([path.join(inside, "..", "outside", "secret.txt")])).verdict, "red", "dot-dot is normalized");
});

test("filesChanged: empty paths + requireNonEmpty is red 'empty'; empty without requireNonEmpty is green", async () => {
  const e = await fc([]);
  assert.deepEqual([e.verdict, gap(e).kind], ["red", "empty"]);
  assert.equal((await fc([], { requireNonEmpty: false })).verdict, "green");
});

test("filesChanged: a symlink spelled INSIDE the prefix but resolving OUTSIDE is red (physical resolution)", async (t) => {
  if (symlinkSkip) return t.skip(symlinkSkip);
  const r = await fc([path.join(inside, "escape", "secret.txt")]);
  assert.equal(r.verdict, "red");
  assert.deepEqual(gap(r).items, [path.join(inside, "escape", "secret.txt")]);
  assert.equal((await fc([path.join(inside, "escape", "not-yet.txt")])).verdict, "red", "a new file under an escaping symlink");
});

test("filesChanged: a symlink that stays inside resolves green; a dangling symlink is red", async (t) => {
  if (symlinkSkip) return t.skip(symlinkSkip);
  assert.equal((await fc([path.join(inside, "alias", "b.txt")])).verdict, "green");
  assert.equal((await fc([path.join(inside, "dangling")])).verdict, "red");
});

test("filesChanged: unsafe path spellings are red", async () => {
  for (const bad of ["relative/path.txt", "./a.txt", "", "~/x", 5, null, { path: "x" }]) {
    assert.equal((await fc([bad])).verdict, "red", JSON.stringify(bad));
  }
});

test("filesChanged: a prefix that is, or sits under, a symlink would move the scope: STOPPED (instrument), never a silent widen", async (t) => {
  if (symlinkSkip) return t.skip(symlinkSkip);
  stopped(await fc([path.join(inside, "a.txt")], { allowPrefixes: [path.join(root, "link-to-inside")] }), "exception");
  assert.equal((await fc([path.join(inside, "a.txt")], { allowPrefixes: [path.join(outside), inside] })).verdict, "green", "any one of several prefixes");
});

test("filesChanged: paths missing or not an array is STOPPED; liveness applies", async () => {
  for (const paths of [undefined, null, "a", {}]) stopped(await fc(paths), "missing-measurement");
  stopped(await fc([], {}, 1, 0), "liveness");
  assert.equal((await fc([], { requireNonEmpty: false, noneExit: 1 }, 1, 0)).verdict, "green");
});

// --- verdict precedence + multiple checks ------------------------------------------------

test("a stopped check outranks a red one: verdict stopped, NO worker gap, but the red is kept in the full view", async () => {
  const rub = createRubric({
    schema: 1, goal: "g",
    checkpoints: { cp: { gating: true, checks: [
      { id: "w", rule: "maxWords", field: "text", value: 1 },
      { id: "m", rule: "commandExit" },
    ] } },
  });
  const r = await checkStep(rub, "cp", "two words", { measurements: {} });
  assert.equal(r.verdict, "stopped");
  assert.deepEqual(r.gaps, []);
  assert.equal(r.fault.kind, "missing-measurement");
  assert.deepEqual(r.full.gaps.map((g) => g.key), ["cp:w"]);
  assert.deepEqual(r.full.faults.map((f) => f.key), ["cp:m"]);
});
