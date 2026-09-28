// `action.tool` identity (0.19.0), agreed with bare-agent. Ported from the
// throwaway fs-contract-poc's `tool-identity-matrix.mjs` (14 rows), exercised
// through the real shipped `tools.js`/`rwx.js`/`gate.js`.
//
// All rows use `type: "search"/"custom"/"bash"` (not `read`/`write`) so the
// fs primitive's deny-by-default never masks the tools/rwx logic under test;
// one dedicated row proves the fs kind-check still keys off `type` alone.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { toolsDenylistCheck, toolsAllowlistCheck } from "../src/primitives/tools.js";
import { rwxCheck, matchRwxLetter } from "../src/primitives/rwx.js";

// ---------------------------------------------------------------------------
// tools.allowlist / tools.denylist
// ---------------------------------------------------------------------------

test("tools.allowlist: no `tool` field is byte-identical to today's `type`-only behavior", () => {
  const allow = toolsAllowlistCheck({ type: "search" }, { allowlist: ["search"] });
  assert.equal(allow.outcome, "allow");
  const deny = toolsAllowlistCheck({ type: "custom" }, { allowlist: ["search"] });
  assert.equal(deny.outcome, "deny");
});

test("tools.allowlist: identity resolves via `tool` when present", () => {
  const d = toolsAllowlistCheck({ type: "search", tool: "shell_read" }, { allowlist: ["shell_read"] });
  assert.equal(d.outcome, "allow");
});

test("tools.allowlist: once `tool` is present, `type` alone no longer matches the allow side", () => {
  const d = toolsAllowlistCheck({ type: "search", tool: "shell_read" }, { allowlist: ["search"] });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "tools.allowlist.exclusive");
});

test("tools.denylist: matches on `type` alone when no `tool` is present", () => {
  const d = toolsDenylistCheck({ type: "custom" }, { denylist: ["custom"] });
  assert.equal(d.outcome, "deny");
});

test("tools.denylist: a denylisted `tool` denies even though `type` differs (deny widens, never loosens)", () => {
  const d = toolsDenylistCheck({ type: "custom", tool: "shell_write" }, { denylist: ["shell_write"] });
  assert.equal(d.outcome, "deny");
});

test("tools.denylist: `type` still denies even when `tool` is present and different", () => {
  const d = toolsDenylistCheck({ type: "custom", tool: "shell_write" }, { denylist: ["custom"] });
  assert.equal(d.outcome, "deny");
});

test("tools.denylist: no `tool` at all, denylist keyed by a tool name that never matches — allows through this check", () => {
  const d = toolsDenylistCheck({ type: "custom" }, { denylist: ["shell_write"] });
  assert.equal(d, null);
});

// ---------------------------------------------------------------------------
// rwx tools map
// ---------------------------------------------------------------------------

const RWX = {
  agent: "fixer",
  agents: { fixer: "rw-" },
  tools: { shell_read: "r" },
};

test("rwx: tools map keyed by `tool` — action carries `tool`, row found via identity", () => {
  const d = rwxCheck({ type: "search", tool: "shell_read" }, RWX);
  assert.equal(d.outcome, "allow");
  assert.equal(d.rule, "rwx.allow");
});

test("rwx: same map, action has only `type`, no `tool` — falls back to `type`, still unlisted", () => {
  const d = rwxCheck({ type: "search" }, RWX);
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.unlisted");
});

// ---------------------------------------------------------------------------
// fs kind check stays on `type` regardless of `tool`
// ---------------------------------------------------------------------------

test("fs kind check stays on `type`: write with a matching `tool` allowlist entry and an in-scope path allows", async (t) => {
  const dir = "/tmp";
  const gate = new Gate({
    audit: { path: null },
    tools: { allowlist: ["shell_write"] },
    fs: { writeScope: [dir] },
  });
  await gate.init();
  const d = await gate.check({ type: "write", tool: "shell_write", path: `${dir}/probe-fs-kind.txt` });
  assert.equal(d.outcome, "allow");
});

test("fs kind check stays on `type`: `tool` has no bearing on an out-of-scope path", async (t) => {
  const gate = new Gate({
    audit: { path: null },
    tools: { allowlist: ["shell_write"] },
    fs: { writeScope: ["/tmp"] },
  });
  await gate.init();
  const d = await gate.check({ type: "write", tool: "shell_write", path: "/etc/passwd" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "fs.writeScope");
});

test("bash kind check stays on `type`: `tool` is irrelevant to the content deny floor", async (t) => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const d = await gate.check({ type: "bash", tool: "shell_run", cmd: "rm -rf /" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "content.denyPatterns");
});

// ---------------------------------------------------------------------------
// action.tool validation: bad values fail closed
// ---------------------------------------------------------------------------

test("action.tool: a number denies via tools.invalidTool", () => {
  const d = toolsAllowlistCheck({ type: "search", tool: 42 }, { allowlist: ["search"] });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "tools.invalidTool");
});

test("action.tool: an empty string denies via tools.invalidTool", () => {
  const d = toolsAllowlistCheck({ type: "search", tool: "" }, { allowlist: ["search"] });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "tools.invalidTool");
});

test("action.tool: null is treated as absent, falls back to `type`", () => {
  const d = toolsAllowlistCheck({ type: "search", tool: null }, { allowlist: ["search"] });
  assert.equal(d.outcome, "allow");
});

test("action.tool: a bad value denies via tools.invalidTool under rwx mode too (one shared rule, not two)", () => {
  const d = rwxCheck({ type: "search", tool: 42 }, RWX);
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "tools.invalidTool");
});

test("action.tool: matchRwxLetter (accrual-only, never denies) falls back to `type` on a bad `tool`", () => {
  const letter = matchRwxLetter({ type: "search", tool: 42 }, RWX);
  assert.equal(letter, null); // 'search' isn't in the map either — but the point is it never throws and never uses the bad value
  const letter2 = matchRwxLetter({ type: "search", tool: 42 }, { tools: { search: "r" } });
  assert.equal(letter2, "r", "falls back to type when tool is unusable");
});
