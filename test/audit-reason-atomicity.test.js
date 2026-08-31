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
