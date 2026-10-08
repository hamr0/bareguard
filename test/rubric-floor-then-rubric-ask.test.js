import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Gate, rubricSha } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";
import { auditView } from "../src/primitives/rubric-state.js";

// Closes two "no test fails if this breaks" gaps from /branch-review (docs/product/rubric-prd.md §6 live accept).

const lines = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SPEC = { schema: 1, goal: "g", maxReds: 2, checkpoints: { a: { gating: true, requiresHuman: true, checks: [{ id: "m", rule: "mustCarry", field: "text", phrases: ["OK"] }] } } };
const cfg = { spec: SPEC, sha256: rubricSha(SPEC), advanceOn: ["done"] };

test("a FLOOR ask approved on an advance still lets the rubric raise its own live ask (two asks, one accept line, allow)", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  let asks = 0;
  const g = new Gate({
    audit: { path: auditPath }, runId, rubric: cfg,
    flags: { type: { done: "ask" } }, // the floor asks before every advance
    humanChannel: async () => { asks++; return { decision: "allow" }; },
  });
  await g.init();
  const A = await g.checkStep("a", "OK fine");
  const d = await g.check({ type: "done", checkpoint: "a", outputSha: A.outputSha });
  assert.equal(asks, 2, "floor ask, then the rubric's own ask");
  assert.equal(d.outcome, "allow");
  assert.equal(lines(auditPath).filter((l) => l.phase === "rubric_accept").length, 1);
});

test("auditView: an own __proto__ key is skipped (no prototype pollution of the copy)", () => {
  const hostile = JSON.parse('{"a":1,"__proto__":{"evil":true}}');
  const out = auditView(hostile);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.evil, undefined);
  assert.deepEqual(Object.keys(out), ["a"]);
});

test("auditView: nesting past depth 4 is cut to '[deep]'", () => {
  const deep = { l0: { l1: { l2: { l3: { l4: { l5: "x" } } } } } };
  const out = auditView(deep);
  assert.equal(out.l0.l1.l2.l3.l4, "[deep]");
  assert.equal(JSON.stringify(auditView({ l0: { l1: { l2: { l3: { l4: 1 } } } } })).includes("[deep]"), false, "depth 4 values still pass");
});
