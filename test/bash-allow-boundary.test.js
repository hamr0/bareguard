// Regression tests: bash.allow prefix matching must land on a word boundary.
//
// Reported by bare-agent, measured against installed bareguard@0.19.0:
// `Gate({ bash: { allow: ["git status"] } })` ALLOWED
// `{ type: "bash", cmd: "git statuses-are-fine --evil" }` because
// `cfg.allow.some(prefix => cmd.startsWith(prefix))` has no boundary check —
// any command that merely starts with the same bytes as an allowed prefix
// passes. The gap predates 0.19.0 (bashCheck's allow-matching hasn't changed
// shape since it was introduced).
//
// Covered here, driven through the public Gate API (bashCheck directly for
// the shellMeta/off-list negative controls that don't need a full gate):
//   - exact match; prefix + space + more (the legitimate case)
//   - prefix + tab + more (tab is whitespace, not a SHELL_META char)
//   - a Unicode-whitespace char (NBSP) right after the prefix is NOT a
//     boundary — the shell only splits words on space/tab, so this must deny
//   - same-bytes-but-no-boundary ("git statuses-are-fine") — must now deny
//   - a bare same-prefix-longer-word ("git statusx") — must deny
//   - a multi-word prefix ("npm run test" vs "npm run testing")
//   - shellMeta deny still fires before the allow check
//   - gate.allows() agrees with gate.check() on the negative
//   - an empty/whitespace-only bash.allow element is invalid config (0.19.1):
//     throws at Gate construct time, and denies bash.allow.invalid at
//     runtime for a direct bashCheck() call / a post-construction cfg swap;
//     it is no longer treated as "allow everything"

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { bashCheck } from "../src/primitives/bash.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

const NO_CONTENT = { denyPatterns: [], askPatterns: [] };

async function gateWith(t, cfg) {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const gate = new Gate({ audit: { path: auditPath }, content: NO_CONTENT, ...cfg });
  await gate.init();
  return gate;
}

test("bash.allow — exact prefix match allows", async (t) => {
  const gate = await gateWith(t, { bash: { allow: ["git status"] } });
  const d = await gate.check({ type: "bash", cmd: "git status" });
  assert.equal(d.outcome, "allow");
});

test("bash.allow — prefix followed by a space allows", async (t) => {
  const gate = await gateWith(t, { bash: { allow: ["git status"] } });
  const d = await gate.check({ type: "bash", cmd: "git status -s" });
  assert.equal(d.outcome, "allow");
});

test("bash.allow — prefix followed by a tab allows (tab is whitespace, not a shellMeta char)", async (t) => {
  const gate = await gateWith(t, { bash: { allow: ["git status"] } });
  const d = await gate.check({ type: "bash", cmd: "git status\t-s" });
  assert.equal(d.outcome, "allow");
});

