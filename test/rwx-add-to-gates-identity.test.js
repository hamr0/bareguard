// addToGates() per-index results/failures — PRD §23.21 follow-on to a
// debrief finding: two gates sharing the same rwx `agent` identity (a
// realistic fleet shape — many gates for the SAME logical agent, e.g. one
// per session) produced failure reports that could not disambiguate which
// one failed (`.failures`/`.errors` named only the shared identity string),
// and a failing call discarded the per-gate results entirely — a caller
// could not tell which OTHER gates in the same batch had landed once the
// call as a whole threw an AggregateError.
//
// Fixed by adding `index` (the gate's position in the `gates` array) to
// every success result, every `.failures` entry, and by attaching the FULL
// per-index `results` array (same shape as the success return value) to the
// thrown `AggregateError` as `.results`.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate, addToGates } from "../src/index.js";

function gateFor(agent, rwxOverrides = {}) {
  return new Gate({
    audit: { path: null },
    rwx: { agent, agents: { "fleet-a": "rwx" }, tools: {}, ...rwxOverrides },
    humanChannel: async () => ({ decision: "deny" }),
  });
}

test("addToGates: on full success, every result entry carries its array index", async () => {
  const a = gateFor("fleet-a");
  const b = gateFor("fleet-a"); // SAME identity as `a` — realistic fleet shape
  const c = gateFor("fleet-a");
  await Promise.all([a.init(), b.init(), c.init()]);

  const summary = await addToGates([a, b, c], { "site.probe": "r" });
  assert.equal(summary.length, 3);
  assert.deepEqual(summary.map((r) => r.index), [0, 1, 2]);
  for (const row of summary) {
    assert.equal(row.gate, "fleet-a");
    assert.equal(row.ok, true);
  }
});

test("addToGates: two gates sharing the same identity, one rejects — .failures and .results disambiguate by index", async () => {
  // g1 already holds "site.read" at the max letter "x" — a hand-written
  // stricter entry, same identity string as g2, which has no such entry.
  const g1 = gateFor("fleet-a", { tools: { "site.read": "x" } });
  const g2 = gateFor("fleet-a", { tools: { "site.read": "r" } }); // real, DIFFERENT gate, same identity
  await g1.init();
  await g2.init();

  const entries = { "site.read": "r" }; // loosens g1's "x" -> "r"; genuinely tightens g2's "r" -> "r" is a no-op tighten (equal, allowed)

  await assert.rejects(addToGates([g1, g2], entries), (err) => {
    assert.ok(err instanceof AggregateError);
    assert.equal(err.errors.length, 1, "exactly one gate failed");

    // .failures must carry index, not just the (ambiguous, shared) identity string.
    assert.equal(err.failures.length, 1);
    assert.equal(err.failures[0].index, 0, "g1 is at index 0 and is the one that fails");
    assert.equal(err.failures[0].gate, "fleet-a");
    assert.match(err.failures[0].message, /would LOOSEN/);

    // .results carries the FULL per-index outcome, success and failure alike —
    // this is the only way to see that g2 (index 1, same identity) actually
    // landed, since .failures/.errors only ever name the failing side.
    assert.ok(Array.isArray(err.results), ".results must be attached to the thrown AggregateError");
    assert.equal(err.results.length, 2);
    assert.deepEqual(err.results[0], { index: 0, gate: "fleet-a", ok: false, error: err.results[0].error });
    assert.match(err.results[0].error, /would LOOSEN/);
    assert.deepEqual(err.results[1], { index: 1, gate: "fleet-a", ok: true });
    return true;
  });

  // Confirm from the gates themselves: g1 unchanged, g2 landed.
  const d1 = await g1.check({ type: "site.read", args: {} });
  assert.equal(d1.rwxLetter, "x", "g1 must be unchanged — still the stricter hand-written value");
  const d2 = await g2.check({ type: "site.read", args: {} });
  assert.equal(d2.rwxLetter, "r");
});

test("addToGates: the top-level .message names the index alongside the (possibly ambiguous) identity", async () => {
  const g1 = gateFor("fleet-a", { tools: { "site.export": "x" } });
  const g2 = gateFor("fleet-a", { tools: { "site.export": "x" } });
  await g1.init();
  await g2.init();

  // Both share identity AND both will reject (both would loosen) — the message
  // must still be able to name each occurrence distinctly via index.
  await assert.rejects(addToGates([g1, g2], { "site.export": "r" }), (err) => {
    assert.equal(err.failures.length, 2);
    assert.deepEqual(err.failures.map((f) => f.index), [0, 1]);
    assert.match(err.message, /\[0\].*fleet-a/);
    assert.match(err.message, /\[1\].*fleet-a/);
    assert.ok(Array.isArray(err.results) && err.results.length === 2);
    assert.equal(err.results[0].ok, false);
    assert.equal(err.results[1].ok, false);
    return true;
  });
});
