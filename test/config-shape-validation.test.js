// Array-shaped config keys were never validated. A non-array produced four
// different wrong behaviors, all silent to the operator:
//   content.denyPatterns: {}   -> the shipped safe-default deny floor is
//                                 REPLACED by something matching nothing, so
//                                 `rm -rf /` went from deny to ALLOW;
//   fs.deny: "/etc"            -> a string iterates per CHARACTER, so the entry
//                                 "/" matched every absolute path and the gate
//                                 denied EVERYTHING;
//   tools.denylist / net.allowDomains / fs.readScope / bash.allow
//                              -> threw `globs.some is not a function` out of
//                                 the gate mid-action;
//   tools.allowlist            -> already fixed, denies at runtime.
//
// Config is operator-authored and read at construct time, so the loud place to
// catch this is the constructor — matching `budget`, which already throws on an
// invalid resource cap or softRatio. The per-action deny stays as
// defence-in-depth because `Gate` holds `this.cfg = config` BY REFERENCE, so a
// caller can mutate the config after construction (verified).

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

test("config: a non-array in any array-shaped key throws at construct time", () => {
  const cases = [
    ["tools.allowlist",      { tools: { allowlist: "search" } }],
    ["tools.denylist",       { tools: { denylist: "wireMoney" } }],
    ["content.denyPatterns", { content: { denyPatterns: {} } }],
    ["content.askPatterns",  { content: { askPatterns: 42 } }],
    ["fs.deny",              { fs: { deny: "/etc" } }],
    ["fs.readScope",         { fs: { readScope: {} } }],
    ["fs.writeScope",        { fs: { writeScope: true } }],
    ["net.allowDomains",     { net: { allowDomains: 42 } }],
    ["bash.allow",           { bash: { allow: true } }],
    ["bash.denyPatterns",    { bash: { denyPatterns: /x/ } }],
    ["secrets.keys",         { secrets: { keys: new Set(["apiKey"]) } }],
    ["secrets.patterns",     { secrets: { patterns: /x/ } }],
    ["secrets.envVars",      { secrets: { envVars: "HOME" } }],
    // FALSY non-arrays specifically: `undefined`/`null` are legal (unconfigured)
    // but `""`/`0`/`false`/`NaN` are not, and a truthiness-based skip would wave
    // exactly these through — the same JS-falsiness hole the runtime guard had.
    ["tools.allowlist",      { tools: { allowlist: "" } }],
    ["tools.denylist",       { tools: { denylist: 0 } }],
    ["fs.deny",              { fs: { deny: false } }],
    ["net.allowDomains",     { net: { allowDomains: NaN } }],
    ["content.denyPatterns", { content: { denyPatterns: "" } }],
  ];
  for (const [key, cfg] of cases) {
    assert.throws(() => new Gate(cfg), new RegExp(key.replace(".", "\\.")),
      `${key}: a non-array must throw at construct time`);
  }
});

test("config: legal shapes still construct — the check must not over-reject", () => {
  const legal = [
    ["empty config",        {}],
    ["sections present, keys absent", { tools: {}, fs: {}, content: {}, net: {}, bash: {}, secrets: {} }],
    ["null means unconfigured",       { tools: { allowlist: null }, fs: { deny: null } }],
    ["[] is a legal array",           { tools: { allowlist: [] }, content: { denyPatterns: [], askPatterns: [] } }],
    ["real arrays", {
      tools: { allowlist: ["a"], denylist: ["b"] },
      fs: { deny: ["/x"], readScope: ["/y"], writeScope: ["/z"] },
      net: { allowDomains: ["z.com"] },
      bash: { allow: ["ls"], denyPatterns: [/rm/] },
      content: { denyPatterns: [/x/], askPatterns: [/y/] },
      secrets: { keys: ["k"], patterns: [/p/], envVars: ["E"] },
    }],
    ["non-array-shaped keys untouched", {
      tools: { denyArgPatterns: { bash: [/x/] } },
      budget: { maxCostUsd: 5 },
      secrets: { redactKeys: false },
      bash: { classify: true },
    }],
  ];
  for (const [label, cfg] of legal) {
    assert.doesNotThrow(() => new Gate(cfg), `${label} must construct`);
  }
});

