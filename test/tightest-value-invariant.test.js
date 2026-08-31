// The invariant behind the empty-allowlist fix, generalized and pinned.
//
// "Tighter config never permits more" only holds if the TIGHTEST value a config
// key can express is not conflated with "key not configured". `tools.allowlist`
// broke it: `[]` — the bottom of the subset lattice — was folded into
// "unconfigured" and fell through to default allow, so the smallest set you can
// write produced the largest permitted set.
//
// Two families, opposite bottoms:
//   ALLOW-scopes  `[]` means "permit nothing"  -> must DENY
//   DENY-lists    `[]` means "forbid nothing"  -> must ALLOW (same as absent, correctly)
//   numeric caps  `0`  means "spend nothing"   -> must halt, never "no cap"
//   additive     `[]` extends by nothing; a shipped default CANNOT be disabled by
//                 an empty collection (`secrets.keys`, `classify.extra*`). Opting
//                 out is a separate explicit flag (`secrets.redactKeys: false`).
//   `content`     `[]` is LOOSER than absent, DELIBERATELY (PRD §11: the
//                 documented pure-allow opt-out from the shipped safe defaults).
//                 It is the one key where `[]` and absent must NOT agree, so it
//                 gets its own test rather than being filed under deny-lists.
//
// This file exists so a future scope-shaped config key cannot reintroduce the
// class without turning something red.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

// A biting cap RAISES a halt event through humanChannel; whatever the human then
// answers becomes the final rule. So the proof that the cap fired is the EVENT,
// not the outcome — record it. (gate.js accepts only allow/deny/topup/terminate;
// "approve" lands in the unknown-decision branch and denies, which would let this
// test pass while proving nothing.)
function recordingChannel(seen) {
  return async (event) => { seen.push(event); return { decision: "deny" }; };
}

test("allow-scopes: an empty scope permits nothing (never falls through to default)", async () => {
  const cases = [
    ["tools.allowlist",  { tools: { allowlist: [] } },  { type: "wireMoney", amount: 1 }],
    ["net.allowDomains", { net: { allowDomains: [] } }, { type: "fetch", url: "https://example.com/" }],
    ["fs.readScope",     { fs: { readScope: [] } },     { type: "read", path: "/etc/passwd" }],
    ["fs.writeScope",    { fs: { writeScope: [] } },    { type: "write", path: "/etc/x", content: "y" }],
    ["bash.allow",       { bash: { allow: [] } },       { type: "bash", cmd: "ls" }],
  ];
  for (const [key, cfg, action] of cases) {
    const d = await new Gate(cfg).check(action);
    assert.equal(d.outcome, "deny", `${key}: [] must deny, got ${d.outcome} (rule ${d.rule})`);
  }

  // Pre-flight: each case must be able to FAIL. A populated scope admitting the
  // same action proves the deny above came from the empty scope and not from a
  // mis-shaped probe action the primitive never reads.
  const populated = [
    ["tools.allowlist",  { tools: { allowlist: ["wireMoney"] } },        { type: "wireMoney", amount: 1 }],
    ["net.allowDomains", { net: { allowDomains: ["example.com"] } },     { type: "fetch", url: "https://example.com/" }],
    ["fs.readScope",     { fs: { readScope: ["/etc"] } },                { type: "read", path: "/etc/passwd" }],
    ["fs.writeScope",    { fs: { writeScope: ["/etc"] } },               { type: "write", path: "/etc/x", content: "y" }],
    ["bash.allow",       { bash: { allow: ["ls"] } },                    { type: "bash", cmd: "ls" }],
  ];
  for (const [key, cfg, action] of populated) {
    const d = await new Gate(cfg).check(action);
    assert.equal(d.outcome, "allow",
      `${key}: control must ALLOW under a populated scope, got ${d.outcome} (rule ${d.rule}) — ` +
      `if this denies, the empty-scope assertion above is passing for the wrong reason`);
  }
});

test("deny-lists: an empty list forbids nothing — same as absent, which is correct here", async () => {
  const cases = [
    ["tools.denylist",       { tools: { denylist: [] } }],
    ["tools.denyArgPatterns",{ tools: { denyArgPatterns: {} } }],
    ["fs.deny",              { fs: { deny: [] } }],
  ];
  for (const [key, cfg] of cases) {
    const d = await new Gate(cfg).check({ type: "harmless" });
    assert.equal(d.outcome, "allow", `${key}: [] must not deny, got ${d.outcome}`);
  }
});

