// rwx marker-carrying entries + rwx.askOn:"loose" (D103, settled with the
// rwxmap project 2026-09-24). A tools/bash map entry is EITHER a bare
// letter string (unchanged, forever legal, never asks) OR an object
// { letter, marker } where marker is exactly "tight"|"loose"|"settled".
// The marker can only TIGHTEN: it never grants a letter, never skips a
// deny, never turns a deny into an ask or an allow.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { rwxCheck, assertRwxConfig, matchRwxLetter } from "../src/primitives/rwx.js";

function gateFor(rwxOverrides = {}, humanChannel) {
  return new Gate({
    audit: { path: null },
    rwx: {
      agent: "fixer",
      agents: { researcher: "r--", fixer: "rw-", deployer: "rwx" },
      tools: {
        read: "r",
        write: { letter: "w", marker: "tight" },
        edit: { letter: "w", marker: "loose" },
        archive: { letter: "w", marker: "settled" },
        typo: { letter: "w", marker: "strict" }, // unrecognized string -> loose
        blank: { letter: "w" },                  // missing marker -> loose
        deploy: "x",
      },
      bash: {
        "git status": "r",
        "git commit": { letter: "w", marker: "loose" },
        "git push": "x",
      },
      ...rwxOverrides,
    },
    humanChannel: humanChannel ?? (async () => ({ decision: "deny" })),
  });
}

// ─── bare-string entry: no marker, never asks ────────────────────────────────

test("rwx marker: bare-string entry never asks even under askOn:\"loose\"", async () => {
  let asked = false;
  const gate = gateFor({ askOn: "loose" }, async () => { asked = true; return { decision: "deny" }; });
  await gate.init();
  const d = await gate.check({ type: "read", args: {} });
  assert.equal(d.outcome, "allow");
  assert.equal(asked, false, "humanChannel must not be called for a bare-string entry");
});

// FALSIFY: revert askOn dispatch in rwx.js (marker check) -> this would still
// pass trivially since bare strings never carry a marker regardless. The real
// falsification for the bare-string branch is that `marker` stays `null` from
// normalizeEntry for a string input — covered structurally below via the
// tools-map object tests, which DO flip red on the same revert.

// ─── object entry, marker "loose": asks under askOn:"loose" ────────────────

test("rwx marker: askOn:\"loose\" + marker:\"loose\" asks via humanChannel (letter held)", async () => {
  let event = null;
  const gate = gateFor({ askOn: "loose" }, async (e) => { event = e; return { decision: "allow" }; });
  await gate.init();
  const d = await gate.check({ type: "edit", args: {} }); // w, marker loose; fixer holds rw-
  assert.equal(d.outcome, "allow"); // humanChannel said allow
  assert.ok(event, "humanChannel must have been called");
  assert.equal(event.rwxLetter, "w");
  assert.equal(event.rwxMarker, "loose");
  assert.equal(event.rule, "rwx.ask");
});

test("rwx marker: askOn:\"loose\" ask can be denied by humanChannel", async () => {
  const gate = gateFor({ askOn: "loose" }, async () => ({ decision: "deny", reason: "not today" }));
  await gate.init();
  const d = await gate.check({ type: "edit", args: {} });
  assert.equal(d.outcome, "deny");
  assert.equal(d.reason, "not today");
});

// ─── tighten-only: a missing letter still denies, marker never grants ──────

test("rwx marker: a letter the agent lacks still denies even with askOn:\"loose\" (marker never grants)", async () => {
  let asked = false;
  const gate = gateFor({ askOn: "loose" }, async () => { asked = true; return { decision: "allow" }; });
  await gate.init();
  const d = await gate.check({ type: "deploy", args: {} }); // x, fixer only holds rw-
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.denied");
  assert.equal(asked, false, "a denied letter must never reach humanChannel via the marker path");
});

// FALSIFY: comment out the `if (!letters.includes(letter)) return deny...`
// guard ahead of the askOn check in rwx.js and this goes from deny to
// askHuman/allow -> red. Restored below.

// ─── tight / settled never ask ──────────────────────────────────────────────

test("rwx marker: \"tight\" marker never asks under askOn:\"loose\"", async () => {
  let asked = false;
  const gate = gateFor({ askOn: "loose" }, async () => { asked = true; return { decision: "deny" }; });
  await gate.init();
  const d = await gate.check({ type: "write", args: {} });
  assert.equal(d.outcome, "allow");
  assert.equal(asked, false);
});

