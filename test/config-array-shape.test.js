// Regression tests for /code-review findings #4, #5, #6: array-shaped config
// validation gaps.
//
//   #4 — `assertArrayShapedConfig` (src/gate.js) skipped a whole SECTION that
//     was present but not a plain object (`s == null || typeof s !== "object"`
//     treated a string section the same as an absent one), so
//     `new Gate({ tools: "search", fs: "/etc" })` constructed with no error
//     and then evaluated every action as `rule:"default", outcome:"allow"` —
//     fully fail-OPEN on a config typo.
//   #5 — `ARRAY_SHAPED_CONFIG` was missing `bash.extraDestructive`,
//     `bash.extraSuperDestructive`, and `axisB.reversible`; each is read
//     behind an inline `Array.isArray(x) ? x : []` guard, so a non-array
//     silently discarded the config instead of being rejected at construction.
//   #6 — the runtime fail-closed `Array.isArray` guard (deny with an
//     `<key>.invalid` rule, matching `tools.allowlist`/`denyArgPatterns`) was
//     present on only 2 of the 13 validated keys. `tools.denylist`,
//     `content.denyPatterns`/`askPatterns`, `fs.deny`/`readScope`/`writeScope`,
//     and `net.allowDomains` had none: a caller that mutates `cfg` after
//     construction (`cfg` is held by reference) hits either a silent no-op or
//     an uncaught TypeError mid-`check()`, never a clean deny.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { toolsDenylistCheck, toolsDenyArgsCheck } from "../src/primitives/tools.js";
import { contentDenyCheck, contentAskCheck } from "../src/primitives/content.js";
import { fsCheck } from "../src/primitives/fs.js";
import { netCheck } from "../src/primitives/net.js";
import { bashCheck } from "../src/primitives/bash.js";
import { flagsDenyCheck, flagsAskCheck } from "../src/primitives/flags.js";

test("gate config: a non-object SECTION (not just a non-array leaf) must be rejected at construction", () => {
  assert.throws(() => new Gate({ tools: "search", audit: { path: null } }), /tools must be a plain object/);
  assert.throws(() => new Gate({ fs: "/etc", audit: { path: null } }), /fs must be a plain object/);
});

test("gate config: a malformed tools section must not silently fail open to default-allow", async () => {
  // Before the #4 fix this constructed successfully and both actions came
  // back rule:"default", outcome:"allow" — the exact failure mode reported.
  assert.throws(() => new Gate({ tools: "search", fs: "/etc", audit: { path: null } }));
});

test("gate config: bash.extraDestructive / extraSuperDestructive / axisB.reversible must be validated as array-shaped", () => {
  assert.throws(() => new Gate({ bash: { extraDestructive: "nope" }, audit: { path: null } }), /bash\.extraDestructive must be an array/);
  assert.throws(() => new Gate({ bash: { extraSuperDestructive: "nope" }, audit: { path: null } }), /bash\.extraSuperDestructive must be an array/);
  assert.throws(() => new Gate({ axisB: { reversible: "nope" }, audit: { path: null } }), /axisB\.reversible must be an array/);
});

