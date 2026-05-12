// v0.4.1 — bash / fs / net primitives accept either flat (action.cmd /
// action.path / action.url) or nested (action.args.cmd|command|path|url)
// shapes so wireGate-style {type, args, _ctx} adapters compose without a
// translation layer.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

// ────────────────────────────────────────────────────────────────────────
// bash
// ────────────────────────────────────────────────────────────────────────

test("bash — nested action.args.cmd is honored by bash.allow", async () => {
  const gate = new Gate({
    audit: { path: null },
    bash:  { allow: ["git", "ls"] },
  });
  await gate.init();
  // wireGate-style shape: {type, args, _ctx}, no flat .cmd
  const dec = await gate.check({ type: "bash", args: { cmd: "git status" }, _ctx: { chatId: "c1" } });
  assert.equal(dec.outcome, "allow", "git matches bash.allow via args.cmd");
});

test("bash — nested action.args.command (alternate spelling) is honored", async () => {
  const gate = new Gate({
    audit: { path: null },
    bash:  { allow: ["echo"] },
  });
  await gate.init();
  // Some MCP shell wrappers use `command` instead of `cmd`.
  const dec = await gate.check({ type: "bash", args: { command: "echo hi" } });
  assert.equal(dec.outcome, "allow");
});

test("bash — nested args.cmd outside allowlist denies via bash.allow", async () => {
  const gate = new Gate({
    audit: { path: null },
    bash:  { allow: ["git"] },
  });
  await gate.init();
  const dec = await gate.check({ type: "bash", args: { cmd: "rm somefile" } });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "bash.allow");
});

test("bash — flat action.cmd still works (regression)", async () => {
  const gate = new Gate({
    audit: { path: null },
    bash:  { allow: ["git"] },
  });
  await gate.init();
  const dec = await gate.check({ type: "bash", cmd: "git status" });
  assert.equal(dec.outcome, "allow");
});

test("bash — flat .cmd wins over nested args.cmd when both present", async () => {
  // If a caller sets both (unusual but possible), flat is authoritative.
  const gate = new Gate({
    audit: { path: null },
    bash:  { allow: ["git"] },
  });
  await gate.init();
  const dec = await gate.check({ type: "bash", cmd: "git pull", args: { cmd: "rm -rf" } });
  assert.equal(dec.outcome, "allow", "flat .cmd takes precedence");
});

// ────────────────────────────────────────────────────────────────────────
// fs
// ────────────────────────────────────────────────────────────────────────

test("fs — nested action.args.path is honored by fs.readScope", async () => {
  const gate = new Gate({
    audit: { path: null },
    fs:    { readScope: ["/tmp/agent"] },
  });
  await gate.init();
  const decAllow = await gate.check({ type: "read", args: { path: "/tmp/agent/file.txt" } });
  assert.equal(decAllow.outcome, "allow");

  const decDeny = await gate.check({ type: "read", args: { path: "/etc/passwd" } });
  assert.equal(decDeny.outcome, "deny");
  assert.equal(decDeny.rule, "fs.readScope");
});

test("fs — nested action.args.path is honored by fs.deny", async () => {
  const gate = new Gate({
    audit: { path: null },
    fs:    { deny: ["/etc"], readScope: ["/etc"] },
  });
  await gate.init();
  // Scoped to /etc but explicitly denied — deny wins
  const dec = await gate.check({ type: "read", args: { path: "/etc/passwd" } });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "fs.deny");
});

test("fs — flat action.path still works (regression)", async () => {
  const gate = new Gate({
    audit: { path: null },
    fs:    { writeScope: ["/tmp"] },
  });
  await gate.init();
  const dec = await gate.check({ type: "write", path: "/tmp/foo.txt" });
  assert.equal(dec.outcome, "allow");
});

// ────────────────────────────────────────────────────────────────────────
// net
// ────────────────────────────────────────────────────────────────────────

test("net — nested action.args.url is honored by net.allowDomains", async () => {
  const gate = new Gate({
    audit: { path: null },
    net:   { allowDomains: ["api.example.com"] },
  });
  await gate.init();
  const decAllow = await gate.check({ type: "fetch", args: { url: "https://api.example.com/v1" } });
  assert.equal(decAllow.outcome, "allow");

  const decDeny = await gate.check({ type: "fetch", args: { url: "https://evil.example.org/x" } });
  assert.equal(decDeny.outcome, "deny");
  assert.equal(decDeny.rule, "net.allowDomains");
});

test("net — nested args.url honored by net.denyPrivateIps", async () => {
  const gate = new Gate({
    audit: { path: null },
    net:   { denyPrivateIps: true },
  });
  await gate.init();
  const dec = await gate.check({ type: "fetch", args: { url: "http://10.0.0.1/x" } });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "net.denyPrivateIps");
});

test("net — flat action.url still works (regression)", async () => {
  const gate = new Gate({
    audit: { path: null },
    net:   { allowDomains: ["api.example.com"] },
  });
  await gate.init();
  const dec = await gate.check({ type: "fetch", url: "https://api.example.com/v1" });
  assert.equal(dec.outcome, "allow");
});