test("rwx marker: \"settled\" marker never asks under askOn:\"loose\"", async () => {
  let asked = false;
  const gate = gateFor({ askOn: "loose" }, async () => { asked = true; return { decision: "deny" }; });
  await gate.init();
  const d = await gate.check({ type: "archive", args: {} });
  assert.equal(d.outcome, "allow");
  assert.equal(asked, false);
});

// ─── typo-safety: missing/unrecognized marker treated as "loose" ───────────

test("rwx marker: a missing marker on an object entry is treated as \"loose\" (typo-safety)", async () => {
  let asked = false;
  const gate = gateFor({ askOn: "loose" }, async () => { asked = true; return { decision: "allow" }; });
  await gate.init();
  const d = await gate.check({ type: "blank", args: {} });
  assert.equal(asked, true);
  assert.equal(d.outcome, "allow");
});

test("rwx marker: an unrecognized marker string (\"strict\") on an object entry is treated as \"loose\"", async () => {
  let asked = false;
  const gate = gateFor({ askOn: "loose" }, async () => { asked = true; return { decision: "allow" }; });
  await gate.init();
  const d = await gate.check({ type: "typo", args: {} });
  assert.equal(asked, true);
  assert.equal(d.outcome, "allow");
});

// ─── askOn:"none" (default) is byte-identical: no ask, ever ────────────────

test("rwx marker: askOn:\"none\" (default) never asks regardless of marker", async () => {
  let asked = false;
  const gate = gateFor({}, async () => { asked = true; return { decision: "deny" }; }); // no askOn -> default "none"
  await gate.init();
  const d1 = await gate.check({ type: "edit", args: {} });   // marker loose
  const d2 = await gate.check({ type: "blank", args: {} });  // marker missing -> would-be loose
  assert.equal(d1.outcome, "allow");
  assert.equal(d2.outcome, "allow");
  assert.equal(asked, false);
});

// FALSIFY: hardcode `askOn === "loose"` to always true in rwx.js -> the two
// asserts above flip to deny (since humanChannel denies), going red.
// Restored below.

// ─── bash entries carry markers the same way ────────────────────────────────

test("rwx marker: bash object entry with marker \"loose\" asks under askOn:\"loose\"", async () => {
  let asked = false;
  const gate = gateFor({ askOn: "loose" }, async () => { asked = true; return { decision: "allow" }; });
  await gate.init();
  const d = await gate.check({ type: "bash", cmd: "git commit -m x" });
  assert.equal(asked, true);
  assert.equal(d.outcome, "allow");
});

test("rwx marker: bash bare-string entry never asks under askOn:\"loose\"", async () => {
  let asked = false;
  const gate = gateFor({ askOn: "loose" }, async () => { asked = true; return { decision: "deny" }; });
  await gate.init();
  const d = await gate.check({ type: "bash", cmd: "git status" });
  assert.equal(asked, false);
  assert.equal(d.outcome, "allow");
});

// ─── audit fields ────────────────────────────────────────────────────────────

test("rwx marker: the audit line carries rwxMarker next to rwxLetters/rwxLetter on allow", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.check({ type: "write", args: {} }); // marker "tight"
  const lines = await gate.audit.readAll();
  const gateLine = lines.find((l) => l.phase === "gate" && l.decision === "allow");
  assert.equal(gateLine.rwxLetters, "rw-");
  assert.equal(gateLine.rwxLetter, "w");
  assert.equal(gateLine.rwxMarker, "tight");
});

test("rwx marker: the audit line carries rwxMarker on an askHuman gate line", async () => {
  const gate = gateFor({ askOn: "loose" }, async () => ({ decision: "allow" }));
  await gate.init();
  await gate.check({ type: "edit", args: {} });
  const lines = await gate.audit.readAll();
  const askLine = lines.find((l) => l.phase === "gate" && l.decision === "askHuman");
  assert.ok(askLine);
  assert.equal(askLine.rwxMarker, "loose");
  assert.equal(askLine.rule, "rwx.ask");
});

test("rwx marker: the audit line carries rwxMarker on a rwx.denied deny", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.check({ type: "edit", args: {} }); // w/loose, but researcher-in-disguise test below uses fixer which HOLDS w
  // Use an agent without w to force rwx.denied while marker is present.
  const denyGate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "researcher", // holds r-- only
      agents: { researcher: "r--" },
      tools: { edit: { letter: "w", marker: "loose" } },
    },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await denyGate.init();
  await denyGate.check({ type: "edit", args: {} });
  const lines = await denyGate.audit.readAll();
  const gateLine = lines.find((l) => l.phase === "gate" && l.decision === "deny");
  assert.equal(gateLine.rule, "rwx.denied");
  assert.equal(gateLine.rwxMarker, "loose");
});

