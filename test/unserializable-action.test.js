import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Gate, redact } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

// An action the gate cannot read as text used to CRASH `check()`/`record()`/
// `run()`/`allows()` — the gate threw instead of deciding, so the deny floor
// never ran and no audit line was written. Four independent sites, one class:
//
//   gate.js safeAction      `Object.assign` invokes a getter that throws
//   content.js              the catch fell back to `String(action)`, which
//                           ALWAYS throws on the null-proto copy safeAction
//                           itself produces — the net never worked
//   secrets.js walkKeys     unbounded recursion (cycle, or sheer depth)
//   audit.js emit           `JSON.stringify(line)` unguarded
//
// Four triggers reach them, and each reaches a different subset, so every shape
// below is its own case rather than a representative one.

const SHAPES = {
  "self-reference": () => { const a = { type: "bash", args: { command: "ls" } }; a.back = a; return a; },
  "BigInt":         () => ({ type: "bash", args: { command: "ls" }, n: 10n }),
  "throwing toJSON":() => ({ type: "bash", args: { command: "ls" }, x: { toJSON() { throw new Error("boom"); } } }),
  "deep nesting":   () => { let o = {}; const r = o; for (let i = 0; i < 50_000; i++) { o.n = {}; o = o.n; } return { type: "bash", args: { command: "ls" }, d: r }; },
};

// The shape this was actually found as: an agent framework stamps the session
// onto each action for tracing, and the session holds the action it is running.
function sessionLoopAction(command) {
  const session = { id: "sess-42", history: [] };
  const action = { type: "bash", args: { command }, _ctx: session };
  session.history.push(action);
  return action;
}

for (const [name, mk] of Object.entries(SHAPES)) {
  test(`content — an unreadable action (${name}) denies instead of throwing`, async () => {
    const gate = new Gate({ tools: { allowlist: ["bash"] }, audit: { path: null } });
    await gate.init();
    const dec = await gate.check(mk());
    assert.equal(dec.outcome, "deny");
    assert.equal(dec.rule, "content.unserializable");
  });
}

test("content — the ask path denies on its own, not only via the deny path", async () => {
  // With `denyPatterns: []` the deny check returns before it ever serializes,
  // so the ask check is the first step that touches the action. Without its own
  // guard the old `String(action)` throw was still reachable here.
  const gate = new Gate({
    tools: { allowlist: ["bash"] }, content: { denyPatterns: [] }, audit: { path: null },
  });
  await gate.init();
  const dec = await gate.check(sessionLoopAction("ls"));
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "content.unserializable");
});

test("every entry point resolves rather than throwing", async () => {
  const mkGate = async () => { const g = new Gate({ tools: { allowlist: ["bash"] }, audit: { path: null } }); await g.init(); return g; };
  await (await mkGate()).check(sessionLoopAction("ls"));
  await (await mkGate()).record(sessionLoopAction("ls"), { costUsd: 0.01 });
  await (await mkGate()).run(sessionLoopAction("ls"), async () => ({ costUsd: 0.01 }));
  await (await mkGate()).allows(sessionLoopAction("ls"));
  // a circular RESULT is caller data too, and never passes through safeAction
  const circResult = { costUsd: 0.01 }; circResult.self = circResult;
  await (await mkGate()).record({ type: "bash" }, circResult);
});

test("safeAction — one unreadable field must not blind the floors to the rest", async () => {
  // A getter that throws is read by `Object.assign`. Marking just that field
  // (rather than dying, or dropping it) keeps `args.command` visible, so the
  // bash floor still sees what the action actually does.
  const gate = new Gate({ tools: { allowlist: ["bash"] }, bash: { denyPatterns: [/sudo/] }, audit: { path: null } });
  await gate.init();
  const dec = await gate.check({
    type: "bash", args: { command: "sudo rm x" },
    get debug() { throw new Error("boom"); },
  });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "bash.denyPatterns", "the readable field must still be evaluated");
});

test("redact — never throws, on every shape that used to kill it", () => {
  const hostile = {
    ...SHAPES,
    "throwing getter": () => ({ type: "bash", get boom() { throw new Error("boom"); } }),
  };
  for (const [name, mk] of Object.entries(hostile)) {
    assert.doesNotThrow(() => redact(mk()), `redact must not throw on ${name}`);
  }
});

test("redact — a cycle must not cost the rest of the object its key redaction", () => {
  // Bailing out of the walk would have been the cheap fix. It is wrong: the
  // secret sits OUTSIDE the cycle and must still be blanked.
  const a = { apiKey: "totally-not-a-recognisable-pattern", args: { command: "ls" } };
  a.back = a;
  const out = redact(a);
  assert.equal(out.apiKey, "[REDACTED:key=apiKey]");
  assert.equal(out.args.command, "ls", "unrelated fields must survive intact");
});

