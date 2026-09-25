// rwx x prototype-pollution hardening — same class as
// test/gate-prototype-pollution.test.js: every eval step reads
// `action.<field>`/`action.args.<field>` directly, so a polluted
// Object.prototype must not inject a field the action never declared and
// flip an rwx decision (incl. deny→ALLOW via an inherited `type`/`cmd`).

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

function gateFor() {
  return new Gate({
    audit: { path: null },
    rwx: {
      agent: "researcher",
      agents: { researcher: "r--" },
      tools: { read: "r", write: "w", deploy: "x" },
      bash: { "git status": "r", "git commit": "w", "git push": "x" },
    },
    humanChannel: async () => ({ decision: "deny" }),
  });
}

async function withPollution(keys, fn) {
  for (const [k, v] of Object.entries(keys)) Object.prototype[k] = v;
  try { return await fn(); } finally { for (const k of Object.keys(keys)) delete Object.prototype[k]; }
}

test("rwx pollution: a type-less action is NOT granted via an inherited type", async () => {
  const gate = gateFor();
  await gate.init();
  const d = await withPollution({ type: "read" }, () => gate.check({ args: {} }));
  // The inherited `type` must not surface — safeAction copies own props only,
  // so `action.type` reads undefined and denies as unlisted, never as "read".
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.unlisted");
});

test("rwx pollution: an inherited bash command cannot inject a denied command (flat + nested)", async () => {
  const gate = gateFor();
  await gate.init();
  // Baseline (no own cmd) denies as unlisted ("" is not in the bash map);
  // pollution with a DANGEROUS command must not change that outcome to allow.
  const flat = await withPollution({ cmd: "git push" }, () => gate.check({ type: "bash" }));
  assert.equal(flat.outcome, "deny");
  assert.equal(flat.rule, "rwx.unlisted"); // "" (own cmd absent) is unlisted, not the inherited "git push"

  const nested = await withPollution({ cmd: "git push" }, () => gate.check({ type: "bash", args: {} }));
  assert.equal(nested.outcome, "deny");
  assert.equal(nested.rule, "rwx.unlisted");
});

test("rwx pollution: an inherited rwx-favorable command cannot grant a decision either", async () => {
  // The inverse direction: pollute with a command the agent WOULD be allowed
  // to run, and confirm own-field absence still governs (own "" wins, denies).
  const gate = gateFor();
  await gate.init();
  const d = await withPollution({ cmd: "git status" }, () => gate.check({ type: "bash" }));
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.unlisted");
});

test("rwx pollution: run() executes the SAME normalized action it evaluated (no TOCTOU)", async () => {
  const gate = gateFor();
  await gate.init();
  let executedCmd = "UNSET";
  const out = await withPollution({ cmd: "git push" }, () =>
    gate.run({ type: "bash", args: { command: "git status" } }, (a) => { executedCmd = a.args.command; return { costUsd: 0 }; }));
  assert.ok(!out?.error, "git status should be allowed for researcher (r--)");
  assert.equal(executedCmd, "git status", "executor must see the REAL own-field command, not an inherited one");
});

test("rwx pollution: normal own-field actions are unaffected (no over-correction)", async () => {
  const gate = gateFor();
  await gate.init();
  const d1 = await gate.check({ type: "bash", args: { command: "git status" } });
  assert.equal(d1.outcome, "allow");
  const d2 = await withPollution({ command: "git push" }, () => gate.check({ type: "bash", args: { command: "git status" } }));
  // own args.command shadows any inherited args.command
  assert.equal(d2.outcome, "allow");
  assert.equal(d2.rwxLetter, "r");
});

test("rwx pollution: a __proto__-carrying action cannot smuggle a tools-map letter via args", async () => {
  const gate = gateFor();
  await gate.init();
  // JSON.parse-style hostile payload; safeAction's null-proto copy neutralizes it.
  const hostile = JSON.parse('{"type":"deploy","args":{"__proto__":{"letter":"r"}}}');
  const d = await gate.check(hostile);
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.denied"); // deploy is tagged "x"; researcher holds "r--" regardless of args
});
