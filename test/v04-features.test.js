// v0.4 feature tests: halt-event carries action, fileless audit mode,
// strict budget mode.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths, makeHumanChannel } from "./_helpers.js";

// ────────────────────────────────────────────────────────────────────────
// B1: halt events carry the action being checked (not null)
// ────────────────────────────────────────────────────────────────────────

test("halt event — event.action is the action being checked (with caller _ctx)", async (t) => {
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

  const action = { type: "bash", cmd: "ls", _ctx: { chatId: "chat-42", isOwner: false } };
  await gate.check(action);

  assert.equal(channel.events.length, 1);
  const ev = channel.events[0];
  assert.equal(ev.kind, "halt", "halt event fires for budget cap");
  assert.ok(ev.action, "halt event carries action (v0.4 contract)");
  assert.equal(ev.action.type, "bash");
  assert.equal(ev.action.cmd, "ls");
  assert.deepEqual(ev.action._ctx, { chatId: "chat-42", isOwner: false },
    "caller-attached _ctx is preserved verbatim for halt routing");

  // Dedicated phase:"halt" audit line stays action-less by design — it's the
  // operator grep target, distinct from the per-call gate audit line.
  const lines = await gate.audit.readAll();
  const haltLine = lines.find(l => l.phase === "halt");
  assert.ok(haltLine, "phase:halt audit line is emitted");
  assert.equal(haltLine.action, null, "phase:halt line action stays null (PRD §10.1)");
});

test("ask event still carries action (regression check)", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const channel = makeHumanChannel([{ decision: "allow", reason: "ok" }]);
  const gate = new Gate({ audit: { path: auditPath }, humanChannel: channel });
  await gate.init();

  const action = { type: "fetch", url: "https://api/delete-acct", _ctx: { tenant: "t1" } };
  await gate.check(action);

  assert.equal(channel.events.length, 1);
  assert.equal(channel.events[0].kind, "ask");
  assert.deepEqual(channel.events[0].action._ctx, { tenant: "t1" });
});

// ────────────────────────────────────────────────────────────────────────
// B4: audit.path: null → fileless in-memory mode
// ────────────────────────────────────────────────────────────────────────

test("fileless audit — audit.path:null collects entries in memory, no fs writes", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  assert.equal(gate.audit.fileless, true);
  assert.equal(gate.audit.filePath, null);

  await gate.check({ type: "bash", cmd: "ls" });
  await gate.record({ type: "bash", cmd: "ls" }, { costUsd: 0.01, tokens: 100 });

  const entries = gate.audit.entries;
  assert.ok(entries.length >= 2, `expected ≥2 audit lines, got ${entries.length}`);
  const phases = entries.map(e => e.phase);
  assert.ok(phases.includes("gate"),   "gate phase present");
  assert.ok(phases.includes("record"), "record phase present");

  // gate.audit.readAll() must return the in-memory entries
  const all = await gate.audit.readAll();
  assert.equal(all.length, entries.length);
});

test("fileless audit — humanChannel test idiom (deny-lambda) works", async () => {
  const gate = new Gate({
    audit: { path: null },
    humanChannel: async () => ({ decision: "deny", reason: "test denial" }),
  });
  await gate.init();
  // content.askPatterns fires on "delete" → ask → human denies
  const dec = await gate.check({ type: "fetch", url: "https://api/delete-acct" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "content.askPatterns");
});

test("fileless audit — haltContext reconstructs from in-memory entries", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 0.10, tokens: 100 });
  await gate.record({ type: "y" }, { costUsd: 0.20, tokens: 200 });
  const ctx = await gate.haltContext();
  assert.ok(Math.abs(ctx.spent.costUsd - 0.30) < 1e-9);
  assert.equal(ctx.spent.tokens, 300);
});

// ────────────────────────────────────────────────────────────────────────
// B10: budget.strict — trailing-avg pre-flight halt
// ────────────────────────────────────────────────────────────────────────

