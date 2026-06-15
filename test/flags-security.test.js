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

test("flags: an inherited value-map entry cannot fire a flag (own-key config lookup)", () => {
  // Scope: this guards the VALUE-MAP lookup — the place a flag indexes by an
  // attacker-controlled key (the action's field value). Even if Object.prototype
  // is polluted with a value equal to an outcome string, an EMPTY/unconfigured
  // value-map stays inert because the lookup honors the operator's OWN keys only.
  // (The action-object read itself shares the whole gate's direct-property-access
  // trust — a polluted action object is a gate-wide concern, not flags-specific,
  // and is fail-safe here: flags can only restrict, never grant.)
  Object.prototype.web = "ask"; // simulate app-wide prototype pollution
  try {
    const r = flagsAskCheck({ type: "memory.write", provenance: "web" }, { provenance: {} });
    assert.equal(r, null, "an inherited Object.prototype.web must not leak into the value-map lookup");
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

// ---------------------------------------------------------------------------
// flags — blanket "always ask on a tool TYPE" contract. An adopter wanting
// "confirm before every exec/bash" gates the always-present `type` field:
// `flags: { type: { bash: "ask" } }`. This is the consolidation path away from
// a separate per-tool confirmation channel — one humanChannel owns the ask.
// Pins the acceptance: fires for EVERY such action (even allowlisted), routes
// kind:"ask" with action + _ctx intact, deny blocks / allow proceeds.
// ---------------------------------------------------------------------------

test("flags: type-keyed ask fires on every action of that type, even allowlisted", async () => {
  const seen = [];
  const gate = new Gate({
    audit: { path: null },
    bash: { allow: ["ls", "echo"] },        // bash IS allowlisted...
    flags: { type: { bash: "ask" } },        // ...and STILL asks (4b before allowlist 5)
    humanChannel: async (event) => { seen.push(event); return { decision: "allow" }; },
  });
  await gate.init();

  const d = await gate.check({ type: "bash", args: { command: "ls" }, _ctx: { chatId: "chat1" } });

  assert.equal(seen.length, 1, "humanChannel consulted for the allowlisted bash action");
  assert.equal(seen[0].kind, "ask", "routed as an ask, not a halt");
  assert.equal(seen[0].rule, "flags.type");
  assert.equal(seen[0].action.type, "bash");
  assert.deepEqual(seen[0].action._ctx, { chatId: "chat1" }, "_ctx routing context preserved on the event");
  assert.equal(d.outcome, "allow", "allow reply lets the action proceed");
});

test("flags: type-keyed ask — deny reply blocks; non-configured type does not fire", async () => {
  const seen = [];
  const gate = new Gate({
    audit: { path: null },
    flags: { type: { bash: "ask" } },
    humanChannel: async (event) => { seen.push(event); return { decision: "deny" }; },
  });
  await gate.init();

  const denied = await gate.check({ type: "bash", args: { command: "echo hi" } });
  assert.equal(denied.outcome, "deny", "deny reply blocks the action");

  const other = await gate.check({ type: "read", args: { path: "/tmp/x" } });
  assert.equal(other.outcome, "allow", "an unconfigured type is a no-op — flag never fires");
  assert.equal(seen.length, 1, "humanChannel consulted only for the configured type");
});