test("redact — a deep object with a toJSON shortcut must not leak its key", () => {
  // The falsifying case for a bail-out fix: the walk dies on the depth, but
  // JSON.stringify takes the toJSON shortcut and succeeds — so a bail-out would
  // have serialized the very key the walk exists to blank.
  let o = {}; const root = o;
  for (let i = 0; i < 50_000; i++) { o.n = {}; o = o.n; }
  root.toJSON = () => ({ apiKey: "totally-not-a-recognisable-pattern" });
  const out = redact({ type: "bash", payload: root });
  assert.ok(
    !JSON.stringify(out).includes("totally-not-a-recognisable-pattern"),
    "the key-named secret must not survive into the redacted copy",
  );
});

test("audit — an unreadable payload still writes a bounded, parseable line", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const gate = new Gate({ tools: { allowlist: ["bash"] }, audit: { path: auditPath } });
    await gate.init();
    await gate.check(sessionLoopAction("ls"));
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
    assert.ok(lines.length > 0, "a line must be written — losing the record is the worse failure");
    for (const l of lines) {
      assert.doesNotThrow(() => JSON.parse(l), "every line must still parse");
      assert.ok(Buffer.byteLength(l, "utf8") <= 3500, "and stay under MAX_LINE_BYTES");
    }
    const gateLine = lines.map((l) => JSON.parse(l)).find((l) => l.phase === "gate");
    assert.equal(gateLine.rule, "content.unserializable");
  } finally { await cleanup(dir); }
});

// A LATER-STAGE regression: d1bb644 added the try/catch below that degrades an
// unserializable `line` to a safe scalars-only stand-in instead of throwing
// out of `emit()`. But the pre-existing oversize-line block that runs right
// after it re-spread the ORIGINAL, still-unserializable `line` (`{ ...line,
// _truncated: true }`) rather than that safe stand-in — so once a payload was
// BOTH unserializable AND, after degrading, still over MAX_LINE_BYTES, every
// `JSON.stringify` inside the oversize block threw uncaught, one stage past
// the guard meant to prevent exactly that. `gate.audit.emit` is called
// directly (an ordinary public property) because the ~13-16 fixed keys
// `gate.js` itself passes are each clipped well under FIELD_BYTE_CAP and
// cannot total over MAX_LINE_BYTES on their own — check()/record()/run() /
// allows() cannot reach this branch unassisted.
//
// The two shapes below are NOT interchangeable: a circular payload at DEFAULT
// config never reaches this branch at all, because the default redactor's
// `walkKeys` rewrites the cycle to the string `"[REDACTED:circular]"` before
// `JSON.stringify(line)` ever runs — proven below by an explicit negative
// (`redact:"applied"` and no throw with zero config beyond the allowlist). A
// test built only on the circular shape would therefore pass at default
// config for the wrong reason: it would never actually execute the fixed
// code path. The BigInt shape is what fires at default config, because
// `walkKeys` only handles cycles and depth — it does not touch a BigInt — so
// `redact()` itself falls back to the untouched original (its own internal
// `JSON.stringify` throws, is caught, and `changed` is false), leaving the
// BigInt intact for `emit()`'s `JSON.stringify(line)` to fail on.
function forceOversize(fields) {
  for (let i = 0; i < 40; i++) fields["extra" + i] = "x".repeat(120);
  return fields;
}

test("audit — a BigInt payload that is ALSO oversize does not throw at default config", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const gate = new Gate({ tools: { allowlist: ["bash"] }, audit: { path: auditPath } });
    await gate.init();

    const fields = forceOversize({
      phase: "record",
      action: { type: "bash", n: 10n },
      decision: "allow",
      rule: "x",
      result: { costUsd: 0.42, tokens: 77, pricing: "priced" },
    });
    await assert.doesNotReject(() => gate.audit.emit(fields));

    const raw = (await readFile(auditPath, "utf8")).trim().split("\n");
    const line = raw[raw.length - 1];
    // NOT asserting <= MAX_LINE_BYTES here: `scalarOnlyLine`'s minimal already
    // reduces `action`/`result` to a handful of small derived scalars, so the
    // ONLY way to force this branch (line ~284) to run at all is many distinct
    // top-level scalar keys — and those, once minimal, are already at their
    // 120-byte floor and are never re-bounded downstream (only the fixed
    // LINE_FIELDS keys are). Verified this is a PRE-EXISTING, UNRELATED gap:
    // the identical 40-field shape on a plain SERIALIZABLE line (no BigInt)
    // also persists over 3500 bytes on unpatched `main` — see the CONTROL test
    // below. Fixing that is a separate, unbounded-key-count problem (out of
    // scope here per "keep it minimal" / "don't patch a patch"); this test's
    // job is only to prove the crash is gone and the line still parses with
    // its spend carriers intact.
    const parsed = JSON.parse(line); // must not throw either
    assert.equal(parsed.action.type, "bash", "action.type must survive for the cold-start budget rebuild");
    assert.equal(parsed.result.costUsd, 0.42);
    assert.equal(parsed.result.tokens, 77);
    assert.equal(parsed.result.pricing, "priced");
  } finally { await cleanup(dir); }
});

