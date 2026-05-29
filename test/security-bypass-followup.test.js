// Regression tests for the policy-bypass findings from the v0.5.0 security
// audit, validated and fixed:
//   H1 — type confusion: a present-but-non-string path / url / cmd used to fall
//        through as "no opinion" (fail-OPEN), letting the action reach the
//        allowlist while the executor coerced it back to a real string.
//   M2 — backslash traversal: posix.normalize left `\` uncollapsed, so
//        `/scope/..\..\etc` escaped the scope on win32 (where `\` separates).
//   L1 — glob `*` (no dotAll) didn't match `\n` / `\r`, so a name with an
//        embedded line terminator slipped past a `tools.denylist` glob.
//
// (M3 — the O(n) audit-window scan — was validated as a real perf issue but its
// early-stop optimization failed correctness validation, so the full scan was
// kept; see src/audit-window.js. M1 / L2 are documented limitations.)

import test from "node:test";
import assert from "node:assert/strict";
import { Gate, globToRegex, matchAny } from "../src/index.js";
import { fsCheck } from "../src/primitives/fs.js";
import { netCheck } from "../src/primitives/net.js";
import { bashCheck } from "../src/primitives/bash.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

async function gateWith(t, cfg) {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const gate = new Gate({ audit: { path: auditPath }, ...cfg });
  await gate.init();
  return gate;
}

// ---------------------------------------------------------------------------
// H1 — type confusion in path / url / cmd
// ---------------------------------------------------------------------------

const NON_STRINGS = [
  ["array", ["/etc/passwd"]],
  ["object-with-toString", { toString: () => "/etc/passwd" }],
  ["number", 1234],
];

for (const [label, value] of NON_STRINGS) {
  test(`fs — non-string path (${label}) is denied, not waved through`, () => {
    const cfg = { writeScope: ["/tmp/agent"], deny: ["/etc"] };
    const d = fsCheck({ type: "write", path: value }, cfg);
    assert.equal(d?.outcome, "deny");
    assert.equal(d?.rule, "fs.invalidPath");
  });
}

test("fs — non-string nested args.path is denied", () => {
  const d = fsCheck({ type: "write", args: { path: ["/etc/passwd"] } }, { writeScope: ["/tmp/agent"] });
  assert.equal(d?.rule, "fs.invalidPath");
});

test("fs — absent path is still a no-op (not a deny)", () => {
  assert.equal(fsCheck({ type: "write" }, { writeScope: ["/tmp/agent"] }), null);
});

for (const [label, value] of [["array", ["http://127.0.0.1"]], ["object", { toString: () => "http://127.0.0.1" }]]) {
  test(`net — non-string url (${label}) is denied`, () => {
    const d = netCheck({ type: "fetch", url: value }, { denyPrivateIps: true, allowDomains: ["example.com"] });
    assert.equal(d?.rule, "net.invalidUrl");
  });
}

test("bash — non-string cmd is denied, not crashed, on the allow path", () => {
  // Previously `.match` / `.startsWith` on a non-string threw a TypeError.
  const d = bashCheck({ type: "bash", cmd: ["git status"] }, { allow: ["git"] });
  assert.equal(d?.rule, "bash.invalidCmd");
});

test("H1 — full Gate denies the array-path write that used to be allowed", async (t) => {
  const gate = await gateWith(t, {
    tools: { allowlist: ["write", "fetch", "bash"] },
    fs: { writeScope: ["/tmp/agent"], deny: ["/etc"] },
    net: { denyPrivateIps: true, allowDomains: ["example.com"] },
  });
  assert.equal((await gate.check({ type: "write", path: ["/etc/passwd"] })).outcome, "deny");
  assert.equal((await gate.check({ type: "write", path: { toString: () => "/etc/passwd" } })).outcome, "deny");
  assert.equal((await gate.check({ type: "fetch", url: ["http://127.0.0.1"] })).outcome, "deny");
  assert.equal((await gate.check({ type: "bash", cmd: ["rm -rf /"] })).outcome, "deny");
  // sanity: the legitimate string forms still behave as before
  assert.equal((await gate.check({ type: "write", path: "/tmp/agent/ok.txt" })).outcome, "allow");
});

// ---------------------------------------------------------------------------
// M2 — backslash traversal escapes scope
// ---------------------------------------------------------------------------

test("fs — backslash traversal is collapsed and caught by deny", () => {
  const cfg = { writeScope: ["/tmp/agent"], deny: ["/etc"] };
  const d = fsCheck({ type: "write", path: "/tmp/agent/..\\..\\etc\\passwd" }, cfg);
  assert.equal(d?.outcome, "deny");
  assert.equal(d?.rule, "fs.deny");
});

test("fs — backslash traversal that leaves writeScope is denied by scope", () => {
  const d = fsCheck({ type: "write", path: "/tmp/agent/..\\..\\var\\x" }, { writeScope: ["/tmp/agent"] });
  assert.equal(d?.outcome, "deny");
  assert.equal(d?.rule, "fs.writeScope");
});

// ---------------------------------------------------------------------------
// L1 — glob `*` must match line terminators (dotAll)
// ---------------------------------------------------------------------------

test("glob — `*` matches newline and carriage return (dotAll), closing denylist bypass", () => {
  assert.ok(globToRegex("danger*").flags.includes("s"));
  assert.equal(matchAny("danger\nous", ["danger*"]), true);
  assert.equal(matchAny("danger\rous", ["danger*"]), true);
  // normal matching unaffected
  assert.equal(matchAny("danger x", ["danger*"]), true);
  assert.equal(matchAny("safe", ["danger*"]), false);
});

test("L1 — tools.denylist catches a tool name with an embedded newline", async (t) => {
  const gate = await gateWith(t, { tools: { denylist: ["danger*"] } });
  assert.equal((await gate.check({ type: "danger\nous" })).outcome, "deny");
});
