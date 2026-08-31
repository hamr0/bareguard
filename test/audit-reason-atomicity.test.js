// `reason` is redacted (audit.js) but was never re-bounded by the oversize
// truncation fallback, so a caller-controlled value interpolated into a rule's
// reason string could blow the MAX_LINE_BYTES cap that exists to keep an
// O_APPEND write atomic on POSIX — while the line still claimed
// `_truncated: true`. Same family as the 0.13.0 `verdict` breach, different
// field: every rule that echoes caller data into `reason` reaches it, and no
// secrets config is needed (redaction only amplifies what is already unbounded).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Gate } from "../src/index.js";
import { makeTmpDir, cleanup } from "./_helpers.js";

const MAX_LINE_BYTES = 3500; // audit.js

async function lastLine(t, cfg, action) {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath = path.join(dir, "audit.jsonl");
  const gate = new Gate({ ...cfg, audit: { path: auditPath } });
  await gate.init();
  await gate.check(action);
  const raw = fs.readFileSync(auditPath, "utf8").trim().split("\n").pop();
  return { raw, bytes: Buffer.byteLength(raw, "utf8"), entry: JSON.parse(raw) };
}

test("audit: a caller-controlled `reason` cannot exceed the atomic-append cap", async (t) => {
  const BIG = "a".repeat(300);
  // one case per primitive that interpolates caller data into `reason`
  const cases = [
    ["tools.allowlist.exclusive", { tools: { allowlist: ["zzz"] } },    { type: BIG }],
    ["tools.denylist",            { tools: { denylist: ["*"] } },       { type: BIG }],
    ["fs.readScope",              { fs: { readScope: ["/nope"] } },     { type: "read", path: "/" + BIG }],
    ["fs.deny",                   { fs: { deny: ["/x"] } },             { type: "read", path: "/x/" + BIG }],
    ["net.invalidUrl",            { net: { allowDomains: ["z.com"] } }, { type: "fetch", url: "not-a-url-" + BIG }],
    ["flags.<field>",             { flags: { prov: { [BIG]: "deny" } } }, { type: "x", prov: BIG }],
  ];

  for (const [label, cfg, action] of cases) {
    // a broad pattern makes redaction EXPAND the reason, the amplifier that
    // turned an 80-char verdict into 63 KB in 0.13.0
    const { bytes, entry } = await lastLine(t, { ...cfg, secrets: { patterns: [/a/] } }, action);
    assert.ok(bytes <= MAX_LINE_BYTES,
      `${label}: persisted line is ${bytes} bytes, over the ${MAX_LINE_BYTES} cap`);
    assert.equal(entry._truncated, true, `${label}: an oversize line must be flagged`);
  }
});

test("audit: the cap holds at DEFAULT config — no secrets config required", async (t) => {
  // redaction only amplifies; `reason` is unbounded at the source, so a long
  // caller-controlled value alone is enough with zero secrets configuration.
  const { bytes } = await lastLine(t, { tools: { allowlist: ["zzz"] } }, { type: "a".repeat(4000) });
  assert.ok(bytes <= MAX_LINE_BYTES, `default config produced ${bytes} bytes`);
});

test("audit: the cap holds under compounding redaction", async (t) => {
  // redaction runs pattern-by-pattern over ALREADY-redacted text, so a later
  // pattern matching the marker an earlier one inserted multiplies the field.
  const { bytes } = await lastLine(t,
    { tools: { allowlist: ["zzz"] }, secrets: { patterns: [/a/, /E/, /D/] } },
    { type: "a".repeat(300) });
  assert.ok(bytes <= MAX_LINE_BYTES, `compounding redaction produced ${bytes} bytes`);
});

test("audit: a short reason is preserved verbatim — the bound must not over-truncate", async (t) => {
  const { entry } = await lastLine(t, { tools: { allowlist: ["zzz"] } }, { type: "wireMoney" });
  assert.equal(entry.reason, "wireMoney not in allowlist");
  assert.ok(!entry._truncated, "a small line must not be flagged as truncated");
});

test("audit: the humanChannel-threw reason path is bounded too", async (t) => {
  // `reason` is re-bounded by FIELD NAME, so gate.js's own reason producers are
  // covered generically — but the fix's genericity is a claim, not a test, so
  // exercise the one gate.js path that interpolates an unbounded caller value
  // (`humanChannel threw: ${err.message}`) end to end.
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath = path.join(dir, "audit.jsonl");
  const gate = new Gate({
    content: { askPatterns: [/./] },
    secrets: { patterns: [/a/, /E/, /D/] },
    humanChannel: async () => { throw new Error("a".repeat(3000)); },
    audit: { path: auditPath },
  });
  await gate.init();
  const d = await gate.check({ type: "bash", cmd: "ls" });
  assert.equal(d.outcome, "deny", "a throwing humanChannel must fail closed");

  for (const raw of fs.readFileSync(auditPath, "utf8").trim().split("\n")) {
    assert.ok(Buffer.byteLength(raw, "utf8") <= MAX_LINE_BYTES,
      `audit line is ${Buffer.byteLength(raw, "utf8")} bytes, over the ${MAX_LINE_BYTES} cap`);
  }
});

// The per-field bound is not a line bound. `action`/`result` are truncated
// PER KEY (each value capped at 200 bytes), so an object with many small keys
// passes every per-key check and still blows MAX_LINE_BYTES — 200 keys x 190
// bytes measured at 40,197 bytes, stamped `_truncated: true`. `meta` was never
// vulnerable because it collapses the WHOLE object once its total exceeds 200.
// The guarantee is about the LINE, so the backstop has to be on the line.

