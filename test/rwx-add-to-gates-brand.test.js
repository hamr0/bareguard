// addToGates() cross-copy acceptance — PRD §23.21 follow-on to a debrief
// finding: `addToGates` rejected a genuine `Gate` instance constructed from
// a SECOND copy of the `bareguard` package (e.g. two different
// versions/installs deduped separately by two dependencies of a fleet app),
// because `instanceof Gate` fails across module/realm boundaries even for a
// real, fully-functional gate — and rejects it BEFORE attempting ANY gate in
// the batch (addToGates validates every element up front), so one
// unrecognized gate silently starved every other gate in the fleet too.
//
// Fixed by branding `Gate` instances with the GLOBAL-REGISTRY symbol
// `Symbol.for("bareguard.Gate")` (set as a non-enumerable own property in
// the constructor) and accepting any object carrying that brand plus a
// callable `add` — `Symbol.for` resolves to the identical symbol across
// separate copies of the module in the same process, which is exactly the
// property a plain `Symbol()` field would NOT have.
//
// This test simulates "a Gate from a different copy of the package" with a
// hand-built duck-typed object carrying the real brand symbol, rather than
// standing up a genuine second `node_modules` copy on disk — the brand
// mechanism (`Symbol.for` + duck-typed accept) is exactly what makes that
// equivalent: a real second copy's constructor would stamp the SAME
// `Symbol.for("bareguard.Gate")` value, so accepting a hand-built object
// with that symbol set exercises the identical acceptance path a real
// cross-copy Gate would take. (A real cross-package repro was additionally
// run by hand against two independent checkouts and is reported separately —
// see the debrief.)

import test from "node:test";
import assert from "node:assert/strict";
import { Gate, addToGates } from "../src/index.js";

const GATE_BRAND = Symbol.for("bareguard.Gate");

function gateFor(agent, rwxOverrides = {}) {
  return new Gate({
    audit: { path: null },
    rwx: { agent, agents: { a: "r--", b: "rw-" }, tools: {}, ...rwxOverrides },
    humanChannel: async () => ({ decision: "deny" }),
  });
}

// A hand-built stand-in for "a Gate instance from a different copy of
// bareguard" — carries the SAME global-registry brand symbol a real second
// copy's constructor would stamp, a callable `add`, and just enough of the
// real shape (`cfg.rwx.agent`, `runId`) for `gateIdentity`/`add` to behave
// sensibly, without actually loading a second module graph.
function fakeCrossCopyGate(agent, tools = {}) {
  const state = { tools: { ...tools } };
  const obj = {
    runId: `fake-${agent}`,
    cfg: { rwx: { agent, tools: state.tools } },
    async add(entries) {
      for (const [k, v] of Object.entries(entries)) state.tools[k] = v;
      return undefined;
    },
    rwxTools() { return { ...state.tools }; },
  };
  Object.defineProperty(obj, GATE_BRAND, { value: true, enumerable: false });
  return obj;
}

test("addToGates: still accepts a real Gate instance (instanceof AND brand both hold)", async () => {
  const gate = gateFor("a");
  await gate.init();
  const summary = await addToGates([gate], { probe: "r" });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].ok, true);
});

test("addToGates: accepts a branded, duck-typed gate-like object even though it is NOT `instanceof Gate`", async () => {
  const real = gateFor("a");
  await real.init();
  const fake = fakeCrossCopyGate("b");
  assert.equal(fake instanceof Gate, false, "the stand-in must genuinely fail instanceof, like a real cross-copy Gate would");

  const summary = await addToGates([real, fake], { "site.read": "r" });
  assert.equal(summary.length, 2);
  for (const row of summary) assert.equal(row.ok, true);

  const d = await real.check({ type: "site.read", args: {} });
  assert.equal(d.outcome, "allow");
  assert.deepEqual(fake.rwxTools(), { "site.read": "r" });
});

test("addToGates: still rejects an object carrying the brand but NO callable add()", async () => {
  const notReallyAGate = {};
  Object.defineProperty(notReallyAGate, GATE_BRAND, { value: true, enumerable: false });
  await assert.rejects(() => addToGates([notReallyAGate], { x: "r" }), /must be a Gate instance/);
});

test("addToGates: still rejects a plain object with no brand at all (unchanged behavior)", async () => {
  const gate = gateFor("a");
  await gate.init();
  await assert.rejects(() => addToGates([gate, {}], { x: "r" }), /must be a Gate instance/);
  const d = await gate.check({ type: "x", args: {} });
  assert.equal(d.rule, "rwx.unlisted", "the valid gate must not have been touched either — validation runs before any gate is attempted");
});

test("addToGates: the GATE_BRAND symbol is non-enumerable on a real Gate — no leak into for...in/Object.keys/JSON", async () => {
  const gate = gateFor("a");
  assert.equal(Object.keys(gate).includes(GATE_BRAND), false); // Object.keys never includes symbol keys regardless; this documents intent
  assert.equal(Object.getOwnPropertyDescriptor(gate, GATE_BRAND).enumerable, false);
  assert.equal(JSON.stringify(gate).includes("bareguard.Gate"), false);
});
