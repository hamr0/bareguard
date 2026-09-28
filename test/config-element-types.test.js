// Array-element-type validation (0.19.0, item 6 of the fs contract work).
// `assertArrayShapedConfig` (gate.js) already threw at construct time when an
// array-shaped config key was present but not an ARRAY; it said nothing about
// the type of each ELEMENT inside an otherwise-well-shaped array. Ported from
// the throwaway fs-contract-poc's `probe-elements.mjs` baseline findings
// (CONTRACT.md §A): a bad element used to either throw mid-`check()` (killing
// the gate for every later action) or, for `secrets.*`, get silently
// swallowed whole by `redact()`'s never-throw guard.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { redact } from "../src/primitives/secrets.js";
import { toolsAllowlistCheck, toolsDenylistCheck } from "../src/primitives/tools.js";
import { contentDenyCheck, contentAskCheck } from "../src/primitives/content.js";
import { bashCheck } from "../src/primitives/bash.js";

// ---------------------------------------------------------------------------
// Construct time: every table key throws on a bad element
// ---------------------------------------------------------------------------

test("construct time: tools.allowlist with a non-string element throws", () => {
  assert.throws(() => new Gate({ tools: { allowlist: ["ok", 123] } }), /tools\.allowlist\[1\]/);
});

test("construct time: tools.denylist with a non-string element throws", () => {
  assert.throws(() => new Gate({ tools: { denylist: [123] } }), /tools\.denylist\[0\]/);
});

test("construct time: tools.denyArgPatterns.<tool> with a non-RegExp element throws", () => {
  assert.throws(
    () => new Gate({ tools: { denyArgPatterns: { bash: [/ok/, "oops"] } } }),
    /tools\.denyArgPatterns\.bash\[1\]/,
  );
});

test("construct time: content.denyPatterns with a non-RegExp element throws", () => {
  assert.throws(() => new Gate({ content: { denyPatterns: [/ok/, "oops"] } }), /content\.denyPatterns\[1\]/);
});

test("construct time: content.askPatterns with a non-RegExp element throws", () => {
  assert.throws(() => new Gate({ content: { askPatterns: ["oops"] } }), /content\.askPatterns\[0\]/);
});

test("construct time: bash.denyPatterns with a non-RegExp element throws", () => {
  assert.throws(() => new Gate({ bash: { denyPatterns: ["oops"] } }), /bash\.denyPatterns\[0\]/);
});

test("construct time: bash.allow with a non-string element throws", () => {
  assert.throws(() => new Gate({ bash: { allow: [123] } }), /bash\.allow\[0\]/);
});

test("construct time: bash.extraDestructive / extraSuperDestructive with a non-RegExp element throws", () => {
  assert.throws(() => new Gate({ bash: { extraDestructive: ["oops"] } }), /bash\.extraDestructive\[0\]/);
  assert.throws(() => new Gate({ bash: { extraSuperDestructive: ["oops"] } }), /bash\.extraSuperDestructive\[0\]/);
});

test("construct time: net.allowDomains with a non-string element throws", () => {
  assert.throws(() => new Gate({ net: { allowDomains: [123] } }), /net\.allowDomains\[0\]/);
});

test("construct time: axisB.reversible with a non-string element throws", () => {
  assert.throws(() => new Gate({ axisB: { reversible: [123] } }), /axisB\.reversible\[0\]/);
});

test("construct time: secrets.keys / patterns / envVars with a bad element throws (fine, not mid-emit)", () => {
  assert.throws(() => new Gate({ secrets: { keys: [123] } }), /secrets\.keys\[0\]/);
  assert.throws(() => new Gate({ secrets: { patterns: ["oops"] } }), /secrets\.patterns\[0\]/);
  assert.throws(() => new Gate({ secrets: { envVars: [123] } }), /secrets\.envVars\[0\]/);
});

// ---------------------------------------------------------------------------
// Direct primitive calls with raw (unvalidated) config: deny, never throw
// ---------------------------------------------------------------------------

test("direct call: toolsAllowlistCheck with a bad element denies, does not throw", () => {
  assert.doesNotThrow(() => {
    const d = toolsAllowlistCheck({ type: "x" }, { allowlist: [123] });
    assert.equal(d.outcome, "deny");
    assert.equal(d.rule, "tools.allowlist.invalid");
  });
});

test("direct call: toolsDenylistCheck with a bad element denies, does not throw", () => {
  assert.doesNotThrow(() => {
    const d = toolsDenylistCheck({ type: "x" }, { denylist: [123] });
    assert.equal(d.outcome, "deny");
    assert.equal(d.rule, "tools.denylist.invalid");
  });
});

test("direct call: contentDenyCheck with a bad element denies, does not throw", () => {
  assert.doesNotThrow(() => {
    const d = contentDenyCheck({ type: "bash", cmd: "ls" }, { denyPatterns: [/ok/, "oops"] });
    assert.equal(d.outcome, "deny");
    assert.equal(d.rule, "content.denyPatterns.invalid");
  });
});

test("direct call: contentAskCheck with a bad element denies, does not throw", () => {
  assert.doesNotThrow(() => {
    const d = contentAskCheck({ type: "bash", cmd: "ls" }, { askPatterns: ["oops"] });
    assert.equal(d.outcome, "deny");
    assert.equal(d.rule, "content.askPatterns.invalid");
  });
});

test("direct call: bashCheck with a bad denyPatterns element denies, does not throw", () => {
  assert.doesNotThrow(() => {
    const d = bashCheck({ type: "bash", cmd: "ls" }, { denyPatterns: ["oops"] });
    assert.equal(d.outcome, "deny");
    assert.equal(d.rule, "bash.denyPatterns.invalid");
  });
});

// ---------------------------------------------------------------------------
// secrets.redact(): the live 0.18.1 bug — a bad element must skip only
// itself, never disable the rest of the walk / pattern pass.
// ---------------------------------------------------------------------------

test("secrets.redact(): a bad secrets.keys element never throws, and default-key redaction still works", () => {
  assert.doesNotThrow(() => {
    const out = redact({ apiKey: "sk-live-secret-value-0123456789" }, { keys: [123] });
    assert.equal(out.apiKey, "[REDACTED:key=apiKey]", "default key redaction must survive a bad sibling element");
  });
});

test("secrets.redact(): a bad secrets.keys element is skipped, valid sibling elements still match", () => {
  const out = redact({ myCustomSecret: "value", apiKey: "sk-x" }, { keys: [123, "myCustomSecret"] });
  assert.equal(out.myCustomSecret, "[REDACTED:key=myCustomSecret]");
  assert.equal(out.apiKey, "[REDACTED:key=apiKey]");
});

test("secrets.redact(): a bad secrets.patterns element never throws (0.18.1: uncaught SyntaxError)", () => {
  assert.doesNotThrow(() => {
    const out = redact({ note: "sk-live-abcdefghijklmnop" }, { patterns: ["oops"] });
    // default value patterns still catch the sk- shape even with a bad sibling
    assert.match(out.note, /^\[REDACTED:pattern=/);
  });
});

test("secrets.redact(): a bad secrets.patterns element is skipped, valid sibling patterns still match", () => {
  const out = redact({ note: "token=zzz123" }, { patterns: ["oops", /zzz\d+/] });
  assert.match(out.note, /\[REDACTED:pattern=/);
});

test("secrets.redact(): direct call with raw bad config never throws, for every array key", () => {
  assert.doesNotThrow(() => redact({ apiKey: "sk-live-x", note: "y" }, { keys: [null, {}], patterns: [42, []], envVars: [{}] }));
});