test("numeric caps: a cap of 0 is a real cap, not 'no cap'", async () => {
  const cases = [
    ["budget.maxCostUsd",    { budget: { maxCostUsd: 0 } }],
    ["budget.maxTokens",     { budget: { maxTokens: 0 } }],
    ["budget.resources",     { budget: { resources: { writes: 0 } } }],
    ["limits.maxToolRounds", { limits: { maxToolRounds: 0 } }],
    ["limits.maxTurns",      { limits: { maxTurns: 0 } }],
  ];
  for (const [key, cfg] of cases) {
    const seen = [];
    await new Gate({ ...cfg, humanChannel: recordingChannel(seen) }).check({ type: "anything" });
    assert.equal(seen.length, 1, `${key}: a cap of 0 must raise exactly one event, saw ${seen.length}`);
    assert.match(seen[0].rule ?? "", /^(budget|limits)\./,
      `${key}: the event must name the cap's own rule, got ${seen[0].rule}`);
  }

  // control: with no caps configured, nothing is raised at all — this is what
  // makes the assertions above able to fail rather than firing on everything.
  const none = [];
  const ctrl = await new Gate({ humanChannel: recordingChannel(none) }).check({ type: "anything" });
  assert.equal(ctrl.outcome, "allow", "an absent cap must remain unconfigured");
  assert.equal(none.length, 0, "an absent cap must raise no event");
});

test("tools.allowlist is monotone: narrowing the scope never widens the permitted set", async () => {
  const UNIVERSE = ["search", "read", "fetch", "bookFlight", "wireMoney"];
  const chain = [UNIVERSE, ["search", "read", "fetch"], ["search"], []];

  const permitted = async (allowlist) => {
    const gate = new Gate({ tools: { allowlist } });
    const out = [];
    for (const type of UNIVERSE) {
      if ((await gate.check({ type })).outcome === "allow") out.push(type);
    }
    return out;
  };

  let prev = null;
  for (const allowlist of chain) {
    const now = await permitted(allowlist);
    if (prev) {
      assert.ok(now.length <= prev.length,
        `narrowing to [${allowlist}] grew the permitted set: ${prev.length} -> ${now.length}`);
      assert.ok(now.every((t) => prev.includes(t)),
        `narrowing to [${allowlist}] admitted a type the wider scope denied`);
    }
    prev = now;
  }
  assert.deepEqual(prev, [], "the bottom of the lattice must permit nothing");
});


test("content: `[]` is the documented opt-out and is LOOSER than absent — the one key where they differ", async () => {
  const action = { type: "bash", cmd: "echo DROP TABLE users" };

  // absent: the shipped safe defaults apply (PRD §11)
  const dflt = await new Gate({}).check(action);
  assert.equal(dflt.outcome, "deny");
  assert.equal(dflt.rule, "content.denyPatterns");

  // `[]` REPLACES the defaults rather than being read as "not configured":
  // `cfg.denyPatterns ?? SAFE_DEFAULT_DENY_PATTERNS` keeps an empty array,
  // so the deny floor is gone and step 4's ask defaults catch it instead.
  const noDeny = await new Gate({ content: { denyPatterns: [] } }).check(action);
  assert.notEqual(noDeny.rule, "content.denyPatterns", "[] must replace, not be ignored");

  // both emptied = the documented pure-allow override. Deliberate, not a fail-open:
  // the operator wrote "no patterns" and got exactly that.
  const pureAllow = await new Gate({ content: { denyPatterns: [], askPatterns: [] } }).check(action);
  assert.equal(pureAllow.outcome, "allow");
  assert.equal(pureAllow.rule, "default");
});

test("additive-extend defaults: `[]` extends by nothing and cannot disable a shipped default", async () => {
  const { makeRedactor } = await import("../src/primitives/secrets.js");
  const { classifyCommand } = await import("../src/primitives/classify.js");

  // secrets: effective keys = DEFAULT_SECRET_KEYS + cfg.keys. `[]` adds nothing;
  // only the explicit `redactKeys: false` opts out. A silently-disabled redactor
  // would put live credentials in the audit log, so this is the worst possible
  // place for the content-style replace semantics.
  const withSecret = { apiKey: "sk-ABCDEFGHIJKLMNOP" };
  for (const cfg of [undefined, { keys: [] }, { patterns: [] }, { envVars: [] }]) {
    const redact = makeRedactor(cfg);
    assert.ok(redact, `secrets ${JSON.stringify(cfg)}: redactor must still be built`);
    assert.equal(redact(withSecret).apiKey, "[REDACTED:key=apiKey]",
      `secrets ${JSON.stringify(cfg)}: [] must not disable the default-on backstop`);
  }
  // the ONE documented opt-out is explicit, not an empty collection
  assert.equal(makeRedactor({ redactKeys: false }), null);

  // classify: extra* are spread onto the shipped tiers, never substituted for them
  assert.equal(classifyCommand("rm -rf /", {}), "super_destructive");
  assert.equal(classifyCommand("rm -rf /", { extraDestructive: [], extraSuperDestructive: [] }),
    "super_destructive", "extra* [] must extend by nothing, not replace the tiers");
});
