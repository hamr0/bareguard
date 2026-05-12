// v0.4.2 — limits.maxToolRounds: halt severity counter that ticks only
// on records where action.type !== "llm". Sibling to maxTurns; gives
// adopters using bareagent's onLlmResult/onToolResult split a clean
// "round-based" budget without the maxTurns * 2 mental math.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { makeHumanChannel } from "./_helpers.js";

test("maxToolRounds — halts after N non-llm records", async () => {
  const gate = new Gate({
    audit:  { path: null },
    limits: { maxToolRounds: 3 },
  });
  await gate.init();

  await gate.record({ type: "bash", cmd: "ls" }, { costUsd: 0, tokens: 0 });
  await gate.record({ type: "bash", cmd: "ls" }, { costUsd: 0, tokens: 0 });
  await gate.record({ type: "bash", cmd: "ls" }, { costUsd: 0, tokens: 0 });

  const dec = await gate.check({ type: "bash", cmd: "ls" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.severity, "halt");
  assert.equal(dec.rule, "limits.maxToolRounds");
  assert.match(dec.reason, /toolRounds 3 >= max 3/);
});

test("maxToolRounds — llm records DO NOT tick the counter", async () => {
  const gate = new Gate({
    audit:  { path: null },
    limits: { maxToolRounds: 2 },
  });
  await gate.init();

  // Three llm records — should not count toward toolRounds.
  await gate.record({ type: "llm", model: "claude" }, { costUsd: 0.01, tokens: 100 });
  await gate.record({ type: "llm", model: "claude" }, { costUsd: 0.01, tokens: 100 });
  await gate.record({ type: "llm", model: "claude" }, { costUsd: 0.01, tokens: 100 });

  const dec = await gate.check({ type: "bash", cmd: "ls" });
  assert.equal(dec.outcome, "allow", "llm records must not count toward maxToolRounds");
  assert.equal(gate.limits.toolRounds, 0);
  assert.equal(gate.limits.turns, 3, "maxTurns still counts llm records (regression)");
});

test("maxToolRounds — mixed llm + tool records, only tool side ticks", async () => {
  const gate = new Gate({
    audit:  { path: null },
    limits: { maxToolRounds: 2 },
  });
  await gate.init();

  // Two rounds of {llm, tool} — turns = 4, toolRounds = 2 → halts on next check
  await gate.record({ type: "llm",  model: "claude" }, { costUsd: 0.01, tokens: 100 });
  await gate.record({ type: "bash", cmd: "ls" },       { costUsd: 0,    tokens: 0   });
  await gate.record({ type: "llm",  model: "claude" }, { costUsd: 0.01, tokens: 100 });
  await gate.record({ type: "bash", cmd: "ls" },       { costUsd: 0,    tokens: 0   });

  assert.equal(gate.limits.turns, 4);
  assert.equal(gate.limits.toolRounds, 2);

  const dec = await gate.check({ type: "bash", cmd: "ls" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "limits.maxToolRounds");
});

test("maxToolRounds — default Infinity = no halt (opt-in)", async () => {
  const gate = new Gate({
    audit:  { path: null },
    limits: { /* maxToolRounds not set */ },
  });
  await gate.init();
  for (let i = 0; i < 100; i++) {
    await gate.record({ type: "bash", cmd: "ls" }, { costUsd: 0, tokens: 0 });
  }
  const dec = await gate.check({ type: "bash", cmd: "ls" });
  assert.equal(dec.outcome, "allow", "default behaviour unchanged");
});

test("maxToolRounds — halt routes through humanChannel like maxTurns", async () => {
  const channel = makeHumanChannel([
    { decision: "terminate", reason: "operator stopped" },
  ]);
  const gate = new Gate({
    audit:  { path: null },
    limits: { maxToolRounds: 1 },
    humanChannel: channel,
  });
  await gate.init();

  await gate.record({ type: "bash", cmd: "ls" }, { costUsd: 0, tokens: 0 });
  const dec = await gate.check({ type: "bash", cmd: "ls" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "gate.terminated");
  assert.equal(channel.events.length, 1);
  assert.equal(channel.events[0].kind, "halt");
  assert.equal(channel.events[0].rule, "limits.maxToolRounds");
});

test("maxToolRounds — toolRounds rebuilt from audit on cold start", async (t) => {
  const { makeTmpDir, cleanup, uniquePaths } = await import("./_helpers.js");
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, budgetPath, runId } = uniquePaths(dir);

  const gate1 = new Gate({
    runId,
    audit:  { path: auditPath },
    budget: { sharedFile: budgetPath },
    limits: { maxToolRounds: 5 },
  });
  await gate1.init();
  await gate1.record({ type: "bash", cmd: "ls" }, { costUsd: 0, tokens: 0 });
  await gate1.record({ type: "llm",  model: "x" }, { costUsd: 0, tokens: 0 });
  await gate1.record({ type: "bash", cmd: "ls" }, { costUsd: 0, tokens: 0 });

  // Crash budget file, spawn a fresh Gate → must rebuild toolRounds from audit
  const { promises: fsp } = await import("node:fs");
  await fsp.unlink(budgetPath);

  const gate2 = new Gate({
    runId,
    audit:  { path: auditPath },
    budget: { sharedFile: budgetPath },
    limits: { maxToolRounds: 5 },
  });
  await gate2.init();
  assert.equal(gate2.limits.toolRounds, 2, "rebuilt toolRounds excludes llm records");
  assert.equal(gate2.limits.turns, 3, "rebuilt turns counts all records (regression)");
});
