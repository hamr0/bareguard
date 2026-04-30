import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths, makeHumanChannel } from "./_helpers.js";

test("budget halt — no humanChannel → deny+halt with structured reason", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath } = uniquePaths(dir);
  const gate = new Gate({
    audit:  { path: auditPath },
    budget: { maxCostUsd: 0.10, sharedFile: budgetPath },
  });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 0.15, tokens: 0 });
  const dec = await gate.check({ type: "x" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.severity, "halt");
  assert.equal(dec.rule, "budget.maxCostUsd");
  assert.match(dec.reason, /no humanChannel registered/);
});

test("budget halt — humanChannel topup raises cap and re-evaluates", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath } = uniquePaths(dir);
  const channel = makeHumanChannel([
    { decision: "topup", newCap: 1.00, reason: "operator approved more budget" },
  ]);
  const gate = new Gate({
    audit:  { path: auditPath },
    budget: { maxCostUsd: 0.10, sharedFile: budgetPath },
    humanChannel: channel,
  });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 0.15, tokens: 0 });
  const dec = await gate.check({ type: "x" });
  assert.equal(dec.outcome, "allow", "after topup, action should pass");
  assert.equal(channel.events.length, 1);
  assert.equal(channel.events[0].kind, "halt");
  assert.equal(channel.events[0].rule, "budget.maxCostUsd");
  assert.equal(gate.budget.capUsd, 1.00, "cap should be raised");
});

test("budget halt — humanChannel terminate → gate becomes sticky-terminated", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath } = uniquePaths(dir);
  const channel = makeHumanChannel([
    { decision: "terminate", reason: "operator stopped run" },
  ]);
  const gate = new Gate({
    audit:  { path: auditPath },
    budget: { maxCostUsd: 0.10, sharedFile: budgetPath },
    humanChannel: channel,
  });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 0.15, tokens: 0 });
  const d1 = await gate.check({ type: "x" });
  assert.equal(d1.outcome, "deny");
  assert.equal(d1.rule, "gate.terminated");
  // every subsequent check denies
  const d2 = await gate.check({ type: "y" });
  assert.equal(d2.outcome, "deny");
  assert.equal(d2.rule, "gate.terminated");
});

test("askPattern hit — humanChannel allow → terminal allow", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const channel = makeHumanChannel([{ decision: "allow", reason: "ok" }]);
  const gate = new Gate({
    audit:  { path: auditPath },
    humanChannel: channel,
  });
  await gate.init();
  const dec = await gate.check({ type: "fetch", url: "https://api/delete-acct" });
  assert.equal(dec.outcome, "allow");
  assert.equal(channel.events.length, 1);
  assert.equal(channel.events[0].kind, "ask");
  assert.equal(channel.events[0].severity, "action");
});

test("askPattern hit — humanChannel deny → terminal deny preserving severity", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const channel = makeHumanChannel([{ decision: "deny" }]);
  const gate = new Gate({
    audit:  { path: auditPath },
    humanChannel: channel,
  });
  await gate.init();
  const dec = await gate.check({ type: "fetch", url: "https://api/delete-acct" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.severity, "action");
  assert.equal(dec.rule, "content.askPatterns");
});

test("halt audit line is emitted as a dedicated grep target", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath } = uniquePaths(dir);
  const channel = makeHumanChannel([{ decision: "terminate", reason: "stop" }]);
  const gate = new Gate({
    audit:  { path: auditPath },
    budget: { maxCostUsd: 0.10, sharedFile: budgetPath },
    humanChannel: channel,
  });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 0.15, tokens: 0 });
  await gate.check({ type: "x" });
  const lines = await gate.audit.readAll();
  const haltLines = lines.filter(l => l.phase === "halt");
  assert.equal(haltLines.length, 1, "exactly one phase:halt line for the operator");
  assert.equal(haltLines[0].dimension, "costUsd");
  assert.equal(haltLines[0].rule, "budget.maxCostUsd");
});

test("haltContext returns deterministic stats from audit", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const gate = new Gate({ audit: { path: auditPath } });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 0.10, tokens: 100 });
  await gate.record({ type: "y" }, { costUsd: 0.20, tokens: 200 });
  const ctx = await gate.haltContext();
  assert.ok(Math.abs(ctx.spent.costUsd - 0.30) < 1e-9, `expected ~0.30, got ${ctx.spent.costUsd}`);
  assert.equal(ctx.spent.tokens, 300);
  assert.equal(ctx.turns, 2);
  assert.equal(ctx.spendRate.last5.length, 2);
});

test("humanChannelTimeoutMs — slow channel resolves to deny+halt", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath } = uniquePaths(dir);
  let channelCalls = 0;
  const slowChannel = (event) => {
    channelCalls++;
    return new Promise((resolve) => setTimeout(
      () => resolve({ decision: "allow", reason: "too late" }),
      500
    ));
  };
  const gate = new Gate({
    audit:  { path: auditPath },
    budget: { maxCostUsd: 0.10, sharedFile: budgetPath },
    humanChannel: slowChannel,
    humanChannelTimeoutMs: 50,
  });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 0.15, tokens: 0 });
  const dec = await gate.check({ type: "x" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.severity, "halt");
  assert.equal(dec.rule, "budget.maxCostUsd");
  assert.match(dec.reason, /humanChannel timeout after 50ms/);
  assert.equal(channelCalls, 1, "channel was invoked once");
  const lines = await gate.audit.readAll();
  const timeoutLines = lines.filter(l => l.phase === "approval" && /timeout/.test(l.reason ?? ""));
  assert.equal(timeoutLines.length, 1, "approval audit line records the timeout");
});

test("humanChannelTimeoutMs — fast channel still wins the race", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath } = uniquePaths(dir);
  const channel = makeHumanChannel([{ decision: "topup", newCap: 1.00, reason: "ok" }]);
  const gate = new Gate({
    audit:  { path: auditPath },
    budget: { maxCostUsd: 0.10, sharedFile: budgetPath },
    humanChannel: channel,
    humanChannelTimeoutMs: 5000,
  });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 0.15, tokens: 0 });
  const dec = await gate.check({ type: "x" });
  assert.equal(dec.outcome, "allow", "fast topup beats the timeout");
});

test("budget reconstruction from audit (cold start, missing budget file)", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath, runId } = uniquePaths(dir);

  // First: write some history via gate1
  const gate1 = new Gate({
    runId, audit: { path: auditPath },
    budget: { maxCostUsd: 1.00, sharedFile: budgetPath },
  });
  await gate1.init();
  await gate1.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });
  await gate1.record({ type: "y" }, { costUsd: 0.20, tokens: 0 });

  // Delete budget file. Spawn a fresh gate; rebuilds from audit.
  const { promises: fsp } = await import("node:fs");
  await fsp.unlink(budgetPath);

  const gate2 = new Gate({
    runId, audit: { path: auditPath },
    budget: { maxCostUsd: 1.00, sharedFile: budgetPath },
  });
  await gate2.init();
  assert.ok(Math.abs(gate2.budget.spentUsd - 0.50) < 1e-9, `expected spent rebuilt to 0.50, got ${gate2.budget.spentUsd}`);
});