test("tools.denylist: a non-array must fail closed (deny), not silently no-op", () => {
  const d = toolsDenylistCheck({ type: "bash" }, { denylist: "not-an-array" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "tools.denylist.invalid");
});

test("content.denyPatterns / askPatterns: a non-array must fail closed, not silently replace the safe default floor", () => {
  const d1 = contentDenyCheck({ type: "sql", args: { q: "DROP TABLE users" } }, { denyPatterns: "not-an-array" });
  assert.equal(d1.outcome, "deny");
  assert.equal(d1.rule, "content.denyPatterns.invalid");

  const d2 = contentAskCheck({ type: "sql", args: { q: "delete rows" } }, { askPatterns: "not-an-array" });
  assert.equal(d2.outcome, "deny");
  assert.equal(d2.rule, "content.askPatterns.invalid");
});

test("fs.deny / readScope / writeScope: a non-array must fail closed, not throw or silently no-op", () => {
  const d1 = fsCheck({ type: "read", path: "/x" }, { deny: "not-an-array" });
  assert.equal(d1.outcome, "deny");
  assert.equal(d1.rule, "fs.deny.invalid");

  const d2 = fsCheck({ type: "read", path: "/x" }, { readScope: "not-an-array" });
  assert.equal(d2.outcome, "deny");
  assert.equal(d2.rule, "fs.readScope.invalid");

  const d3 = fsCheck({ type: "write", path: "/x" }, { writeScope: "not-an-array" });
  assert.equal(d3.outcome, "deny");
  assert.equal(d3.rule, "fs.writeScope.invalid");
});

test("net.allowDomains: a non-array must fail closed, not throw", () => {
  const d = netCheck({ type: "fetch", url: "https://example.com" }, { allowDomains: "not-an-array" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "net.allowDomains.invalid");
});

test("bash.denyPatterns / bash.allow: a non-array must fail closed, not throw", () => {
  const d1 = bashCheck({ type: "bash", cmd: "rm -rf /" }, { denyPatterns: "not-an-array" });
  assert.equal(d1.outcome, "deny");
  assert.equal(d1.rule, "bash.denyPatterns.invalid");

  const d2 = bashCheck({ type: "bash", cmd: "ls -la" }, { allow: "not-an-array" });
  assert.equal(d2.outcome, "deny");
  assert.equal(d2.rule, "bash.allow.invalid");
});

// tools.denyArgPatterns is a MAP of arrays, not an array itself — a section-
// shape bug (same class as gate.js's `assertArrayShapedConfig`), not a leaf
// array-shape bug. `cfg` is held by reference, so a caller can swap the whole
// `denyArgPatterns` value out after the constructor validated it; a truthy
// non-object map (string OR array) then reaches `map[action.type]`, which is
// always `undefined` on both — so a CONFIGURED deny silently never fires.
// The load-bearing assertion is that the deny that SHOULD fire actually does,
// not merely "it didn't throw" / "it threw".
test("tools.denyArgPatterns: a malformed MAP must not silently skip a deny that should fire", () => {
  const action = { type: "bash", cmd: "rm -rf /" };
  // Sanity: with a well-formed map, this exact action IS denied.
  const control = toolsDenyArgsCheck(action, { denyArgPatterns: { bash: [/rm -rf/] } });
  assert.equal(control.outcome, "deny");
  assert.equal(control.rule, "tools.denyArgPatterns");

  // A string map used to silently no-op (map["bash"] on a string is undefined).
  const d1 = toolsDenyArgsCheck(action, { denyArgPatterns: "bash" });
  assert.equal(d1?.outcome, "deny", "a string denyArgPatterns must fail closed, not silently skip the deny");
  assert.equal(d1.rule, "tools.denyArgPatterns.invalid");

  // An array map (typeof "object" but not the mapping shape) also no-opped.
  const d2 = toolsDenyArgsCheck(action, { denyArgPatterns: [/rm -rf/] });
  assert.equal(d2?.outcome, "deny", "an array denyArgPatterns must fail closed, not silently skip the deny");
  assert.equal(d2.rule, "tools.denyArgPatterns.invalid");
});

// `flags` is a MAP-shaped config with TWO levels: the top-level map itself
// (`{ <field>: {...} }`) and, nested, each field's value->outcome map
// (`{ <value>: "deny"|"ask" }`). Neither level had a runtime shape guard —
// `cfg` is held by reference and can be swapped post-construction, and
// `flagsDenyCheck`/`flagsAskCheck` are exported and callable directly, same
// exposure as `tools.denyArgPatterns`. `flags` is litectx's gate for poisoned
// memory writes, so a silent no-op here is a fail-open on a real adopter's
// live path. The load-bearing assertion is that a deny/ask that SHOULD fire
// is not silently skipped — for both arms, and for both shape levels — not
// merely "it didn't throw".
test("flags: a malformed top-level config must not silently skip a deny/ask that should fire", () => {
  const action = { type: "x", provenance: "web" };
  const controlDeny = flagsDenyCheck(action, { provenance: { web: "deny" } });
  assert.equal(controlDeny.outcome, "deny");
  assert.equal(controlDeny.rule, "flags.provenance");
  const controlAsk = flagsAskCheck(action, { provenance: { web: "ask" } });
  assert.equal(controlAsk.outcome, "askHuman");
  assert.equal(controlAsk.rule, "flags.provenance");

  for (const badCfg of ["not-an-object", ["not", "a", "map"]]) {
    const d = flagsDenyCheck(action, badCfg);
    assert.equal(d?.outcome, "deny", `flagsDenyCheck must fail closed for ${JSON.stringify(badCfg)}`);
    assert.equal(d.rule, "flags.invalid");

    // The ask arm fails to DENY too (the strictest outcome), same precedent
    // as content.askPatterns.invalid — not askHuman, and not a silent no-op.
    const a = flagsAskCheck(action, badCfg);
    assert.equal(a?.outcome, "deny", `flagsAskCheck must fail closed (deny) for ${JSON.stringify(badCfg)}`);
    assert.equal(a.rule, "flags.invalid");
  }
});

test("flags: a malformed NESTED value-map must not silently skip a deny/ask that should fire", () => {
  const action = { type: "x", provenance: "web" };
  for (const badValueMap of ["deny", ["web"]]) {
    const d = flagsDenyCheck(action, { provenance: badValueMap });
    assert.equal(d?.outcome, "deny", `flagsDenyCheck must fail closed for provenance: ${JSON.stringify(badValueMap)}`);
    assert.equal(d.rule, "flags.invalid");

    const a = flagsAskCheck(action, { provenance: badValueMap });
    assert.equal(a?.outcome, "deny", `flagsAskCheck must fail closed (deny) for provenance: ${JSON.stringify(badValueMap)}`);
    assert.equal(a.rule, "flags.invalid");
  }
});

test("flags: an unrelated field's malformed shape must not deny an action that never touches it", () => {
  const action = { type: "x", other: "y" };
  const d = flagsDenyCheck(action, { provenance: "bad-shape", other: { y: "deny" } });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "flags.other"); // the REAL match, not flags.invalid
});

test("gate config: a malformed flags section must throw loudly at construction, both levels", () => {
  assert.throws(() => new Gate({ flags: "not-an-object", audit: { path: null } }), /flags must be an object/);
  assert.throws(() => new Gate({ flags: ["a"], audit: { path: null } }), /flags must be an object/);
  assert.throws(() => new Gate({ flags: { provenance: "deny" }, audit: { path: null } }), /flags\.provenance must be an object/);
  // Sanity: a well-formed flags config still constructs.
  assert.doesNotThrow(() => new Gate({ flags: { provenance: { web: "deny" } }, audit: { path: null } }));
});

