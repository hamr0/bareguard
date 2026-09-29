// gate.rwxTools() — a decoupled read accessor for the gate's current
// rwx.tools map (PRD §23.21, follow-on to gate.add(); see the rwx-e2e
// bench's "things that felt wrong" #1: add() was the only write path, with
// no corresponding read path other than reaching into `gate.cfg.rwx.tools`
// directly, undocumented internal state).
//
// Covers: correctness after add(), the null sentinel for a non-rwx gate,
// no leak of other rwx internals, and — the load-bearing property —
// mutating the returned snapshot at any depth never affects the gate's
// live decisions.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

import { REAL_SLASH_TMP } from "./_helpers.js";
function gateFor(rwxOverrides = {}) {
  return new Gate({
    audit: { path: null },
    // Broad fs scope so a "read"/"write"-typed action's fs step (which runs
    // BEFORE the rwx step) passes through on a real path, letting these
    // tests exercise the rwxTools() accessor, not fs scoping.
    fs: { readScope: [REAL_SLASH_TMP], writeScope: [REAL_SLASH_TMP] },
    rwx: {
      agent: "fixer",
      agents: { fixer: "rwx" },
      tools: { read: "r", write: "w" },
      bash: { "git status": "r" },
      ...rwxOverrides,
    },
    humanChannel: async () => ({ decision: "deny" }),
  });
}

test("rwxTools: returns the current tools map", async () => {
  const gate = gateFor();
  await gate.init();
  const snapshot = gate.rwxTools();
  assert.deepEqual(snapshot, { read: "r", write: "w" });
});

test("rwxTools: reflects entries landed by add()", async () => {
  const gate = gateFor();
  await gate.init();
  await gate.add({ search: "r", deploy: { letter: "x", marker: "settled" } });
  const snapshot = gate.rwxTools();
  assert.deepEqual(snapshot, {
    read: "r",
    write: "w",
    search: "r",
    deploy: { letter: "x", marker: "settled" },
  });
});

test("rwxTools: returns null when the gate has no rwx config", async () => {
  const gate = new Gate({ audit: { path: null }, tools: { allowlist: ["read"] } });
  await gate.init();
  assert.equal(gate.rwxTools(), null);
});

test("rwxTools: exposes only the tools map — no bash/agents/grant leak", async () => {
  const gate = gateFor();
  await gate.init();
  const snapshot = gate.rwxTools();
  assert.equal(snapshot.bash, undefined);
  assert.equal(snapshot.agents, undefined);
  assert.equal(snapshot.agent, undefined);
  assert.deepEqual(Object.keys(snapshot).sort(), ["read", "write"]);
});

test("rwxTools: a bare-letter entry stays a bare string, not an object", async () => {
  const gate = gateFor();
  await gate.init();
  const snapshot = gate.rwxTools();
  assert.equal(typeof snapshot.read, "string");
  assert.equal(snapshot.read, "r");
});

// ─── the load-bearing property: decoupling ────────────────────────────────

test("rwxTools: mutating the top-level returned object does not affect a later check()", async () => {
  const gate = gateFor();
  await gate.init();
  const before = await gate.check({ type: "read", path: REAL_SLASH_TMP + "/x", args: {} });
  assert.equal(before.outcome, "allow");

  const snapshot = gate.rwxTools();
  delete snapshot.read; // try to erase the key from the "map"
  snapshot.read = "x"; // and try to plant a bogus one back

  const after = await gate.check({ type: "read", path: REAL_SLASH_TMP + "/x", args: {} });
  assert.equal(after.outcome, "allow", "the gate's live map must be untouched by the mutation above");
  assert.equal(after.rwxLetter, "r", "the ORIGINAL letter, not the mutated one");
});

test("rwxTools: mutating a NESTED (marker) entry does not affect a later check()", async () => {
  const gate = gateFor({ tools: { probe: { letter: "r", marker: "loose" } }, askOn: "loose" });
  await gate.init();

  const snapshot = gate.rwxTools();
  // Deep mutation: flip the nested object's own fields.
  snapshot.probe.letter = "x";
  snapshot.probe.marker = "settled";

  // If the gate's live entry followed this mutation, "probe" would now allow
  // outright (settled, x-letter — but this agent only holds r-x from "rwx",
  // wait: agent holds "rwx" here per gateFor's default agents map, so express
  // the check on the DEFAULT gate (fixer holds full rwx) — assert the marker
  // specifically: a truly-mutated live entry would no longer ask (settled
  // never asks), while the ORIGINAL loose-marked entry still asks every time.
  const humanCalls = [];
  gate.humanChannel = async (event) => { humanCalls.push(event); return { decision: "allow" }; };
  const d = await gate.check({ type: "probe", args: {} });
  assert.equal(d.outcome, "allow");
  assert.equal(humanCalls.length, 1, "askOn:loose must still have asked — the live marker must still be \"loose\", not the mutated \"settled\"");
  assert.equal(d.rule, "humanChannel.allow");
});

test("rwxTools: mutating the returned snapshot does not affect a later add()'s tighten-only check", async () => {
  const gate = gateFor({ tools: { probe: "w" } });
  await gate.init();

  const snapshot = gate.rwxTools();
  snapshot.probe = "r"; // try to plant a "loosened" value into the live-looking snapshot

  // add()'s tighten-only check must still compare against the REAL live
  // entry ("w"), not the mutated snapshot ("r") — so tightening to "x" must
  // still succeed (w -> x is a real tighten), and re-attempting "r" must
  // still be rejected as a loosen from the TRUE current state.
  await assert.doesNotReject(() => gate.add({ probe: "x" }));
  await assert.rejects(() => gate.add({ probe: "r" }), /would LOOSEN/);
});

test("rwxTools: two successive calls return independent copies (mutating one snapshot doesn't affect the other or the live map)", async () => {
  const gate = gateFor();
  await gate.init();
  const snap1 = gate.rwxTools();
  const snap2 = gate.rwxTools();
  snap1.read = "MUTATED";
  assert.equal(snap2.read, "r", "snap2 must be unaffected by mutating snap1");
  const d = await gate.check({ type: "read", path: REAL_SLASH_TMP + "/x", args: {} });
  assert.equal(d.rwxLetter, "r", "the live map must be unaffected by mutating either snapshot");
});