test("strict budget — halts pre-flight when projection exceeds cap (≥3 samples)", async () => {
  const gate = new Gate({
    audit:  { path: null },
    budget: { maxCostUsd: 1.00, strict: true },
  });
  await gate.init();
  // 3 records of $0.30 each → spent=0.90, avg=0.30 → spent+avg=1.20 > 1.00 → halt
  await gate.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });
  await gate.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });
  await gate.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });

  const dec = await gate.check({ type: "x" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.severity, "halt");
  assert.equal(dec.rule, "budget.maxCostUsd");
  assert.match(dec.reason, /strict: spent .* \+ est .* > cap/);
});

test("strict budget — soft (no halt) when fewer than 3 samples (cold start)", async () => {
  const gate = new Gate({
    audit:  { path: null },
    budget: { maxCostUsd: 1.00, strict: true },
  });
  await gate.init();
  // 2 records — strict has insufficient samples; only post-fact >= cap halt fires
  await gate.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });
  await gate.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });

  const dec = await gate.check({ type: "x" });
  assert.equal(dec.outcome, "allow", "strict must not halt cold-start with <3 samples");
});

test("strict budget — opt-out by default (no halt with samples below post-fact cap)", async () => {
  const gate = new Gate({
    audit:  { path: null },
    budget: { maxCostUsd: 1.00 }, // strict NOT set
  });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });
  await gate.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });
  await gate.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });

  const dec = await gate.check({ type: "x" });
  assert.equal(dec.outcome, "allow", "default mode is soft; only post-fact >=cap halts");
});

test("strict budget — token dimension also enforced", async () => {
  const gate = new Gate({
    audit:  { path: null },
    budget: { maxTokens: 1000, strict: true },
  });
  await gate.init();
  // 3 records of 300 tokens → spent=900, avg=300 → spent+avg=1200 > 1000 → halt
  await gate.record({ type: "x" }, { costUsd: 0, tokens: 300 });
  await gate.record({ type: "x" }, { costUsd: 0, tokens: 300 });
  await gate.record({ type: "x" }, { costUsd: 0, tokens: 300 });

  const dec = await gate.check({ type: "x" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "budget.maxTokens");
  assert.match(dec.reason, /strict:/);
});

test("strict budget — topup re-evaluates and clears the projection halt", async () => {
  const channel = makeHumanChannel([
    { decision: "topup", newCap: 5.00, reason: "operator approved" },
  ]);
  const gate = new Gate({
    audit:  { path: null },
    budget: { maxCostUsd: 1.00, strict: true },
    humanChannel: channel,
  });
  await gate.init();
  await gate.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });
  await gate.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });
  await gate.record({ type: "x" }, { costUsd: 0.30, tokens: 0 });

  const dec = await gate.check({ type: "x" });
  assert.equal(dec.outcome, "allow", "after topup, strict projection passes");
  assert.equal(gate.budget.capUsd, 5.00);
  // Locks down the re-evaluation loop: exactly one halt prompt, then the
  // post-topup re-check passes. An accidental "topup applied without
  // re-running _haltCheck" regression would not satisfy this.
  assert.equal(channel.events.length, 1,
    "exactly one humanChannel call — second iteration must not re-prompt");
});

// ────────────────────────────────────────────────────────────────────────
// Regression: BAREGUARD_AUDIT_PATH env var still wins when audit.path is
// undefined (not null). The "path" in config.audit check at gate.js is the
// load-bearing distinguisher between explicit-null (fileless) and absent
// (env / XDG default).
// ────────────────────────────────────────────────────────────────────────

test("BAREGUARD_AUDIT_PATH env var honored when audit.path is undefined", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const prev = process.env.BAREGUARD_AUDIT_PATH;
  process.env.BAREGUARD_AUDIT_PATH = auditPath;
  t.after(() => {
    if (prev === undefined) delete process.env.BAREGUARD_AUDIT_PATH;
    else process.env.BAREGUARD_AUDIT_PATH = prev;
  });

  // audit: {} — config.audit exists but `path` is not in it; env should win.
  const gate = new Gate({ audit: {} });
  await gate.init();
  assert.equal(gate.audit.fileless, false, "audit:{} is NOT fileless (env path wins)");
  assert.equal(gate.audit.filePath, auditPath, "env-var path is used");
});
