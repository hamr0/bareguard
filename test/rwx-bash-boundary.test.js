// rwx bash-map matching: word-boundary consistency with bash.allow (0.19.1).
//
// matchBash's leading-word match used to treat only a literal space as a
// word boundary (`cmd === key || cmd.startsWith(key + " ")`), while
// bash.allow (bash.js) already treated space OR tab as a boundary, since the
// shell splits words on both. A tab-separated command ("git\tstatus") ran
// through the shell exactly like "git status", but rwx denied it as
// unlisted. Both now share `startsWithWordBoundary` (word-boundary.js).

import test from "node:test";
import assert from "node:assert/strict";
import { matchBash } from "../src/primitives/rwx.js";
import { Gate } from "../src/index.js";

test("rwx bash boundary: a tab between leading words matches like a space", () => {
  const m = matchBash("git\tstatus", { git: "r" });
  assert.equal(m.ok, true);
  assert.equal(m.letter, "r");
  assert.equal(m.matchedKey, "git");
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

test("rwx bash boundary: a multi-word key matches with a tab before the next word", () => {
  const m = matchBash("git status\t-s", { "git status": "r" });
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
  // were a real word split — the shell only splits on ASCII space/tab.
  const m = matchBash("git status", { git: "r" });
  assert.equal(m.ok, false);
});

// ─── full Gate, rwx mode — the tab command is now allowed where it was ──────
// ─── denied rwx.unlisted before this fix ────────────────────────────────────

test("rwx bash boundary: full Gate in rwx mode allows a tab-separated command matching a bash-map entry", async () => {
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

  assert.equal(result.outcome, "allow", JSON.stringify(result));
  assert.notEqual(result.rule, "rwx.unlisted");
});
