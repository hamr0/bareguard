// rwx bash-map matching: word-boundary behavior, and its known limit vs
// bash.allow (0.19.1 follow-up).
//
// c241df1 switched matchBash's leading-word match from a literal-space-only
// check (`cmd === key || cmd.startsWith(key + " ")`) to the shared
// `startsWithWordBoundary` helper bash.allow uses (word-boundary.js), so a
// tab-separated command ("git\tstatus") would match like "git status" would.
// That helper's "prefix already ends in whitespace -> true" shortcut turned
// out to widen matching much further than intended: a TRAILING-WHITESPACE
// rwx key (e.g. `{"rm ": "x"}`, `{"": "r"}`) started matching almost any
// command with that prefix, regardless of what followed the space. That
// change was reverted before ever shipping — matchBash is back to the
// original literal-space check. rwx bash matching now KNOWINGLY splits on a
// space only; a tab-separated command is denied `rwx.unlisted` (fail-safe
// over-deny, not a leak). `bash.allow` is unaffected — it still uses
// `startsWithWordBoundary` and still accepts space OR tab.

import test from "node:test";
import assert from "node:assert/strict";
import { matchBash } from "../src/primitives/rwx.js";
import { Gate } from "../src/index.js";

test("rwx bash boundary: a tab between leading words does NOT match (known limit, space-only)", () => {
  const m = matchBash("git\tstatus", { git: "r" });
  assert.equal(m.ok, false);
});

test("rwx bash boundary: a plain space still matches (unchanged)", () => {
  const m = matchBash("git status", { git: "r" });
  assert.equal(m.ok, true);
  assert.equal(m.letter, "r");
});

test("rwx bash boundary: a bare prefix collision (gitx) does not match git", () => {
  const m = matchBash("gitx", { git: "r" });
  assert.equal(m.ok, false);
});

test("rwx bash boundary: a longer verbatim command is not matched by a shorter unrelated key", () => {
  const m = matchBash("git status", { "git statuses": "r" });
  assert.equal(m.ok, false);
});

test("rwx bash boundary: a multi-word key matches with a space before the next word", () => {
  const m = matchBash("git status -s", { "git status": "r" });
  assert.equal(m.ok, true);
  assert.equal(m.letter, "r");
  assert.equal(m.matchedKey, "git status");
});

test("rwx bash boundary: a multi-word key does not match a longer word it's a prefix of", () => {
  const m = matchBash("git statuses", { "git status": "r" });
  assert.equal(m.ok, false);
});

test("rwx bash boundary: Unicode whitespace (NBSP) is NOT treated as a boundary", () => {
  // U+00A0 NBSP between "git" and "status" must not be admitted as if it
  // were a real word split — the shell only splits on ASCII space (rwx) or
  // space/tab (bash.allow), never NBSP.
  const m = matchBash("git status", { git: "r" });
  assert.equal(m.ok, false);
});

// ─── regression: a trailing-whitespace rwx key must not widen matching ──────
// This is the exact class c241df1 introduced via `startsWithWordBoundary`'s
// "prefix already ends in space/tab -> true" shortcut: a key ending in
// whitespace (or the empty/blank key, guarded separately in
// test/rwx-bash-blank-key.test.js) started matching almost any command
// sharing that prefix, regardless of what followed.

test("rwx bash boundary regression: a trailing-space key does not swallow unrelated commands", () => {
  const m = matchBash("rm -rf /tmp/important", { "rm ": "x" });
  assert.equal(m.ok, false);
});

test("rwx bash boundary regression: a trailing-space key on a different command still does not match", () => {
  const m = matchBash("git status", { "git ": "w" });
  assert.equal(m.ok, false);
});

// ─── full Gate, rwx mode — a tab-separated command denies rwx.unlisted ──────
// (space-only matching is the known, documented limit; fail-safe over-deny).

test("rwx bash boundary: full Gate in rwx mode denies rwx.unlisted for a tab-separated command", async () => {
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "researcher",
      agents: { researcher: "r--" },
      bash: { git: "r" },
    },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();

  const result = await gate.check({ type: "bash", cmd: "git\tstatus" });

  assert.equal(result.outcome, "deny");
  assert.equal(result.rule, "rwx.unlisted");
});