test("rwx marker: a non-rwx / plain bare-letter gate's audit line never carries rwxMarker", async () => {
  const gate = gateFor(); // askOn defaults to "none", entries include bare "deploy":"x"
  await gate.init();
  await gate.check({ type: "deploy", args: {} }); // fixer denied (only rw-), letter "x", no marker (bare string)
  const lines = await gate.audit.readAll();
  const gateLine = lines.find((l) => l.phase === "gate" && l.decision === "deny");
  assert.equal(gateLine.rule, "rwx.denied");
  assert.equal(gateLine.rwxMarker, undefined);
});

// ─── budget/count accrual (matchRwxLetter) still works with object entries ──

test("rwx marker: matchRwxLetter resolves the letter for an object-form tools entry", () => {
  const letter = matchRwxLetter({ type: "write" }, { tools: { write: { letter: "w", marker: "tight" } } });
  assert.equal(letter, "w");
});

test("rwx marker: matchRwxLetter resolves the letter for an object-form bash entry", () => {
  const letter = matchRwxLetter({ type: "bash", cmd: "git commit -m x" }, { bash: { "git commit": { letter: "w", marker: "loose" } } });
  assert.equal(letter, "w");
});

// ─── malformed entries: fail-closed rwx.invalid at read time ───────────────

test("rwx marker: a malformed object entry (missing letter) denies rwx.invalid at runtime (TOCTOU)", () => {
  const cfg = { agent: "fixer", agents: { fixer: "rw-" }, tools: { edit: {} } };
  const d = rwxCheck({ type: "edit" }, cfg);
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.invalid");
});

test("rwx marker: a malformed object entry (bad letter) denies rwx.invalid at runtime (TOCTOU)", () => {
  const cfg = { agent: "fixer", agents: { fixer: "rw-" }, tools: { edit: { letter: "z" } } };
  const d = rwxCheck({ type: "edit" }, cfg);
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.invalid");
});

test("rwx marker: a non-string/non-plain-object entry (array) denies rwx.invalid at runtime", () => {
  const cfg = { agent: "fixer", agents: { fixer: "rw-" }, tools: { edit: ["w"] } };
  const d = rwxCheck({ type: "edit" }, cfg);
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.invalid");
});

// ─── malformed entries: construct-time throw ────────────────────────────────

test("rwx marker: a malformed object entry throws at construct time", () => {
  assert.throws(
    () => assertRwxConfig({ rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { edit: { marker: "loose" } } } }),
    /rwx\.tools\.edit must be "r"\/"w"\/"x" or \{ letter:/,
  );
  assert.throws(
    () => assertRwxConfig({ rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { edit: { letter: "q" } } } }),
    /rwx\.tools\.edit must be "r"\/"w"\/"x" or \{ letter:/,
  );
});

test("rwx marker: a valid object entry with an unrecognized marker does NOT throw at construct time (normalizes to loose at read time)", () => {
  assert.doesNotThrow(() =>
    assertRwxConfig({ rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { edit: { letter: "w", marker: "strict" } } } }),
  );
});

test("rwx marker: any other key on an object entry is ignored (rwxmap's evidence field never enters this file)", async () => {
  const gate = new Gate({
    audit: { path: null },
    rwx: {
      agent: "fixer",
      agents: { fixer: "rw-" },
      tools: { edit: { letter: "w", marker: "tight", evidence: "floor", destructive: true } },
    },
    humanChannel: async () => ({ decision: "deny" }),
  });
  await gate.init();
  const d = await gate.check({ type: "edit", args: {} });
  assert.equal(d.outcome, "allow");
});

// ─── askOn construct-time validation ────────────────────────────────────────

test("rwx marker: an unknown rwx.askOn value throws at construct time", () => {
  assert.throws(
    () => new Gate({ rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { read: "r" }, askOn: "strict" } }),
    /rwx\.askOn must be "none" or "loose"/,
  );
});

test("rwx marker: rwx.askOn:\"none\" and undefined do not throw", () => {
  assert.doesNotThrow(() => new Gate({ rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { read: "r" }, askOn: "none" } }));
  assert.doesNotThrow(() => new Gate({ rwx: { agent: "fixer", agents: { fixer: "rw-" }, tools: { read: "r" } } }));
});
