// Full agent-loop simulation. A fake LLM emits a series of actions; bareguard
// evaluates each; some pass, some get asked, some halt. Verify final state
// matches expectation across audit, budget, and counts.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths, makeHumanChannel } from "./_helpers.js";

test("simulated agent loop — mixed allow/ask/deny/halt with humanChannel", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath } = uniquePaths(dir);

  const channel = makeHumanChannel([
    { decision: "allow",  reason: "operator approved" },          // first ask  → allow
    { decision: "deny",   reason: "operator rejected" },          // second ask → deny
    { decision: "topup",  newCap: 10.00, reason: "extend run" },  // halt → topup
  ]);

  const gate = new Gate({
    audit:  { path: auditPath },
    budget: { maxCostUsd: 0.20, sharedFile: budgetPath },
    bash:   { allow: ["git", "ls"] },
    fs:     { writeScope: ["/tmp/agent"], readScope: ["/tmp", "/etc/hostname"], deny: ["/etc/passwd"] },
    tools:  { allowlist: ["bash", "read", "write", "fetch"] },
    secrets:{ envVars: ["FAKE_TOKEN"] },
    humanChannel: channel,
  });
  await gate.init();

  process.env.FAKE_TOKEN = "sk-thisIsAFakeTestSecretValueXY";
  try {
    // 1. Plain allow
    let dec = await gate.check({ type: "bash", cmd: "git status" });
    assert.equal(dec.outcome, "allow");
    await gate.record({ type: "bash", cmd: "git status" }, { costUsd: 0.05, tokens: 100 });

    // 2. fs deny
    dec = await gate.check({ type: "read", path: "/etc/passwd" });
    assert.equal(dec.outcome, "deny");
    assert.equal(dec.rule, "fs.deny");

    // 3. ask → human allows
    dec = await gate.check({ type: "fetch", url: "https://api/delete-account" });
    assert.equal(dec.outcome, "allow");
    assert.equal(dec.rule, "humanChannel.allow");
    await gate.record({ type: "fetch", url: "https://api/delete-account" }, { costUsd: 0.05, tokens: 200 });

    // 4. ask → human denies
    dec = await gate.check({ type: "fetch", url: "https://api/revoke-key" });
    assert.equal(dec.outcome, "deny");
    assert.equal(dec.rule, "content.askPatterns");

    // 5. push spend over cap, then check → halt → topup → re-eval allows
    await gate.record({ type: "bash", cmd: "ls" }, { costUsd: 0.15, tokens: 50 });
    dec = await gate.check({ type: "bash", cmd: "ls /tmp" });
    assert.equal(dec.outcome, "allow", "after topup, action should pass");
    assert.equal(gate.budget.capUsd, 10.00);

    // 6. secrets redaction works on the action before audit
    const dirty = { type: "fetch", url: "https://api/x", headers: { authz: `Bearer ${process.env.FAKE_TOKEN}` } };
    const clean = gate.redact(dirty);
    assert.ok(!JSON.stringify(clean).includes(process.env.FAKE_TOKEN));
    assert.match(JSON.stringify(clean), /\[REDACTED:FAKE_TOKEN\]/);

    // Audit log shape: should contain gate + record + approval + topup + halt phases.
    const lines = await gate.audit.readAll();
    const phases = new Set(lines.map(l => l.phase));
    for (const p of ["gate", "record", "approval", "halt", "topup"]) {
      assert.ok(phases.has(p), `audit must contain phase:${p}`);
    }

    // humanChannel got exactly the 3 events we planned.
    assert.equal(channel.events.length, 3);
    assert.equal(channel.events[0].kind, "ask");
    assert.equal(channel.events[1].kind, "ask");
    assert.equal(channel.events[2].kind, "halt");
  } finally {
    delete process.env.FAKE_TOKEN;
  }
});

test("gate.run executes allowed actions and returns structured error on deny", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const gate = new Gate({
    audit: { path: auditPath },
    tools: { denylist: ["bad"] },
  });
  await gate.init();

  // allowed
  const result = await gate.run({ type: "ok" }, async () => ({ stdout: "hi", costUsd: 0.01, tokens: 5 }));
  assert.equal(result.stdout, "hi");

  // denied → structured error, no executor invocation
  let invoked = false;
  const denial = await gate.run({ type: "bad" }, async () => { invoked = true; return {}; });
  assert.ok(denial.error, "denial should return { error: ... }");
  assert.equal(denial.error.type, "policy_denied");
  assert.equal(denial.error.rule, "tools.denylist");
  assert.equal(invoked, false, "executor must not be called on deny");
});

test("gate.allows is pure (no audit, no budget delta)", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const gate = new Gate({
    audit: { path: auditPath },
    tools: { allowlist: ["bash", "fetch"] },
  });
  await gate.init();

  const { promises: fsp } = await import("node:fs");
  const sizeBefore = (await fsp.readFile(auditPath, "utf8")).length;

  // allow
  assert.equal(await gate.allows({ type: "bash", cmd: "git x" }), true);
  // deny (not in allowlist)
  assert.equal(await gate.allows({ type: "unknown_tool" }), false);
  // ask (returns true so LLM can attempt; human prompted at invoke time)
  assert.equal(await gate.allows({ type: "fetch", url: "https://x/delete-acct" }), true);

  const sizeAfter = (await fsp.readFile(auditPath, "utf8")).length;
  assert.equal(sizeBefore, sizeAfter, "allows() must not write to audit");
});
