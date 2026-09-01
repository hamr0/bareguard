// Regression test for the /branch-review warning at HEAD e5e96ef: `aid` was
// missing from LINE_FIELDS (src/primitives/audit.js), so a caller-supplied
// `aid` (record(action, result, { aid }) takes one with zero validation) was
// neither redacted nor re-bounded — a secret-shaped `aid` was written raw to
// disk even at DEFAULT config, where key/pattern redaction is supposed to be
// the backstop for exactly this. This branch's own thesis is that the class
// is empty (every caller-controlled string on the audit line is redacted AND
// bounded); `aid` falsified that.
//
// The load-bearing assertion for the fix is NOT just "a hostile aid gets
// redacted" — it's that a NORMAL generated aid (the 8-hex-char
// `randomUUID().slice(0,8)` `check()`/`record()` mint by default) survives
// byte-identical, so the OQ4 request<->outcome join
// (test/audit-correlation.test.js) is never broken by this fix.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

test("aid: a secret-shaped caller-supplied aid is redacted, not written raw", async () => {
  const gate = new Gate({ audit: { path: null } }); // default secrets config (key/pattern redaction ON)
  await gate.init();
  await gate.record({ type: "tool" }, { costUsd: 0.01 }, { aid: "Bearer sk-liveSECRETtoken1234567890" });
  const [line] = await gate.audit.readAll();
  assert.ok(!line.aid.includes("liveSECRETtoken"), "the secret must not appear verbatim in the persisted aid");
  assert.match(line.aid, /^\[REDACTED:pattern=/);
});

test("aid: a NORMAL generated aid survives redaction byte-identical (the OQ4 join is not broken)", async () => {
  const gate = new Gate({ audit: { path: null } }); // default secrets config (key/pattern redaction ON)
  await gate.init();
  const decision = await gate.check({ type: "tool" });
  await gate.record({ type: "tool" }, { costUsd: 0.01 }, { aid: decision.aid });
  const entries = await gate.audit.readAll();
  const gateLine = entries.find(e => e.phase === "gate");
  const recordLine = entries.find(e => e.phase === "record");
  assert.match(decision.aid, /^[0-9a-f]{8}$/, "sanity: the generated aid has the expected shape");
  assert.equal(gateLine.aid, decision.aid, "gate line's aid must be byte-identical to the minted id");
  assert.equal(recordLine.aid, decision.aid, "record line's aid must be byte-identical, preserving the OQ4 join");
});
