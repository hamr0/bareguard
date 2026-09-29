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

import { REAL_SLASH_TMP } from "./_helpers.js";
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
    fs: { readScope: [REAL_SLASH_TMP] },
    rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { read: "r" } },
    humanChannel: async () => ({ decision: "deny" }),
  });
  try {
    await gate.init();
    await gate.check({ type: "read", path: REAL_SLASH_TMP + "/x", args: {} });
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

// ─── the debrief finding: a fileless line holding an unserializable action ─

test("readAudit: a fileless line whose action holds a BigInt is decoupled, not a shallow copy of the live reference", async () => {
  // `gate.check()` on an action with a BigInt field denies at
  // content.unserializable (serializeForMatch can't serialize it), but the
  // in-memory fileless audit log still holds the RAW action object,
  // BigInt and all — this is the one shape `Audit.emit()` never degrades
  // (degrade only runs in file mode). readAudit()'s whole-array/whole-line
  // JSON round-trip throws on that BigInt, so it falls to the per-line
  // fallback — the exact path this test exercises.
  const gate = gateFor();
  await gate.init();
  const decision = await gate.check({ type: "noop", amount: 10n, args: {} });
  assert.equal(decision.outcome, "deny");
  assert.equal(decision.rule, "content.unserializable");

  const lines = await gate.readAudit();
  const denyLine = lines.find((l) => l.rule === "content.unserializable");
  assert.ok(denyLine, "the deny line must be present in the read-back log");
  assert.equal(denyLine.action.amount, "10", "the BigInt must survive as its string form, not sink the whole line");

  // The load-bearing property: mutating the returned line's nested action
  // must NEVER reach the live in-memory log — the previous `{ ...line }`
  // fallback was a SHALLOW copy whose `.action` was the very object still
  // sitting in `gate.audit.entries`.
  const liveLines = await gate.audit.readAll();
  const liveDenyLine = liveLines.find((l) => l.rule === "content.unserializable");
  assert.notEqual(denyLine.action, liveDenyLine.action, "readAudit() must never hand back a live reference");

  denyLine.action.type = "MUTATED";
  denyLine.action.newField = "planted";

  const again = await gate.readAudit();
  const againDenyLine = again.find((l) => l.rule === "content.unserializable");
  assert.equal(againDenyLine.action.type, "noop", "mutating the returned copy must not affect a later readAudit() call");
  assert.equal(againDenyLine.action.newField, undefined, "a planted field must not leak into the live log");

  const liveAgain = await gate.audit.readAll();
  const liveAgainDenyLine = liveAgain.find((l) => l.rule === "content.unserializable");
  assert.equal(liveAgainDenyLine.action.type, "noop", "gate.audit's own live state must be untouched by the mutation");
});

test("readAudit: a fileless line whose action holds a circular reference is decoupled and cut, not shared or thrown", async () => {
  // Secrets redaction is DEFAULT-ON, and its key-aware walk (src/primitives/
  // secrets.js `walkKeys`) unconditionally cycle-detects and already fully
  // decouples a circular action via a `JSON.parse` round-trip before it ever
  // reaches the audit line — so a circular action can't reach THIS bug's
  // repro path under default config. Disabling secrets redaction entirely
  // (`redactKeys:false`, no explicit keys/patterns/envVars — `makeRedactor()`
  // then returns `null`, `Audit.emit()`'s whole `LINE_FIELDS` loop is
  // skipped) is what makes the raw, still-circular action reach the
  // in-memory fileless entry untouched, exactly like the BigInt case above.
  const gate = new Gate({
    audit: { path: null },
    secrets: { redactKeys: false },
    rwx: {
      agent: "fixer",
      agents: { fixer: "rw-" },
      tools: { read: "r", write: "w" },
    },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  const circular = { type: "noop", args: {} };
  circular.self = circular;
  const decision = await gate.check(circular);
  assert.equal(decision.outcome, "deny");
  assert.equal(decision.rule, "content.unserializable");

  const lines = await gate.readAudit();
  const denyLine = lines.find((l) => l.rule === "content.unserializable");
  assert.ok(denyLine, "the deny line must be present in the read-back log");
  // `safeAction()`'s own top-level copy means the live action's `self` chain
  // is `line.action` (the safeAction copy) -> `circular` (the caller's
  // original object) -> itself; the cycle is cut one level in, at the point
  // where the SAME object would be visited twice.
  assert.equal(denyLine.action.self.self, "[Circular]", "the cycle must be cut with a marker, not crash the read");

  const liveLines = await gate.audit.readAll();
  const liveDenyLine = liveLines.find((l) => l.rule === "content.unserializable");
  assert.notEqual(denyLine.action, liveDenyLine.action, "readAudit() must never hand back a live reference");
  assert.notEqual(denyLine.action.self, liveDenyLine.action.self, "the nested circular sub-object must also be decoupled, not shared");

  denyLine.action.type = "MUTATED";
  const liveAgain = await gate.audit.readAll();
  const liveAgainDenyLine = liveAgain.find((l) => l.rule === "content.unserializable");
  assert.equal(liveAgainDenyLine.action.type, "noop", "the live log must be untouched by the mutation");
});

test("readAudit: a fileless line whose action holds a throwing toJSON never leaks the function, and the result is JSON-safe", async () => {
  // A throwing `toJSON` is what forces BOTH the whole-array AND the
  // per-line JSON round-trips to fail, landing on safeDeepClone. The old
  // `{ ...line }`-descendant fallback (before ancestor-path cycle tracking
  // and JSON-value semantics were added) walked own keys but still handed
  // back the live `toJSON` FUNCTION by reference — so `JSON.stringify()` on
  // the returned line would invoke it and throw the caller's own error.
  const gate = new Gate({
    audit: { path: null },
    secrets: { redactKeys: false },
    rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { read: "r", write: "w" } },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  const decision = await gate.check({
    type: "noop",
    big: 5n,
    h: { real: "v", toJSON() { throw new Error("boom"); } },
    args: {},
  });
  assert.equal(decision.outcome, "deny");

  const lines = await gate.readAudit();
  const L = lines.find((l) => l.action && "big" in l.action);
  assert.ok(L, "the deny line must be present in the read-back log");
  assert.equal(typeof L.action.h.toJSON, "undefined", "the toJSON FUNCTION must never survive into the clone");
  assert.equal(L.action.h.real, "v", "sibling fields must survive untouched");
  assert.doesNotThrow(() => JSON.stringify(L), "the returned line must never re-invoke a caller's toJSON");

  // A function inside an ARRAY becomes null (JSON semantics), not omitted
  // and not passed through by reference.
  const gate2 = new Gate({
    audit: { path: null },
    secrets: { redactKeys: false },
    rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { read: "r" } },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate2.init();
  await gate2.check({ type: "noop", big: 5n, arr: [1, function bad() {}, 3], args: {} });
  const lines2 = await gate2.readAudit();
  const L2 = lines2.find((l) => l.action && "big" in l.action);
  assert.deepEqual(L2.action.arr, [1, null, 3], "a function element must become null, JSON.stringify style");
});

test("readAudit: two fields sharing one non-circular sub-object are cloned independently, not cut as a cycle", async () => {
  const gate = new Gate({
    audit: { path: null },
    secrets: { redactKeys: false },
    rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { read: "r" } },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  const shared = { nested: { x: 1 } };
  await gate.check({ type: "noop", big: 5n, a: shared, b: shared, args: {} });

  const lines = await gate.readAudit();
  const L = lines.find((l) => l.action && "big" in l.action);
  assert.notEqual(L.action.a, "[Circular]", "a DAG (non-ancestor repeat) must not be treated as a cycle");
  assert.notEqual(L.action.b, "[Circular]");
  assert.deepEqual(L.action.a, shared, "the copy must be a faithful, independent clone");
  assert.deepEqual(L.action.b, shared);
  assert.notEqual(L.action.a, L.action.b, "the two fields must be cloned as SEPARATE objects, not the same reference");
  assert.notEqual(L.action.a, shared, "neither copy may be the live original");
  assert.notEqual(L.action.b, shared);
});

test("readAudit: a true self-cycle still becomes the [Circular] marker", async () => {
  const gate = new Gate({
    audit: { path: null },
    secrets: { redactKeys: false },
    rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { read: "r" } },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  const c = { type: "noop", big: 5n, args: {} };
  c.self = c;
  await gate.check(c);

  const lines = await gate.readAudit();
  const L = lines.find((l) => l.action && "big" in l.action);
  assert.equal(L.action.self.self, "[Circular]", "a genuine ancestor cycle must still be cut with the marker");
});

test("readAudit: a very deep chain resolves without throwing", async () => {
  const gate = new Gate({
    audit: { path: null },
    secrets: { redactKeys: false },
    rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { read: "r" } },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  let deep = {};
  let cur = deep;
  for (let i = 0; i < 100000; i++) {
    cur.next = {};
    cur = cur.next;
  }
  await gate.check({ type: "noop", big: 5n, deep, args: {} });

  await assert.doesNotReject(async () => {
    const lines = await gate.readAudit();
    assert.ok(lines.length >= 1);
  }, "readAudit() must never throw, even on a chain deep enough to overflow the stack");
});

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
