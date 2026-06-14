import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { flagsDenyCheck, flagsAskCheck } from "../src/primitives/flags.js";

// ---------------------------------------------------------------------------
// flags — security invariants (grounded by a /security pass, 2026-06-14, then
// promoted here so they're regression-guarded, not just asserted in a report).
// ---------------------------------------------------------------------------

test("flags: NO GRANT — never returns outcome:allow (can only restrict)", () => {
  const cfgs = [
    { provenance: { web: "ask", agent: "deny" } },
    { injectionRisk: { high: "deny", medium: "ask", low: "ask" } },
    undefined, {}, { f: {} }, { f: null },
  ];
  const vals = ["web", "agent", "high", "medium", "low", "x", "allow", "", 0, 1, true, false];
  let sawFire = false;
  for (const cfg of cfgs) for (const field of ["provenance", "injectionRisk", "f"]) for (const v of vals) {
    for (const fn of [flagsDenyCheck, flagsAskCheck]) {
      const r = fn({ type: "memory.write", [field]: v }, cfg);
      if (r) {
        assert.ok(r.outcome === "deny" || r.outcome === "askHuman",
          `flags must only deny/ask, got ${JSON.stringify(r)}`);
        sawFire = true;
      }
    }
  }
  assert.ok(sawFire, "positive control: a configured value must actually fire (else the test proves nothing)");
});

test("flags: prototype-key field VALUES don't spuriously fire", () => {
  const cfg = { provenance: { web: "ask" }, injectionRisk: { high: "deny" } };
  for (const k of ["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
    const action = { type: "memory.write", provenance: k, injectionRisk: k };
    assert.equal(flagsDenyCheck(action, cfg), null, `deny must not fire on field value ${k}`);
    assert.equal(flagsAskCheck(action, cfg), null, `ask must not fire on field value ${k}`);
  }
});

test("flags: a polluted Object.prototype cannot make a flag fire (own-key lookup)", () => {
  // Defense-in-depth: even if the runtime's Object.prototype is polluted with a
  // value equal to an outcome string, an EMPTY/unconfigured value-map must stay
  // inert — the lookup honors only the operator's OWN keys.
  Object.prototype.web = "ask"; // simulate app-wide prototype pollution
  try {
    const r = flagsAskCheck({ type: "memory.write", provenance: "web" }, { provenance: {} });
    assert.equal(r, null, "inherited Object.prototype.web must not leak into the gate");
  } finally {
    delete Object.prototype.web;
  }
});

test("flags: own-key lookup still honors a legitimately configured value (no over-correction)", () => {
  // The hasOwn guard must not break the real path: a configured value still fires.
  const cfg = { provenance: { web: "ask" }, injectionRisk: { high: "deny" } };
  assert.equal(flagsAskCheck({ type: "memory.write", provenance: "web" }, cfg).rule, "flags.provenance");
  assert.equal(flagsDenyCheck({ type: "memory.write", injectionRisk: "high" }, cfg).rule, "flags.injectionRisk");
});

test("flags: floor supremacy through the real Gate — flagged inject denied despite allowlist", async () => {
  // End-to-end: the no-grant + before-allowlist properties compose in the Gate.
  const gate = new Gate({
    audit: { path: null },
    tools: { allowlist: ["memory.write"] },
    flags: { injectionRisk: { high: "deny" } },
    humanChannel: async () => ({ decision: "allow" }), // must never be consulted
  });
  await gate.init();
  const d = await gate.check({ type: "memory.write", injectionRisk: "high", text: "x" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "flags.injectionRisk");
});
