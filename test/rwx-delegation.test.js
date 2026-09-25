// rwx delegation clamp (PRD §23.9) — attenuate only: a child's letters are
// min(what the parent requested for it, what the parent holds), clamped in
// the PARENT's gate at spawn time. Adapted from the POC's E-rwx-3 evidence
// (depths 1..5), now against the real `Gate#clampRwxLetters`.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { clampLetters } from "../src/primitives/rwx.js";

test("rwx clamp: pure clampLetters is per-letter min(parent, requested)", () => {
  assert.equal(clampLetters("rwx", "rwx"), "rwx");
  assert.equal(clampLetters("r-x", "rwx"), "r-x"); // child asks for everything, parent caps it
  assert.equal(clampLetters("rw-", "r--"), "r--"); // child asks for less than parent holds
  assert.equal(clampLetters("---", "rwx"), "---");
  assert.equal(clampLetters("rwx", "---"), "---");
  assert.equal(clampLetters("r-x", "-w-"), "---"); // disjoint sets — nothing survives
});

test("rwx clamp: non-string inputs degrade to no letters (never throws)", () => {
  assert.equal(clampLetters(null, "rwx"), "---");
  // `requestedLetters` defaults to "rwx" (ask for everything) when omitted —
  // `undefined` triggers that default, so this clamps against the parent's
  // OWN letters, not against "no letters requested".
  assert.equal(clampLetters("rwx", undefined), "rwx");
  assert.equal(clampLetters(42, {}), "---"); // a non-string, non-undefined request has no letters at all
});

test("rwx clamp: Gate#clampRwxLetters reads this gate's own resolved letters", async () => {
  const gate = new Gate({
    audit: { path: null },
    rwx: { agent: "manager-rx", agents: { "manager-rx": "r-x" } },
  });
  await gate.init();
  assert.equal(gate.clampRwxLetters("rwx"), "r-x"); // child asks for everything
  assert.equal(gate.clampRwxLetters("r--"), "r--"); // child asks for less
  assert.equal(gate.clampRwxLetters("-w-"), "---"); // child asks for what parent lacks
});

test("rwx clamp: a gate not in rwx mode has nothing to delegate", async () => {
  const gate = new Gate({ audit: { path: null }, tools: { allowlist: ["bash"] } });
  await gate.init();
  assert.equal(gate.clampRwxLetters("rwx"), "---");
});

test("rwx clamp: an r-x parent cannot produce a w-holding child, chained through depths 1..5", async () => {
  // Mirrors the POC's E-rwx-3: at each depth, the CHILD asks for "rwx" (everything)
  // and the clamp still caps it to the parent's own letters; chaining the child as
  // the next depth's parent proves the clamp composes (never re-widens).
  let parentLetters = "r-x";
  let parentGate = new Gate({
    audit: { path: null },
    rwx: { agent: "manager-rx", agents: { "manager-rx": parentLetters } },
  });
  await parentGate.init();

  for (let depth = 1; depth <= 5; depth++) {
    const childLetters = parentGate.clampRwxLetters("rwx");
    assert.ok(!childLetters.includes("w"), `depth ${depth}: child got "${childLetters}", must never hold w`);
    assert.equal(childLetters, "r-x", `depth ${depth}: r-x parent's letters never widen`);

    // Construct the child as its OWN gate, receiving the clamped grant on the
    // same channel spawnDepth travels on (rwx.letters, §23.13 decision 2) —
    // no `agents` lookup needed for a spawned child.
    const childGate = new Gate({
      audit: { path: null },
      spawnDepth: depth,
      parentRunId: parentGate.runId,
      rwx: { letters: childLetters },
    });
    await childGate.init();

    // The child cannot verify (or widen) its own letters — check() reflects
    // exactly the clamped grant it was handed, nothing more.
    const dRead = await childGate.check({ type: "read", args: {} });
    // "read" is unlisted in the child's tools map (none was configured for
    // the child) — still correctly denies (deny-by-absence), not a false
    // allow from "it holds r".
    assert.equal(dRead.outcome, "deny");
    assert.equal(dRead.rule, "rwx.unlisted");

    parentGate = childGate; // chain: this depth's child is the next depth's parent
  }
});

test("rwx clamp: an rwx (full-grant) parent's child can hold exactly what it asks for", async () => {
  const parent = new Gate({
    audit: { path: null },
    rwx: { agent: "deployer", agents: { deployer: "rwx" } },
  });
  await parent.init();
  assert.equal(parent.clampRwxLetters("r--"), "r--");
  assert.equal(parent.clampRwxLetters("rw-"), "rw-");
  assert.equal(parent.clampRwxLetters("rwx"), "rwx");
});
