import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

test("eval order — first match wins across all 6 steps", async (t) => {
  const dir = await makeTmpDir();
  t.after(async () => cleanup(dir));

  const { auditPath } = uniquePaths(dir);
  const gate = new Gate({
    audit:  { path: auditPath },
    bash:   { allow: ["git", "ls"], denyPatterns: [/sudo/] },
    fs:     { writeScope: ["/tmp/agent"], readScope: ["/tmp"], deny: ["/etc/passwd"] },
    net:    { allowDomains: ["api.example.com"], denyPrivateIps: true },
    tools:  {
      allowlist: ["bash", "read", "fetch", "spawn"],
      denylist:  ["mcp:*/admin_*"],
      denyArgPatterns: { "fetch": [/"force":\s*true/] },
    },
    content: {
      // explicit, not safe defaults
      denyPatterns: [/\bDROP\s+TABLE\b/i],
      askPatterns:  [/\bdelete\b/i],
    },
    limits: { maxTurns: 100 },
    humanChannel: async () => ({ decision: "allow" }),
  });
  await gate.init();

  const cases = [
    // step 1: tools.denylist
    { label: "denylist",         action: { type: "mcp:foo/admin_revoke" }, expect: { outcome: "deny",  rule: "tools.denylist" } },
    // step 2: content.denyPatterns
    { label: "content.deny",     action: { type: "bash", cmd: "echo DROP TABLE x" }, expect: { outcome: "deny", rule: "content.denyPatterns" } },
    // step 3: per-action-type
    { label: "bash.denyPatterns",action: { type: "bash", cmd: "sudo reboot" },  expect: { outcome: "deny", rule: "bash.denyPatterns" } },
    { label: "bash.allow",       action: { type: "bash", cmd: "curl evil" },    expect: { outcome: "deny", rule: "bash.allow" } },
    { label: "fs.deny",          action: { type: "read", path: "/etc/passwd" }, expect: { outcome: "deny", rule: "fs.deny" } },
    { label: "fs.readScope",     action: { type: "read", path: "/var/x" },      expect: { outcome: "deny", rule: "fs.readScope" } },
    { label: "fs.writeScope",    action: { type: "write", path: "/etc/x", content: "" }, expect: { outcome: "deny", rule: "fs.writeScope" } },
    { label: "net.allowDomains", action: { type: "fetch", url: "https://evil.com/x" },   expect: { outcome: "deny", rule: "net.allowDomains" } },
    { label: "net.denyPrivateIps", action: { type: "fetch", url: "http://192.168.1.1" }, expect: { outcome: "deny", rule: "net.denyPrivateIps" } },
    { label: "tools.denyArgPatterns", action: { type: "fetch", url: "https://api.example.com/x", args: { force: true } }, expect: { outcome: "deny", rule: "tools.denyArgPatterns" } },
    // step 4: askPatterns. Note: humanChannel returns allow, so terminal allow with rule humanChannel.allow.
    { label: "ask → allow",      action: { type: "fetch", url: "https://api.example.com/delete-me" }, expect: { outcome: "allow", rule: "humanChannel.allow" } },
    // step 5: tools.allowlist scope
    { label: "allowlist allow",  action: { type: "bash", cmd: "git status" }, expect: { outcome: "allow", rule: "tools.allowlist" } },
    { label: "allowlist exclusive", action: { type: "unknown_tool" }, expect: { outcome: "deny", rule: "tools.allowlist.exclusive" } },
  ];

  for (const c of cases) {
    const dec = await gate.check(c.action);
    assert.equal(dec.outcome, c.expect.outcome, `${c.label}: outcome`);
    assert.equal(dec.rule,    c.expect.rule,    `${c.label}: rule`);
  }
});

test("eval order — askPatterns fire even on allowlisted tools (v0.5 §4)", async () => {
  const gate = new Gate({
    tools:   { allowlist: ["fetch"] },
    content: { askPatterns: [/\bdelete\b/i] },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  const dec = await gate.check({ type: "fetch", url: "https://x/delete-account" });
  // With askPatterns at step 4 BEFORE allowlist at step 5, ask must fire.
  // humanChannel returns deny → terminal deny with the original ask rule.
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "content.askPatterns");
});

test("eval order — default allow when allowlist unset and nothing else fires", async () => {
  const gate = new Gate({
    bash: { allow: ["git", "ls"] },
  });
  await gate.init();
  const dec = await gate.check({ type: "fetch", url: "https://x.com" });
  assert.equal(dec.outcome, "allow");
  assert.equal(dec.rule, "default");
});

test("severity field is present on every decision", async () => {
  const gate = new Gate({
    tools: { denylist: ["bad"] },
    budget: { maxCostUsd: 0.01 },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  const d1 = await gate.check({ type: "bad" });
  assert.equal(d1.severity, "action");
  await gate.record({ type: "ok" }, { costUsd: 0.05, tokens: 0 });
  const d2 = await gate.check({ type: "ok" });
  assert.equal(d2.severity, "halt"); // budget exceeded → halt source preserved through deny
});
