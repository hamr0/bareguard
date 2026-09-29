// rwx.bash blank/whitespace-only keys (0.19.1, BREAKING).
//
// `matchBash`'s leading-word match treats "" as a prefix every command
// starts with: `rwx.bash: {"": "r"}` matched ANY command with a leading
// space (` rm -rf x` → ok, letter "r") because `startsWithWordBoundary("
// rm -rf x", "")` is true (empty prefix matches trivially, and the very
// next char — the leading space — satisfies the boundary check). This is
// the same bug class as the `bash.allow: [""]` wildcard fixed alongside the
// 0.19.1 word-boundary work, applied to rwx's bash map.
//
// Scoped to `rwx.bash` only — measured and confirmed NOT equally dangerous
// for `rwx.tools` or `rwx.agents`: both are matched by an EXACT identity
// lookup (`action.tool ?? action.type` / `rwx.agent`), never a prefix, so a
// blank key there only ever matches an equally-blank identity/agent name —
// not a boundary bypass reachable by adding a leading whitespace byte to
// otherwise-normal agent-generated text. (`action.tool: ""` already denies
// fail-closed via `tools.invalidTool`; `rwx.agent` is the GATE's own
// construct-time identity, not attacker-influenced action content.) Left
// unfixed per that measurement — not filed as a second vulnerability.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { matchBash, assertRwxConfig } from "../src/primitives/rwx.js";

// ─── construct-time throw ─────────────────────────────────────────────────

test("rwx.bash: an empty-string key throws at construct time", () => {
  assert.throws(
    () => new Gate({ rwx: { agent: "a", agents: { a: "r--" }, bash: { "": "r" } } }),
    /rwx\.bash key must be a non-empty, non-whitespace command prefix, got ""/,
  );
});

test("rwx.bash: a whitespace-only key (spaces) throws at construct time", () => {
  assert.throws(
    () => new Gate({ rwx: { agent: "a", agents: { a: "r--" }, bash: { "   ": "r" } } }),
    /rwx\.bash key must be a non-empty, non-whitespace command prefix, got "   "/,
  );
});

test("rwx.bash: a whitespace-only key (tab) throws at construct time", () => {
  assert.throws(
    () => new Gate({ rwx: { agent: "a", agents: { a: "r--" }, bash: { "\t": "r" } } }),
    /rwx\.bash key must be a non-empty, non-whitespace command prefix/,
  );
});

test("rwx.bash: assertRwxConfig itself throws the same way (direct call, no Gate)", () => {
  assert.throws(
    () => assertRwxConfig({ rwx: { agent: "a", agents: { a: "r--" }, bash: { "": "w" } } }),
    /rwx\.bash key must be a non-empty, non-whitespace command prefix/,
  );
});

test("rwx.bash: a valid key still works (construct-time throw doesn't overreach)", () => {
  assert.doesNotThrow(() => new Gate({
    rwx: { agent: "a", agents: { a: "r--" }, bash: { "git status": "r" } },
  }));
});

// ─── matchBash runtime backstop (TOCTOU: cfg mutated after construction) ──

test("matchBash: a blank key never matches, even against a leading-space command", () => {
  const m = matchBash(" rm -rf x", { "": "r" });
  assert.equal(m.ok, false, JSON.stringify(m));
});

test("matchBash: a whitespace-only key never matches", () => {
  const m = matchBash("   rm -rf x", { "   ": "x" });
  assert.equal(m.ok, false, JSON.stringify(m));
});

test("matchBash: a blank key is inert even when cmd itself is blank/whitespace (verbatim path)", () => {
  const m = matchBash("   ", { "": "r", "   ": "w" });
  assert.equal(m.ok, false, JSON.stringify(m));
});

test("matchBash: a real key alongside a blank one still matches normally", () => {
  const m = matchBash("git status", { "": "r", git: "r" });
  assert.equal(m.ok, true);
  assert.equal(m.matchedKey, "git");
});

// ─── gate.add() cannot introduce this at all — it never touches rwx.bash ──

test("gate.add(): a blank-keyed entry lands (if at all) only in rwx.tools, never rwx.bash — the bash vector stays unreachable via add()", async () => {
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "fixer",
      agents: { fixer: "rw-" },
      bash: { "git status": "r" },
    },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();

  // add() accepts a blank key as an ordinary (bare-letter) tools-map entry —
  // assertRwxConfig's new bash-only blank-key throw does not apply to
  // `tools`, and add() only ever validates/writes `rwx.tools` (confirmed by
  // the existing "only the tools map is reachable" test in rwx-add.test.js).
  await gate.add({ "": "r" });

  // The real bash map is untouched: a leading-space bash command that would
  // have matched a blank rwx.bash key is still unlisted, not allowed.
  const d = await gate.check({ type: "bash", cmd: " rm -rf x" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.unlisted");
});