test("audit — a circular payload that is ALSO oversize does not throw under secrets:{redactKeys:false}", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const gate = new Gate({
      tools: { allowlist: ["bash"] },
      audit: { path: auditPath },
      secrets: { redactKeys: false },
    });
    await gate.init();

    const action = { type: "bash", args: { command: "ls" } };
    action.back = action; // circular

    const fields = forceOversize({
      phase: "record",
      action,
      decision: "allow",
      rule: "x",
      result: { costUsd: 0.13, tokens: 9, pricing: "priced" },
    });
    await assert.doesNotReject(() => gate.audit.emit(fields));

    const raw = (await readFile(auditPath, "utf8")).trim().split("\n");
    const line = raw[raw.length - 1];
    // Not asserting <= MAX_LINE_BYTES — see the comment in the BigInt case
    // above; the same pre-existing, unrelated top-level-key-count gap applies.
    const parsed = JSON.parse(line);
    assert.equal(parsed.action.type, "bash", "action.type must survive for the cold-start budget rebuild");
    assert.equal(parsed.result.costUsd, 0.13);
    assert.equal(parsed.result.tokens, 9);
    assert.equal(parsed.result.pricing, "priced");
  } finally { await cleanup(dir); }
});

test("audit — negative control: a circular payload at DEFAULT config never reaches the unserializable path", async () => {
  // Proves the distinction above rather than asserting it: at default config
  // the redactor neutralises the cycle before `JSON.stringify(line)` runs, so
  // this never even exercises the catch this file is regression-testing.
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const gate = new Gate({ tools: { allowlist: ["bash"] }, audit: { path: auditPath } });
    await gate.init();

    const action = { type: "bash", args: { command: "ls" } };
    action.back = action;
    const fields = forceOversize({ phase: "record", action, decision: "allow", rule: "x", result: { costUsd: 0.1 } });
    await gate.audit.emit(fields);

    const raw = (await readFile(auditPath, "utf8")).trim().split("\n");
    const parsed = JSON.parse(raw[raw.length - 1]);
    assert.notEqual(parsed._dropped, "payload not serializable", "redaction, not the unserializable catch, must have handled this");
  } finally { await cleanup(dir); }
});

test("audit — CONTROL: the normal oversize (serializable) path is unaffected by the fix", async () => {
  // Pins that a payload which is merely LARGE, never unserializable, still
  // takes the pre-existing oversize path byte-identically: `truncated` is
  // built from `line` (the `unserializableFallback ?? line` fallback resolves
  // to `line` because the fallback is only ever set inside the catch).
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const gate = new Gate({ tools: { allowlist: ["bash"] }, audit: { path: auditPath } });
    await gate.init();

    const bigAction = { type: "bash" };
    for (let i = 0; i < 50; i++) bigAction["ka" + i] = "y".repeat(300);
    const fields = { phase: "record", action: bigAction, decision: "allow", rule: "x", result: { costUsd: 0.5, tokens: 1200, pricing: "priced" } };
    await gate.audit.emit(fields);

    const raw = (await readFile(auditPath, "utf8")).trim().split("\n");
    const parsed = JSON.parse(raw[raw.length - 1]);
    assert.equal(parsed._truncated, true);
    assert.equal(parsed._dropped, undefined, "a serializable-but-oversize line must not take the unserializable branch");
    assert.equal(parsed.action._truncated, true, "the oversize action itself should have been collapsed");
    assert.deepEqual(parsed.result, { costUsd: 0.5, tokens: 1200, pricing: "priced" });
  } finally { await cleanup(dir); }
});

test("CONTROL — ordinary actions are completely unaffected", async () => {
  const gate = new Gate({ tools: { allowlist: ["bash"] }, audit: { path: null } });
  await gate.init();
  assert.equal((await gate.check({ type: "bash", args: { command: "git status" } })).outcome, "allow");
  // and a readable dangerous action is still caught by the REAL rule, not by
  // the new one — the fix must not turn the deny floor into a blunt instrument
  const dec = await gate.check({ type: "bash", args: { command: "rm -rf /" } });
  assert.equal(dec.rule, "content.denyPatterns");
});
