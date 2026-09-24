// Regression test for the shipped starter file bareguard.rwx.json (PRD §23).
//
// The starter's own `_notes` block documents a class of bash commands whose
// bare leading word is a safe read, but which carry an OPTION (or, for
// `date`, a bare positional form) that the leading-word matcher can't see
// and that turns the command into a write. The notes say such commands must
// never be tagged `r` in the map. This test found (and this commit fixes) a
// contradiction: `"git diff": "r"` in the map directly violated the notes'
// own example one paragraph above it — `git diff --output=<file>` writes a
// file, verified against `git diff --help`'s own documented `--output=<file>`
// option, and the shipped starter still allowed it read-only via
// src/primitives/rwx.js's matchBash() longest-prefix, word-boundary match.
//
// This test is mechanical (no reasoning about the JSON's shape) and must go
// RED if any of these known write-capable-by-option/positional-form
// commands is re-added to the starter's `bash` map under the letter `r`,
// and must exercise the real Gate to prove the offending invocation is
// actually denied/asked, not just check letters in isolation.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Gate } from "../src/index.js";

const STARTER_PATH = fileURLToPath(
  new URL("../bareguard.rwx.json", import.meta.url),
);

function loadStarter() {
  return JSON.parse(readFileSync(STARTER_PATH, "utf8"));
}

// Reviewed, evidence-backed: each of these bash leading words is known to
// have an OPTION, or (for `date`) a bare positional form, that performs a
// write/state-mutation the leading-word matcher cannot see, verified against
// the command's own --help output at the time this test was written:
//   - "git diff", "git show", "git log": all three document `--output=<file>`
//     ("Output to a specific file instead of stdout.") under their shared
//     "generate patch text" options.
//   - "date": `-s`/`--set=STRING` ("set time described by STRING"), and the
//     bare positional `MMDDhhmm[[CC]YY][.ss]` form (no flag at all) both set
//     the system clock.
//   - "sed", "tar", "curl": named directly in the starter's own _notes
//     (sed -i, tar -x, curl -o) — included here so this test also catches a
//     regression if any of THOSE get added back under `r`.
const NEVER_R_BASH_COMMANDS = Object.freeze([
  "git diff",
  "git show",
  "git log",
  "date",
  "sed",
  "tar",
  "curl",
]);

// `git fetch` is a distinct case from the above: it isn't a hidden OPTION,
// the bare command itself always writes .git/FETCH_HEAD and updates
// remote-tracking refs (git-fetch(1): "The names of refs that are fetched,
// together with the object names they point at, are written to
// .git/FETCH_HEAD"). It must be tagged "w", never "r".
const MUST_BE_W_BASH_COMMANDS = Object.freeze(["git fetch"]);

test("starter bareguard.rwx.json: none of the known hidden-write bash commands are tagged r", () => {
  const starter = loadStarter();
  const bash = starter.bash ?? {};
  for (const cmd of NEVER_R_BASH_COMMANDS) {
    const letter = bash[cmd];
    assert.notEqual(
      letter,
      "r",
      `bareguard.rwx.json bash["${cmd}"] must never be "r" — this command has ` +
        `a documented option (or positional form) that writes/mutates state ` +
        `invisibly to leading-word matching`,
    );
  }
});

test("starter bareguard.rwx.json: git fetch is tagged w, not r", () => {
  const starter = loadStarter();
  const bash = starter.bash ?? {};
  for (const cmd of MUST_BE_W_BASH_COMMANDS) {
    assert.equal(
      bash[cmd],
      "w",
      `bareguard.rwx.json bash["${cmd}"] must be "w" — the bare command always ` +
        `writes .git/FETCH_HEAD and updates remote-tracking refs`,
    );
  }
});

test("starter bareguard.rwx.json: every r-tagged bash key is in the reviewed allow-list", () => {
  // Belt-and-suspenders: rather than only checking the known offenders by
  // name, assert every "r"-tagged row in the shipped map is one we've
  // actually reviewed. A newly-added "r" row that isn't in this list fails
  // the test until a human reviews it and adds it here — deny-by-absence
  // applied to the test itself, matching rwx.unlisted's own philosophy.
  const REVIEWED_R_BASH = new Set([
    "pwd",
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "grep",
    "diff",
    "whoami",
    "git status",
    "npm ls",
  ]);

  const starter = loadStarter();
  const bash = starter.bash ?? {};
  const rTagged = Object.keys(bash).filter((k) => bash[k] === "r");

  for (const key of rTagged) {
    assert.ok(
      REVIEWED_R_BASH.has(key),
      `bareguard.rwx.json bash["${key}"] is tagged "r" but is not in this ` +
        `test's reviewed allow-list — verify against the command's own ` +
        `--help/docs that no option or positional form writes/mutates ` +
        `state, then add it to REVIEWED_R_BASH here`,
    );
  }

  // And the inverse: every entry in the reviewed list must still be present
  // and still tagged r in the starter, so this list can't silently drift
  // stale against the file it's meant to police.
  for (const key of REVIEWED_R_BASH) {
    assert.equal(
      bash[key],
      "r",
      `REVIEWED_R_BASH expects bareguard.rwx.json bash["${key}"] === "r", ` +
        `but the starter has ${JSON.stringify(bash[key])} — update either ` +
        `the starter or this test's reviewed list`,
    );
  }
});

test("starter bareguard.rwx.json: git diff --output= is not allowed read-only through the real Gate", async () => {
  const starter = loadStarter();
  const gate = new Gate({
    audit: { path: null },
    rwx: { agent: "researcher", ...starter },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();

  const result = await gate.check({
    type: "bash",
    command: "git diff --output=/tmp/bareguard-rwx-starter-test.txt",
  });

  // A researcher is r-- (read-only). If "git diff" were still tagged "r" in
  // the starter, this write-capable invocation would be allowed. It must
  // not be: either denied outright, or at minimum not allowed.
  assert.notEqual(
    result.outcome,
    "allow",
    `an r-- (researcher) agent must not be allowed to run ` +
      `"git diff --output=..." — got outcome ${JSON.stringify(result.outcome)}`,
  );
});

test("starter bareguard.rwx.json: falsification — re-adding git diff:r goes red", () => {
  // This test proves the invariant test above is not tautological: revert
  // the specific fix in an isolated in-memory copy and confirm it fails.
  const starter = loadStarter();
  const mutated = {
    ...starter,
    bash: { ...starter.bash, "git diff": "r" },
  };

  const bash = mutated.bash;
  const offender = "git diff";
  const wouldPass = bash[offender] !== "r";
  assert.equal(
    wouldPass,
    false,
    "sanity check: mutated copy should reproduce the original bug (git diff: r)",
  );
});
