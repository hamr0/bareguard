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

// Every bound in the oversize-truncation block is a BYTE bound — the line cap
// it feeds is measured in bytes because POSIX PIPE_BUF is. But the block cut
// with `String.prototype.slice`, which counts UTF-16 CODE UNITS, and `result`'s
// guard read `.length`, a code-unit COUNT. Measured before the fix: a `reason`
// of 5000 CJK characters persisted at 611 bytes against a claimed 211-byte
// bound (2.9x), astral emoji at 411 (1.9x), and a 200-character CJK `result`
// value (600 bytes) was not truncated AT ALL. Neither breached MAX_LINE_BYTES
// on its own — the wholesale-collapse stage re-bounds the line regardless — but
// the per-field guarantee the code and CHANGELOG stated was false, and the
// margin it silently ate is the margin the next forgotten field will need.
const BOUND = 200 + "[TRUNCATED]".length; // 211

for (const [name, fill] of [["CJK (3 bytes/char)", "中"], ["astral emoji (4 bytes, 2 UTF-16 units)", "\u{1F4A5}"]]) {
  test(`audit: reason is bounded in BYTES, not UTF-16 units — ${name}`, async (t) => {
    const { entry } = await lastLine(t, { tools: { allowlist: ["zzz"] } }, { type: fill.repeat(5000) });
    const bytes = Buffer.byteLength(entry.reason, "utf8");
    assert.ok(bytes <= BOUND, `reason is ${bytes} bytes, bound is ${BOUND}`);
    assert.ok(entry.reason.endsWith("[TRUNCATED]"), "a cut value must say so");
  });
}

test("audit: a multi-byte RESULT string is bounded — its guard counted code units, not bytes", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath = path.join(dir, "audit.jsonl");
  const gate = new Gate({ audit: { path: auditPath } });
  await gate.init();
  // 200 CJK chars = 600 bytes: `.length > 200` is FALSE, so this was never cut.
  // Padded with a second wide key so the line trips the oversize path at all.
  await gate.record({ type: "bash", cmd: "ls" },
    { text: "中".repeat(200), pad: "x".repeat(MAX_LINE_BYTES) });
  const entry = JSON.parse(fs.readFileSync(auditPath, "utf8").trim().split("\n").pop());
  if (typeof entry.result?.text === "string") {
    const bytes = Buffer.byteLength(entry.result.text, "utf8");
    assert.ok(bytes <= BOUND, `result.text is ${bytes} bytes, bound is ${BOUND}`);
  }
});

test("audit: where and verdict are bounded in bytes when the line is oversize", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath = path.join(dir, "audit.jsonl");
  // gate.annotate caps `where`/`verdict` at the SOURCE in UTF-16 units, so CJK
  // alone lands at 900 bytes and never trips the line cap. The re-bound under
  // test only fires on an OVERSIZE line, so drive it the way the field actually
  // gets there in practice: redaction expanding an already-legal value.
  const gate = new Gate({ audit: { path: auditPath }, secrets: { patterns: [/\u4e2d/, /E/, /D/] } });
  await gate.init();
  await gate.annotate({ surface: true, verdict: "\u4e2d".repeat(300), where: "\u4e2d".repeat(300) });
  let exercised = false;
  for (const raw of fs.readFileSync(auditPath, "utf8").trim().split("\n")) {
    const e = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw, "utf8") <= MAX_LINE_BYTES,
      `line is ${Buffer.byteLength(raw, "utf8")} bytes`);
    if (!e._truncated) continue;
    exercised = true;
    for (const f of ["where", "verdict"]) {
      if (typeof e[f] !== "string") continue;
      const bytes = Buffer.byteLength(e[f], "utf8");
      assert.ok(bytes <= BOUND, `${f} is ${bytes} bytes, bound is ${BOUND}`);
    }
  }
  assert.ok(exercised, "no line hit the oversize path — this test asserted nothing");
});

// Probe the threshold itself, not just one value far past it: a byte-safe cut
// must not start cutting values that were always legal.
test("audit: the byte bound is exact at the boundary — under keeps, over cuts", async (t) => {
  // ASCII, so bytes == code units and the boundary is unambiguous.
  for (const [label, len, cut] of [["under (199)", 199, false], ["at (200)", 200, false], ["over (201)", 201, true]]) {
    const { entry } = await lastLine(t, { tools: { allowlist: ["zzz"] } },
      { type: "T".repeat(len), pad: "x".repeat(MAX_LINE_BYTES) });
    // reason embeds the type, so isolate on the action field the loop bounds.
    const v = entry.action.type;
    if (typeof v !== "string") continue; // collapsed wholesale; not this test's subject
    assert.equal(v.endsWith("[TRUNCATED]"), cut, `${label}: got ${Buffer.byteLength(v, "utf8")} bytes`);
  }
});

// `reason` was the one LINE_FIELDS row no test held down. Dropping it kept the
// suite green (295/295) because the third, generic backstop re-bounds every
// scalar independently, so the LINE still fit — but that stage pays for it by
// dropping the object payloads wholesale: `action` disappeared from the record
// entirely and the line was stamped `_dropped`. An audit entry that no longer
// says WHAT was denied is a real loss, and "the line fits" was never the whole
// guarantee. This pins the degradation, not just the byte count.
test("audit: an oversize reason is bounded at its OWN stage — the last resort must not fire", async (t) => {
  const { entry } = await lastLine(t, { tools: { allowlist: ["zzz"] } },
    { type: "T".repeat(4000), cmd: "ls -la" });

  assert.ok(Buffer.byteLength(entry.reason, "utf8") <= BOUND,
    `reason is ${Buffer.byteLength(entry.reason, "utf8")} bytes, bound is ${BOUND}`);
  assert.equal(entry._dropped, undefined,
    "bounding `reason` must be enough — falling through to the scalar-only backstop costs the payload");
  assert.ok(entry.action, "the audit line must still record WHAT was denied");
  assert.equal(entry.rule, "tools.allowlist.exclusive", "and under which rule");
});
