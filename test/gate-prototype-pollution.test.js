import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

// ---------------------------------------------------------------------------
// Prototype-pollution hardening (grounded by a /security pass, 2026-06-14).
//
// Every eval step reads `action.<field>` / `action.args.<field>` directly, so a
// polluted Object.prototype could inject a field the action never declared and
// flip a decision — incl. deny→ALLOW on the allowlist. The gate normalizes each
// action to own-properties-only (null-proto) at entry (`safeAction`), so these
// tests assert the SECURE behavior holds even under pollution. If the normalize
// regresses, the grant test below flips to allow and fails — the guard can fail.
// ---------------------------------------------------------------------------

const CFG = () => ({
  audit: { path: null },
  tools: { allowlist: ["bash", "fetch", "read", "memory.write"] },
  bash: { denyPatterns: [/rm\s+-rf/] },
  fs: { readScope: ["/tmp"] },
  net: { allowDomains: ["safe.com"] },
  flags: { provenance: { web: "ask" } },
  content: { denyPatterns: [] },
  humanChannel: async () => ({ decision: "deny" }),
});

async function withPollution(keys, fn) {
  for (const [k, v] of Object.entries(keys)) Object.prototype[k] = v;
  try { return await fn(); } finally { for (const k of Object.keys(keys)) delete Object.prototype[k]; }
}

test("pollution: a type-less action is NOT granted via inherited type (deny→allow blocked)", async () => {
  // The grant case: Object.prototype.type='bash' on an action with no own type.
  // Without the fix this returns allow/tools.allowlist — a privilege escalation.
  const gate = new Gate(CFG()); await gate.init();
  const d = await withPollution({ type: "bash" }, () => gate.check({ args: {} }));
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "tools.allowlist.exclusive");
});

test("pollution: an inherited cmd/path/url cannot inject a denied action (flat + nested)", async () => {
  const gate = new Gate(CFG()); await gate.init();
  // baseline (no own field) for each is allow via the allowlist; pollution must not change it.
  const flat = await withPollution({ cmd: "rm -rf /tmp", path: "/etc/passwd", url: "http://evil.com/x" }, async () => [
    await gate.check({ type: "bash" }),
    await gate.check({ type: "read" }),
    await gate.check({ type: "fetch" }),
  ]);
  for (const d of flat) assert.equal(d.outcome, "allow", `${d.rule} should stay allow under pollution`);

  // nested: bash reads action.args.cmd; a polluted Object.prototype.cmd must not
  // leak in when args lacks its own cmd.
  const nested = await withPollution({ cmd: "rm -rf /tmp" }, () => gate.check({ type: "bash", args: {} }));
  assert.equal(nested.outcome, "allow");
});

test("pollution: an inherited flags field cannot fire a flag", async () => {
  const gate = new Gate(CFG()); await gate.init();
  const d = await withPollution({ provenance: "web" }, () => gate.check({ type: "memory.write", text: "x" }));
  assert.equal(d.outcome, "allow"); // no spurious ask from inherited provenance
  assert.equal(d.rule, "tools.allowlist");
});

test("pollution: run() executes the SAME normalized action it evaluated (no TOCTOU)", async () => {
  const gate = new Gate(CFG()); await gate.init();
  // bash is allowlisted and the action has no own cmd; with Object.prototype.cmd
  // = "rm -rf /tmp" polluted, the gate must decide AND hand the executor an action
  // whose cmd is NOT the inherited one — they must agree.
  let executedCmd = "UNSET";
  const out = await withPollution({ cmd: "rm -rf /tmp" }, () =>
    gate.run({ type: "bash" }, (a) => { executedCmd = a.cmd; return { costUsd: 0 }; }));
  assert.ok(!out?.error, "should not be denied");
  assert.equal(executedCmd, undefined, "executor must NOT see the inherited cmd the gate didn't evaluate");
});

test("pollution: normal own-field actions are unaffected (no over-correction)", async () => {
  const gate = new Gate(CFG()); await gate.init();
  // Real own fields decide exactly as before, polluted or not.
  const d1 = await gate.check({ type: "bash", cmd: "rm -rf /tmp" });
  assert.equal(d1.rule, "bash.denyPatterns"); // own cmd still screened
  const d2 = await withPollution({ cmd: "echo safe" }, () => gate.check({ type: "bash", cmd: "rm -rf /tmp" }));
  assert.equal(d2.rule, "bash.denyPatterns"); // own cmd shadows the inherited one
});
