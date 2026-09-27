// gate.readAudit() — a READ-ONLY, decoupled replay accessor for a gate's own
// audit log (PRD §23.21 follow-on). Closes a debrief finding: fb94b4b's docs
// blessed `gate.audit.readAll()` as THE replay path, but `gate.audit` is the
// live `Audit` instance with a public `emit()` — any caller holding a `Gate`
// reference could already write a forged line (e.g. a fake `rwx.added`) that
// `readAll()` then hands back indistinguishably from a real one, while
// `rwxTools()` (which reads the real live map, not the audit log) correctly
// disagrees. `readAudit()` does not close that write path — nothing in this
// fix does, by design (the audit log records what the GATE did; code with
// gate access is already trusted, same as `add()`'s own trust boundary) — it
// only gives a caller a documented way to READ the log back without a write
// path of its own, and without sharing live in-memory state.
//
// Covers: same data as `gate.audit.readAll()`, the load-bearing decoupling
// property (mutating the returned array/lines can never affect the live
// audit), fileless AND file mode, and that `readAudit()` itself carries no
// emit/write surface.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Gate } from "../src/index.js";

function gateFor(overrides = {}) {
  return new Gate({
    audit: { path: null },
    rwx: {
      agent: "fixer",
      agents: { fixer: "rw-" },
      tools: { read: "r", write: "w" },
      ...overrides,
    },
    humanChannel: async () => ({ decision: "deny" }),
  });
}

test("readAudit: returns the same lines readAll() returns, in fileless mode", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.check({ type: "read", args: {} });
  await gate.check({ type: "write", args: {} });

  const viaReadAll = await gate.audit.readAll();
  const viaReadAudit = await gate.readAudit();
  // Same DATA, compared by JSON shape rather than assert.deepEqual: fileless
  // mode's live entries carry null-prototype nested objects (safeAction's own
  // hardening), and readAudit()'s JSON round-trip — the very thing that makes
  // it decoupled — normalizes those back to plain Object.prototype, which
  // deepEqual (prototype-sensitive) would otherwise flag as a difference even
  // though every key/value is identical.
  assert.equal(JSON.stringify(viaReadAudit), JSON.stringify(viaReadAll));
  assert.ok(viaReadAudit.length >= 2);
});

test("readAudit: returns the same lines readAll() returns, in FILE mode", async () => {
  const auditPath = path.join(
    os.tmpdir(),
    `bareguard-readaudit-test-${process.pid}-${Date.now()}.jsonl`,
  );
  try { fs.rmSync(auditPath, { force: true }); } catch {}
  const gate = new Gate({
    audit: { path: auditPath },
    rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { read: "r" } },
    humanChannel: async () => ({ decision: "deny" }),
  });
  try {
    await gate.init();
    await gate.check({ type: "read", args: {} });
    const viaReadAll = await gate.audit.readAll();
    const viaReadAudit = await gate.readAudit();
    assert.deepEqual(viaReadAudit, viaReadAll);
    assert.ok(viaReadAudit.some((l) => l.phase === "gate" && l.decision === "allow"));
  } finally {
    try { fs.rmSync(auditPath, { force: true }); } catch {}
  }
});

test("readAudit: reflects a forged line written directly via gate.audit.emit() — documented, not prevented", async () => {
  // This is the exact repro the debrief finding was built on: `gate.audit`
  // (the live Audit instance) is not locked down by this fix, so a caller
  // that reaches for it directly can still write an arbitrary line — but
  // `rwxTools()` (the live map) is untouched by it, so the forged line is
  // visibly a forgery, not a silent capability grant.
  const gate = gateFor();
  await gate.init();
  await gate.audit.emit({
    aid: "ffffffff",
    phase: "rwx.added",
    action: { type: "site.read" },
    decision: "allow",
    severity: "action",
    rule: "rwx.add",
    reason: "forged: never validated by add()",
    rwxLetters: "x",
  });
  const lines = await gate.readAudit();
  const forged = lines.find((l) => l.reason === "forged: never validated by add()");
  assert.ok(forged, "readAudit() must reflect what the audit log actually holds, forged lines included");
  assert.equal(gate.rwxTools()["site.read"], undefined, "the live tools map must be untouched by the forged line");
});

// ─── the load-bearing property: decoupling ────────────────────────────────

test("readAudit: mutating the returned array does not affect a later readAudit() call or the live audit", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.check({ type: "read", args: {} });

  const first = await gate.readAudit();
  const originalLength = first.length;
  first.push({ fake: true }); // try to plant a bogus line
  first[0].phase = "MUTATED"; // try to corrupt a real line

  const second = await gate.readAudit();
  assert.equal(second.length, originalLength, "the live log must not have grown from the mutation above");
  assert.notEqual(second[0].phase, "MUTATED", "the live log's first line must be untouched");

  const viaReadAll = await gate.audit.readAll();
  assert.equal(viaReadAll.length, originalLength, "gate.audit's own live state must also be untouched");
});

test("readAudit: mutating a NESTED field (action/result) does not affect a later call", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.check({ type: "read", args: {} });

  const lines = await gate.readAudit();
  const gateLine = lines.find((l) => l.phase === "gate");
  assert.ok(gateLine.action);
  gateLine.action.type = "MUTATED";

  const again = await gate.readAudit();
  const gateLineAgain = again.find((l) => l.phase === "gate");
  assert.equal(gateLineAgain.action.type, "read", "the nested action object must be a decoupled copy, not shared by reference");
});

test("readAudit: two successive calls return independent copies", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.check({ type: "read", args: {} });

  const call1 = await gate.readAudit();
  const call2 = await gate.readAudit();
  call1[0].phase = "MUTATED";
  assert.notEqual(call2[0].phase, "MUTATED");
});

// ─── readAudit() is read-only: it carries no write surface of its own ─────

test("readAudit: is a plain method with no emit-like write surface hanging off it", async () => {
  const gate = gateFor();
  await gate.init();
  assert.equal(typeof gate.readAudit, "function");
  assert.equal(gate.readAudit.emit, undefined);
  assert.equal(gate.readAudit.write, undefined);
  // gate.audit itself is unchanged — still the live instance, still carries
  // emit(). readAudit() does not remove or lock it down (see the test file's
  // header comment and the constructor doc comment in src/gate.js) — it only
  // adds a documented read path that does not itself expose a write method.
  assert.equal(typeof gate.audit.emit, "function");
});