test("audit: many small keys cannot blow the cap — the bound is on the LINE, not per field", async (t) => {
  const wide = { type: "bash" };
  for (let i = 0; i < 200; i++) wide["k" + i] = "v".repeat(190);
  const { bytes, entry } = await lastLine(t, { tools: { allowlist: ["zzz"] } }, wide);
  assert.ok(bytes <= MAX_LINE_BYTES, `wide action produced ${bytes} bytes`);
  assert.equal(entry._truncated, true);

  // Degrade as little as necessary: the payload collapses to a SUMMARY carrying
  // its real size, rather than being dropped from the line. Without the
  // wholesale-collapse pass the last-resort path would fire instead and the
  // action would vanish entirely, which is a strictly worse audit record.
  assert.equal(entry.action._truncated, true);
  assert.ok(entry.action.bytes > MAX_LINE_BYTES,
    "the collapsed action must report the size it would have been");
  assert.equal(entry._dropped, undefined,
    "the last-resort path must not fire when collapsing the payload is enough");
  assert.ok(entry.reason, "a diagnostic reason must survive payload collapse");
});

test("audit: a wide RESULT object is bounded too", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath = path.join(dir, "audit.jsonl");
  const gate = new Gate({ audit: { path: auditPath } });
  await gate.init();
  const result = {};
  for (let i = 0; i < 200; i++) result["k" + i] = "v".repeat(190);
  await gate.record({ type: "bash", cmd: "ls" }, result);
  for (const raw of fs.readFileSync(auditPath, "utf8").trim().split("\n")) {
    assert.ok(Buffer.byteLength(raw, "utf8") <= MAX_LINE_BYTES,
      `line is ${Buffer.byteLength(raw, "utf8")} bytes`);
  }
});

test("audit: even a pathological action stays under the cap and keeps its routing fields", async (t) => {
  // deep nesting + many keys + multi-byte characters (byte length, not UTF-16)
  const nasty = { type: "bash" };
  for (let i = 0; i < 500; i++) nasty["\u{1F4A5}key" + i] = { a: "é".repeat(100), b: { c: "x".repeat(100) } };
  const { bytes, entry } = await lastLine(t, { tools: { allowlist: ["zzz"] } }, nasty);
  assert.ok(bytes <= MAX_LINE_BYTES, `pathological action produced ${bytes} bytes`);
  // the line must remain useful: identity and routing survive whatever is dropped
  assert.equal(entry.rule, "tools.allowlist.exclusive");
  assert.equal(entry.decision, "deny");
  assert.ok(entry.run_id, "run_id must survive");
  assert.ok(entry.ts, "ts must survive");
  assert.equal(typeof entry.seq, "number", "seq must survive");
  assert.ok(entry.aid, "aid must survive — it is what joins request to outcome");
});

test("audit: a normal small line is still untouched by the line backstop", async (t) => {
  const { entry, bytes } = await lastLine(t, { tools: { allowlist: ["zzz"] } },
    { type: "bash", cmd: "ls -la" });
  assert.ok(!entry._truncated, "a small line must not be flagged");
  assert.deepEqual(entry.action, { type: "bash", cmd: "ls -la" }, "action must survive verbatim");
  assert.ok(bytes < 1000);
});

// The wholesale payload collapse writes `{_truncated, bytes}` in place of the
// action — which drops `action.type`. `_rebuildBudgetFromAudit` classifies a
// historical round with `l.action.type !== "llm"`, so a collapsed llm round
// reads as `undefined !== "llm"` and is rebuilt as a TOOL round. That is
// exactly the live-vs-cold-start divergence 0.9.0 closed by construction with
// `sanitizeSpend`, reopened on the toolRounds dimension by the line backstop.
// It over-counts (fails safe) but it still makes the two paths disagree.
test("audit: payload collapse keeps action.type — live and cold-start toolRounds cannot diverge", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath = path.join(dir, "audit.jsonl");

  const wide = { type: "llm" };
  for (let i = 0; i < 200; i++) wide["k" + i] = "v".repeat(190);

  const live = new Gate({ audit: { path: auditPath }, limits: { maxToolRounds: 50 } });
  await live.init();
  await live.record(wide, { costUsd: 0.01, tokens: 10 });

  const raw = fs.readFileSync(auditPath, "utf8").trim().split("\n").pop();
  assert.ok(Buffer.byteLength(raw, "utf8") <= MAX_LINE_BYTES,
    `line is ${Buffer.byteLength(raw, "utf8")} bytes`);
  const entry = JSON.parse(raw);
  assert.equal(entry.action._truncated, true,
    "precondition: this action must be wide enough to trip the wholesale collapse");
  assert.equal(entry.action.type, "llm",
    "the one field the budget rebuild classifies on must survive the collapse");

  const cold = new Gate({ audit: { path: auditPath }, limits: { maxToolRounds: 50 } });
  await cold.init();
  assert.equal(cold.limits.toolRounds, live.limits.toolRounds,
    `cold start rebuilt ${cold.limits.toolRounds} tool rounds, live counted ${live.limits.toolRounds}`);
});

test("audit: a collapsed action.type is itself bounded — it is caller-controlled", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath = path.join(dir, "audit.jsonl");
  // multi-byte, so a UTF-16 slice would under-count the bytes it costs
  const wide = { type: "\u{1F4A5}".repeat(4000) };
  for (let i = 0; i < 200; i++) wide["k" + i] = "v".repeat(190);
  const gate = new Gate({ audit: { path: auditPath } });
  await gate.init();
  await gate.record(wide, { costUsd: 0.01 });
  for (const line of fs.readFileSync(auditPath, "utf8").trim().split("\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES,
      `line is ${Buffer.byteLength(line, "utf8")} bytes`);
  }
});
