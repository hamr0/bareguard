import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

test("safe defaults — DROP TABLE denied without any user config", async () => {
  const gate = new Gate({});
  await gate.init();
  const dec = await gate.check({ type: "bash", cmd: "echo DROP TABLE users" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "content.denyPatterns");
});

test("safe defaults — rm -rf / denied without any user config", async () => {
  const gate = new Gate({});
  await gate.init();
  const dec = await gate.check({ type: "bash", cmd: "rm -rf /home/user" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "content.denyPatterns");
});

test("safe defaults — TRUNCATE TABLE denied", async () => {
  const gate = new Gate({});
  await gate.init();
  const dec = await gate.check({ type: "bash", cmd: "psql -c 'TRUNCATE TABLE accounts'" });
  assert.equal(dec.outcome, "deny");
});

test("safe defaults — destructive verbs trigger ask, no humanChannel → deny+halt", async () => {
  const gate = new Gate({});
  await gate.init();
  const dec = await gate.check({ type: "fetch", url: "https://api.x/delete-account/123" });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.severity, "halt");
  assert.equal(dec.rule, "content.askPatterns");
  assert.match(dec.reason, /no humanChannel registered/);
});

test("safe defaults — humanChannel approves the destructive verb", async () => {
  const channel = async (event) => {
    assert.equal(event.kind, "ask");
    assert.equal(event.rule, "content.askPatterns");
    return { decision: "allow", reason: "operator approved deletion of user 123" };
  };
  const gate = new Gate({ humanChannel: channel });
  await gate.init();
  const dec = await gate.check({ type: "fetch", url: "https://api.x/delete-account/123" });
  assert.equal(dec.outcome, "allow");
  assert.equal(dec.rule, "humanChannel.allow");
});

test("safe defaults — overridable with empty patterns", async () => {
  const gate = new Gate({
    content: { denyPatterns: [], askPatterns: [] },
  });
  await gate.init();
  const dec = await gate.check({ type: "bash", cmd: "echo DROP TABLE users" });
  // user has explicitly disabled safe defaults; no other rule fires
  assert.equal(dec.outcome, "allow");
  assert.equal(dec.rule, "default");
});