test("bash.allow — a Unicode whitespace char (NBSP) is not a boundary; must deny", async (t) => {
  // The shell only splits words on ASCII space/tab; a byte like U+00A0 (NBSP)
  // sitting right after the prefix is NOT a word boundary, even though `\s`
  // would match it. `allow: ["ls"]` must not admit "ls /etc".
  const gate = await gateWith(t, { bash: { allow: ["ls"] } });
  const d = await gate.check({ type: "bash", cmd: "ls /etc" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "bash.allow");
});

test("bash.allow — NBSP after a multi-word prefix is not a boundary either; must deny", async (t) => {
  const gate = await gateWith(t, { bash: { allow: ["git status"] } });
  const d = await gate.check({ type: "bash", cmd: "git status x" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "bash.allow");
});

test("bash.allow — same bytes but no word boundary is denied (the reported bug)", async (t) => {
  const gate = await gateWith(t, { bash: { allow: ["git status"] } });
  const d = await gate.check({ type: "bash", cmd: "git statuses-are-fine --evil" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "bash.allow");
});

test("bash.allow — a longer word sharing the prefix is denied", async (t) => {
  const gate = await gateWith(t, { bash: { allow: ["git status"] } });
  const d = await gate.check({ type: "bash", cmd: "git statusx" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "bash.allow");
});

test("bash.allow — multi-word prefix: 'npm run test' does not admit 'npm run testing'", async (t) => {
  const gate = await gateWith(t, { bash: { allow: ["npm run test"] } });
  const ok = await gate.check({ type: "bash", cmd: "npm run test" });
  assert.equal(ok.outcome, "allow");
  const okArgs = await gate.check({ type: "bash", cmd: "npm run test -- --watch" });
  assert.equal(okArgs.outcome, "allow");
  const bad = await gate.check({ type: "bash", cmd: "npm run testing" });
  assert.equal(bad.outcome, "deny");
  assert.equal(bad.rule, "bash.allow");
});

test("bash.allow — shellMeta deny still fires before the boundary-checked allow match", async (t) => {
  const gate = await gateWith(t, { bash: { allow: ["git status"] } });
  const d = await gate.check({ type: "bash", cmd: "git status; rm -rf ~" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "bash.allow.shellMeta");
});

test("bash.allow — a prefix authored with a trailing space keeps its own boundary (unchanged)", async (t) => {
  // "git " already carries the boundary itself; startsWith is correct as-is
  // and needs no extra char check (documented in bash.js).
  const gate = await gateWith(t, { bash: { allow: ["git "] } });
  const ok = await gate.check({ type: "bash", cmd: "git status" });
  assert.equal(ok.outcome, "allow");
  const bad = await gate.check({ type: "bash", cmd: "gitstatus" }); // no boundary at all
  assert.equal(bad.outcome, "deny");
});

test("gate.allows() agrees with gate.check() on the negative", async (t) => {
  const gate = await gateWith(t, { bash: { allow: ["git status"] } });
  const allowed = await gate.allows({ type: "bash", cmd: "git statuses-are-fine --evil" });
  assert.equal(allowed, false);
  const allowedOk = await gate.allows({ type: "bash", cmd: "git status -s" });
  assert.equal(allowedOk, true);
});

// ---------------------------------------------------------------------------
// Direct bashCheck() unit coverage (no Gate plumbing) — the same fix, isolated.
// ---------------------------------------------------------------------------

test("bashCheck — direct: boundary enforced on a bare prefix", () => {
  const cfg = { allow: ["git status"] };
  assert.equal(bashCheck({ type: "bash", cmd: "git status" }, cfg), null);
  assert.equal(bashCheck({ type: "bash", cmd: "git status -s" }, cfg), null);
  assert.equal(bashCheck({ type: "bash", cmd: "git status\t-s" }, cfg), null);
  const denied = bashCheck({ type: "bash", cmd: "git statuses-are-fine --evil" }, cfg);
  assert.equal(denied?.outcome, "deny");
  assert.equal(denied?.rule, "bash.allow");
});

test("bashCheck — direct: an empty-string bash.allow element is invalid config, not a wildcard (0.19.1)", () => {
  // `""` no longer allows everything via `"".startsWith`; it's a runtime
  // fail-closed deny, same rule as a non-array bash.allow.
  const d = bashCheck({ type: "bash", cmd: "curl http://evil" }, { allow: [""] });
  assert.equal(d?.outcome, "deny");
  assert.equal(d?.rule, "bash.allow.invalid");
});

test("bashCheck — direct: a whitespace-only bash.allow element is invalid config too", () => {
  const d = bashCheck({ type: "bash", cmd: "ls" }, { allow: ["   "] });
  assert.equal(d?.outcome, "deny");
  assert.equal(d?.rule, "bash.allow.invalid");
});

test("bashCheck — direct: a blank element denies even when a later valid prefix would have matched", () => {
  // Fail-closed means the WHOLE list is untrustworthy once one element is
  // blank, not "skip the bad one and keep matching" — same posture as the
  // non-array / bad-element-type guards above it.
  const d = bashCheck({ type: "bash", cmd: "ls" }, { allow: ["", "ls"] });
  assert.equal(d?.outcome, "deny");
  assert.equal(d?.rule, "bash.allow.invalid");
});

test("new Gate() throws at construct time on an empty-string bash.allow element", () => {
  assert.throws(
    () => new Gate({ bash: { allow: [""] } }),
    /bash\.allow\[0\] must be a non-empty, non-whitespace command prefix/,
  );
});

test("new Gate() throws at construct time on a whitespace-only bash.allow element", () => {
  assert.throws(
    () => new Gate({ bash: { allow: ["git", "   "] } }),
    /bash\.allow\[1\] must be a non-empty, non-whitespace command prefix/,
  );
});

test("new Gate() still constructs fine with a valid bash.allow (regression)", async () => {
  const gate = new Gate({ audit: { path: null }, bash: { allow: ["git status"] } });
  await gate.init();
  const d = await gate.check({ type: "bash", cmd: "git status" });
  assert.equal(d.outcome, "allow");
});
