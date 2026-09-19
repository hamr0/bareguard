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

test("CONTROL — ordinary actions are completely unaffected", async () => {
  const gate = new Gate({ tools: { allowlist: ["bash"] }, audit: { path: null } });
  await gate.init();
  assert.equal((await gate.check({ type: "bash", args: { command: "git status" } })).outcome, "allow");
  // and a readable dangerous action is still caught by the REAL rule, not by
  // the new one — the fix must not turn the deny floor into a blunt instrument
  const dec = await gate.check({ type: "bash", args: { command: "rm -rf /" } });
  assert.equal(dec.rule, "content.denyPatterns");
});
