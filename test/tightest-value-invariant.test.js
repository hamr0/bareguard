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
//
// This file exists so a future scope-shaped config key cannot reintroduce the
// class without turning something red.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

const approve = async () => ({ decision: "approve" });

test("allow-scopes: an empty scope permits nothing (never falls through to default)", async () => {
  const cases = [
    ["tools.allowlist",  { tools: { allowlist: [] } },  { type: "wireMoney", amount: 1 }],
    ["net.allowDomains", { net: { allowDomains: [] } }, { type: "fetch", url: "https://example.com/" }],
    ["fs.readScope",     { fs: { readScope: [] } },     { type: "read", path: "/etc/passwd" }],
    ["fs.writeScope",    { fs: { writeScope: [] } },    { type: "write", path: "/etc/x", content: "y" }],
    ["bash.allow",       { bash: { allow: [] } },       { type: "bash", command: "ls" }],
  ];
  for (const [key, cfg, action] of cases) {
    const d = await new Gate(cfg).check(action);
    assert.equal(d.outcome, "deny", `${key}: [] must deny, got ${d.outcome} (rule ${d.rule})`);
  }
});

test("deny-lists: an empty list forbids nothing — same as absent, which is correct here", async () => {
  const cases = [
    ["tools.denylist",       { tools: { denylist: [] } }],
    ["tools.denyArgPatterns",{ tools: { denyArgPatterns: {} } }],
    ["content.denyPatterns", { content: { denyPatterns: [], askPatterns: [] } }],
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
    // a biting cap routes to humanChannel; assert the cap FIRED, via its rule
    const d = await new Gate({ ...cfg, humanChannel: approve }).check({ type: "anything" });
    const fired = d.outcome === "halt" || /^(budget|limits)\./.test(d.rule ?? "");
    assert.ok(fired, `${key}: 0 must enforce, got ${d.outcome} (rule ${d.rule})`);
  }

  // control: with no caps configured at all, nothing halts
  const ctrl = await new Gate({}).check({ type: "anything" });
  assert.equal(ctrl.outcome, "allow", "an absent cap must remain unconfigured");
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