test("config: the safe-default deny floor cannot be silently replaced by a non-array", () => {
  // the fail-open this closes: `rm -rf /` was ALLOWED under content.denyPatterns:{}
  assert.throws(() => new Gate({ content: { denyPatterns: {} } }), /content\.denyPatterns/);
  // and the correct opt-out is still available and still works
  const optOut = new Gate({ content: { denyPatterns: [], askPatterns: [] } });
  assert.ok(optOut);
});

test("config: the runtime deny still guards post-construction mutation", async () => {
  // `Gate` holds `this.cfg = config` by reference, so the constructor check
  // alone is not sufficient — a caller can mutate the config afterwards.
  const cfg = { tools: { allowlist: ["search"] } };
  const gate = new Gate(cfg);
  assert.equal((await gate.check({ type: "wireMoney" })).rule, "tools.allowlist.exclusive");

  cfg.tools.allowlist = "search"; // mutate to a non-array behind the gate's back
  const d = await gate.check({ type: "wireMoney" });
  assert.equal(d.outcome, "deny", "a mutated-to-non-array allowlist must still deny");
  assert.equal(d.rule, "tools.allowlist.invalid");
});

test("config: tools.denyArgPatterns is a MAP of arrays — its nested values are validated too", () => {
  // The flat [section, key] model missed this: `denyArgPatterns` is the one
  // config surface that is a map of arrays rather than an array. Its top-level
  // value is correctly not in the flat list, but its per-tool values are as
  // array-shaped as any validated key and were entirely unguarded. The most
  // natural authoring mistake — one pattern, forgotten wrapper — threw
  // `patterns is not iterable` out of Gate.check mid-action.
  // FALSY non-arrays included deliberately: a truthiness-based skip would wave
  // exactly these through, and that mutation survived the first version of this
  // test — the same gap already found once on the flat key list.
  for (const bad of [/rm -rf/, "rm -rf", 42, {}, true, new Set([/x/]), "", 0, false, NaN]) {
    assert.throws(() => new Gate({ tools: { denyArgPatterns: { bash: bad } } }),
      /tools\.denyArgPatterns\.bash/,
      `denyArgPatterns.bash = ${String(bad)} must throw at construct time`);
  }
  // the map itself must be a plain object
  assert.throws(() => new Gate({ tools: { denyArgPatterns: [/x/] } }), /tools\.denyArgPatterns/);
  assert.throws(() => new Gate({ tools: { denyArgPatterns: "x" } }), /tools\.denyArgPatterns/);

  // legal shapes still construct
  assert.doesNotThrow(() => new Gate({ tools: { denyArgPatterns: {} } }));
  assert.doesNotThrow(() => new Gate({ tools: { denyArgPatterns: { bash: [/rm/], fetch: [] } } }));
  assert.doesNotThrow(() => new Gate({ tools: { denyArgPatterns: { bash: null } } }));
});

test("config: a denyArgPatterns value mutated to a non-array denies, it does not throw", async () => {
  // same defence-in-depth as tools.allowlist.invalid: cfg is held by reference.
  // A deny rule the gate cannot evaluate must fail CLOSED, not vanish.
  const cfg = { tools: { denyArgPatterns: { bash: [/never-matches/] } } };
  const gate = new Gate(cfg);
  assert.equal((await gate.check({ type: "bash", cmd: "ls" })).outcome, "allow");

  cfg.tools.denyArgPatterns.bash = /rm -rf/; // the forgotten-wrapper mistake
  const d = await gate.check({ type: "bash", cmd: "ls" });
  assert.equal(d.outcome, "deny", "an unevaluatable deny rule must fail closed");
  assert.equal(d.rule, "tools.denyArgPatterns.invalid");
});
