import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Gate, createRubric, rubricSha } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths, makeHumanChannel } from "./_helpers.js";

// ---------------------------------------------------------------------------
// Module 2: the rubric wired into the Gate (docs/product/rubric-prd.md §6, §7, §9, §12).
// ---------------------------------------------------------------------------

const cap = (n) => [{ id: "cap", rule: "maxWords", field: "text", value: n }];
const SPEC = {
  schema: 1, goal: "g",
  checkpoints: {
    resume: { gating: true, checks: cap(5) },
    note: { gating: false, checks: cap(1) },
    review: { gating: true, requiresHuman: true, checks: cap(5) },
    parked: { gating: true, requiresHuman: true, accept: "later", checks: cap(5) },
    seeded: { gating: true, checks: [{ id: "n", rule: "notWorse", direction: "lower-is-better", baseline: "seed" }] },
  },
};
const OK = "one two three";                 // green (<= 5 words)
const BAD = "one two three four five six";  // red (6 words)

const rubricCfg = (spec = SPEC, advanceOn = ["done"]) => ({ spec, sha256: rubricSha(spec), advanceOn });
const advance = (r, cp, extra = {}) => ({ type: "done", checkpoint: cp, outputSha: r.outputSha, ...extra });

async function mk(t, cfg = {}) {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const gate = new Gate({ audit: { path: auditPath }, rubric: rubricCfg(), runId, ...cfg });
  await gate.init();
  return { gate, auditPath, dir, runId };
}
const lines = (p) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// --- construct-time ----------------------------------------------------------

test("construct: a tampered / unsigned / mis-shaped rubric config throws", () => {
  const good = rubricCfg();
  assert.throws(() => new Gate({ rubric: { ...good, sha256: "0".repeat(64) } }), /tampered|does not match/);
  assert.throws(() => new Gate({ rubric: { spec: SPEC, advanceOn: ["done"] } }), /sha256/);
  assert.throws(() => new Gate({ rubric: { ...good, spec: { ...SPEC, goal: "other" } } }), /tampered|does not match/);
  assert.throws(() => new Gate({ rubric: "nope" }), /rubric must be a plain object/);
  assert.throws(() => new Gate({ rubric: [] }), /rubric must be a plain object/);
  assert.throws(() => new Gate({ rubric: { ...good, advanceOn: undefined } }), /advanceOn/);
  assert.throws(() => new Gate({ rubric: { ...good, advanceOn: [] } }), /advanceOn/);
  assert.throws(() => new Gate({ rubric: { ...good, advanceOn: [1] } }), /advanceOn/);
  assert.throws(() => new Gate({ rubric: { ...good, extra: 1 } }), /not a recognised key/);
  assert.throws(() => new Gate({ rubric: { ...good, spec: { ...SPEC, onExhausted: "ask" } , sha256: rubricSha({ ...SPEC, onExhausted: "ask" }) } }), /ask/);
  // maxReds / onExhausted are the SIGNED spec's, never gate keys
  assert.throws(() => new Gate({ rubric: good, maxReds: 3 }), /maxReds is not a gate key/);
  assert.throws(() => new Gate({ rubric: good, onExhausted: "fail" }), /onExhausted is not a gate key/);
  assert.doesNotThrow(() => new Gate({ rubric: { ...good, advanceOn: "done" } }));
});

test("accept: only valid on a requiresHuman checkpoint, live|later, and is part of the signature", () => {
  const mkSpec = (cp) => ({ schema: 1, goal: "g", checkpoints: { a: { gating: true, ...cp, checks: cap(5) } } });
  assert.throws(() => createRubric(mkSpec({ accept: "later" })), /requiresHuman/);
  assert.throws(() => createRubric(mkSpec({ requiresHuman: true, accept: "maybe" })), /live|later/);
  assert.doesNotThrow(() => createRubric(mkSpec({ requiresHuman: true, accept: "live" })));
  assert.notEqual(rubricSha(mkSpec({ requiresHuman: true, accept: "live" })), rubricSha(mkSpec({ requiresHuman: true, accept: "later" })));
});

// --- the mint ----------------------------------------------------------------

test("gate.checkStep mints, returns the StepResult, and there is no way to hand the gate a verdict", async (t) => {
  const { gate } = await mk(t);
  assert.equal(gate.mint, undefined, "no gate.mint exists");
  const r = await gate.checkStep("resume", BAD);
  assert.equal(r.verdict, "red");
  assert.equal(r.rubricSha, rubricSha(SPEC));
  assert.match(r.outputSha, /^[0-9a-f]{64}$/);
  assert.equal(r.gaps[0].key, "resume:cap");
  // a caller-supplied verdict / state is ignored, never trusted
  const forged = await gate.checkStep("resume", BAD, { verdict: "green", priorVerdicts: { resume: "green" } });
  assert.equal(forged.verdict, "red");
  await assert.rejects(() => gate.checkStep("resume", BAD, { priorBaselines: {} }), /priorBaselines is the gate's/);
  await assert.rejects(() => gate.checkStep("nope", BAD), /unknown checkpoint/);
  await assert.rejects(() => new Gate({}).checkStep("resume", BAD), /no rubric configured/);
});

// --- Law 9 ---------------------------------------------------------------------

test("Law 9: a green verdict on a floor-DENIED advance stays denied by the floor (rule is the floor's)", async (t) => {
  const { gate } = await mk(t, { tools: { denylist: ["done"] } });
  const r = await gate.checkStep("resume", OK);
  assert.equal(r.verdict, "green");
  const d = await gate.check(advance(r, "resume"));
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "tools.denylist", "the FLOOR decided, not the rubric");
});

test("Law 9: a floor ASK stays an ask with a green verdict; approving it still lets the rubric deny a red", async (t) => {
  const ch = makeHumanChannel([{ decision: "allow" }, { decision: "allow" }]);
  const { gate } = await mk(t, { flags: { provenance: { web: "ask" } }, humanChannel: ch });
  const g = await gate.checkStep("resume", OK);
  const d = await gate.check(advance(g, "resume", { provenance: "web" }));
  assert.equal(d.outcome, "allow");
  assert.equal(ch.events.length, 1);
  assert.equal(ch.events[0].rule, "flags.provenance", "the floor ask is the one raised");
  // red verdict + floor ask: the human approving the floor ask must not carry the advance
  const red = await gate.checkStep("resume", BAD);
  const d2 = await gate.check(advance(red, "resume", { provenance: "web" }));
  assert.equal(d2.outcome, "deny");
  assert.equal(d2.rule, "rubric.red");
});

test("Law 9: a rubric cannot turn a floor allow into anything but allow-or-deny: non-advance actions are untouched", async (t) => {
  const { gate } = await mk(t);
  assert.equal((await gate.check({ type: "bash", args: { command: "ls" } })).outcome, "allow");
});

// --- advanceOn: type OR tool (ruled 2026-10-08, fwdloop + bareloop consulted) ---------

test("advanceOn matches action.type OR a valid action.tool", async (t) => {
  const { gate } = await mk(t);
  const r = await gate.checkStep("resume", BAD, {});
  // tool matches, type is off-list -> examined (red)
  const a = await gate.check({ type: "x", tool: "done", checkpoint: "resume", outputSha: r.outputSha });
  assert.equal(a.outcome, "deny"); assert.equal(a.rule, "rubric.red");
  // type matches, tool is something else -> still examined
  const b = await gate.check({ type: "done", tool: "other", checkpoint: "resume", outputSha: r.outputSha });
  assert.equal(b.rule, "rubric.red");
  // tool:null is absent; type match still works
  const c = await gate.check({ type: "done", tool: null, checkpoint: "resume", outputSha: r.outputSha });
  assert.equal(c.rule, "rubric.red");
  // both off-list -> unaffected
  const d = await gate.check({ type: "x", tool: "y", checkpoint: "resume", outputSha: r.outputSha });
  assert.equal(d.outcome, "allow");
  const e = await gate.check({ type: "x", tool: null });
  assert.equal(e.outcome, "allow");
});

test("advanceOn: an invalid tool is never an advance match and never crashes; tools.invalidTool denies it under an allowlist", async (t) => {
  const { gate } = await mk(t);
  for (const bad of [42, "", {}, [], true]) {
    const x = await gate.check({ type: "x", tool: bad });
    assert.equal(x.outcome, "allow", `rubric alone does not treat tool ${JSON.stringify(bad)} as an advance`);
  }
  // type still matches with a bad tool: examined (unminted checkpoint here)
  const y = await gate.check({ type: "done", tool: 42, checkpoint: "resume" });
  assert.equal(y.outcome, "deny");
  // with a tools primitive configured the floor denies it first
  const g2 = new Gate({ rubric: rubricCfg(), tools: { allowlist: ["x", "done"] } });
  await g2.init();
  const z = await g2.check({ type: "x", tool: 42 });
  assert.equal(z.outcome, "deny"); assert.equal(z.rule, "tools.invalidTool");
});

// --- deny rules ----------------------------------------------------------------

test("each deny rule fires on its own case; non-gating never denies", async (t) => {
  const { gate } = await mk(t);
  // unminted: no verdict / unknown checkpoint / missing checkpoint
  assert.equal((await gate.check({ type: "done", checkpoint: "resume", outputSha: "a".repeat(64) })).rule, "rubric.unminted");
  assert.equal((await gate.check({ type: "done", checkpoint: "ghost", outputSha: "a" })).rule, "rubric.unminted");
  assert.equal((await gate.check({ type: "done" })).rule, "rubric.unminted");
  // red
  const red = await gate.checkStep("resume", BAD);
  assert.equal((await gate.check(advance(red, "resume"))).rule, "rubric.red");
  // stopped (seed notWorse with no measurement = missing-measurement)
  const st = await gate.checkStep("seeded", "x");
  assert.equal(st.verdict, "stopped");
  assert.deepEqual(st.gaps, []);
  assert.equal((await gate.check(advance(st, "seeded"))).rule, "rubric.stopped");
  // green allows
  const g = await gate.checkStep("resume", OK);
  assert.equal((await gate.check(advance(g, "resume"))).outcome, "allow");
  // non-gating: never denies, even red and unminted
  assert.equal((await gate.check({ type: "done", checkpoint: "note", outputSha: "z" })).outcome, "allow");
  const nred = await gate.checkStep("note", BAD);
  assert.equal(nred.verdict, "red");
  assert.equal((await gate.check(advance(nred, "note"))).outcome, "allow");
});

test("output-mismatch: a different sha, a missing sha, and a NULL (unbound) verdict sha all deny", async (t) => {
  const { gate } = await mk(t);
  const g = await gate.checkStep("resume", OK);
  const d = await gate.check({ type: "done", checkpoint: "resume", outputSha: "f".repeat(64) });
  assert.equal(d.rule, "rubric.output-mismatch");
  assert.equal((await gate.check({ type: "done", checkpoint: "resume" })).rule, "rubric.output-mismatch");
  assert.equal((await gate.check({ type: "done", checkpoint: "resume", outputSha: 7 })).rule, "rubric.output-mismatch");
  assert.equal((await gate.check(advance(g, "resume"))).outcome, "allow");
  // an object output with no outputBytes has outputSha null: unbound, can never match
  const spec2 = { schema: 1, goal: "g", checkpoints: { o: { gating: true, checks: [{ id: "n", rule: "nonEmpty", field: "a" }] } } };
  const gate2 = new Gate({ audit: { path: null }, rubric: rubricCfg(spec2) });
  const r = await gate2.checkStep("o", { a: "x" });
  assert.equal(r.verdict, "green");
  assert.equal(r.outputSha, null);
  for (const sha of [null, undefined, "null", ""]) {
    assert.equal((await gate2.check({ type: "done", checkpoint: "o", outputSha: sha })).rule, "rubric.output-mismatch");
  }
  // bound via outputBytes it passes
  const r2 = await gate2.checkStep("o", { a: "x" }, { outputBytes: JSON.stringify({ a: "x" }) });
  assert.equal((await gate2.check({ type: "done", checkpoint: "o", outputSha: r2.outputSha })).outcome, "allow");
});

test("a later mint replaces the earlier verdict (latest wins)", async (t) => {
  const { gate } = await mk(t);
  const g = await gate.checkStep("resume", OK);
  await gate.checkStep("resume", BAD);
  assert.equal((await gate.check(advance(g, "resume"))).rule, "rubric.red");
});

// --- requiresHuman (live) ---------------------------------------------------------

test("requiresHuman live: green + {decision:allow} allows and records an ACCEPT; asked ONCE per outputSha", async (t) => {
  const ch = makeHumanChannel([{ decision: "allow" }]);
  const { gate, auditPath } = await mk(t, { humanChannel: ch });
  const r = await gate.checkStep("review", OK);
  const d = await gate.check(advance(r, "review"));
  assert.equal(d.outcome, "allow");
  assert.equal(ch.events.length, 1);
  const ev = ch.events[0];
  assert.equal(ev.rule, "rubric.needs-accept");
  assert.deepEqual(ev.rubric, { rubricSha: rubricSha(SPEC), checkpoint: "review", outputSha: r.outputSha, verdict: "green", gaps: [] });
  const acc = lines(auditPath).filter((l) => l.phase === "rubric_accept");
  assert.equal(acc.length, 1);
  assert.deepEqual([acc[0].checkpoint, acc[0].outputSha, acc[0].source], ["review", r.outputSha, "live"]);
  // second advance for the same sha: no new ask
  assert.equal((await gate.check(advance(r, "review"))).outcome, "allow");
  assert.equal(ch.events.length, 1, "asked once per outputSha");
});

test("requiresHuman live: green + deny / anything else / timeout / no channel all deny; red or stopped never ask", async (t) => {
  for (const reply of [{ decision: "deny", reason: "no" }, { decision: "topup", newCap: 5 }, { decision: "terminate" }, {}, null, { approved: true }]) {
    const ch = makeHumanChannel([reply]);
    const { gate } = await mk(t, { humanChannel: ch });
    const r = await gate.checkStep("review", OK);
    const d = await gate.check(advance(r, "review"));
    assert.equal(d.outcome, "deny", JSON.stringify(reply));
    assert.equal(d.rule, "rubric.needs-accept", JSON.stringify(reply));
    // and nothing was recorded: the next advance asks again
    assert.equal(lines(gate.audit.filePath).filter((l) => l.phase === "rubric_accept").length, 0);
  }
  const { gate: noCh } = await mk(t);
  const r = await noCh.checkStep("review", OK);
  assert.equal((await noCh.check(advance(r, "review"))).rule, "rubric.needs-accept");
  // timeout
  const { gate: slow } = await mk(t, { humanChannel: () => new Promise(() => {}), humanChannelTimeoutMs: 20 });
  const r2 = await slow.checkStep("review", OK);
  const d2 = await slow.check(advance(r2, "review"));
  assert.equal(d2.outcome, "deny");
  assert.equal(d2.rule, "rubric.needs-accept");
  // red never reaches the human
  const ch3 = makeHumanChannel([]);
  const { gate: g3 } = await mk(t, { humanChannel: ch3 });
  const red = await g3.checkStep("review", BAD);
  assert.equal((await g3.check(advance(red, "review"))).rule, "rubric.red");
  assert.equal(ch3.events.length, 0);
});

test("requiresHuman: an ACCEPT bound to one outputSha does not unlock a different outputSha (asks again)", async (t) => {
  const ch = makeHumanChannel([{ decision: "allow" }, { decision: "deny" }]);
  const { gate } = await mk(t, { humanChannel: ch });
  const a = await gate.checkStep("review", "one two three");
  assert.equal((await gate.check(advance(a, "review"))).outcome, "allow");
  const b = await gate.checkStep("review", "four five six");
  assert.notEqual(a.outputSha, b.outputSha);
  const d = await gate.check(advance(b, "review"));
  assert.equal(ch.events.length, 2, "the new sha is asked again");
  assert.equal(d.outcome, "deny");
  // and the OLD sha's advance is now a mismatch (latest verdict is b's)
  assert.equal((await gate.check(advance(a, "review"))).rule, "rubric.output-mismatch");
});

// --- requiresHuman (later) / recordAccept -------------------------------------------

test("accept:'later': advance is denied needs-accept with NO live ask; recordAccept (harness) unlocks exactly that sha", async (t) => {
  const ch = makeHumanChannel([]);
  const { gate, auditPath } = await mk(t, { humanChannel: ch });
  const r = await gate.checkStep("parked", OK);
  const d = await gate.check(advance(r, "parked"));
  assert.equal(d.rule, "rubric.needs-accept");
  assert.equal(ch.events.length, 0, "no live ask on a later checkpoint");
  await gate.recordAccept({ checkpoint: "parked", outputSha: r.outputSha, by: "hamr", askId: "ask-1" });
  assert.equal((await gate.check(advance(r, "parked"))).outcome, "allow");
  const acc = lines(auditPath).find((l) => l.phase === "rubric_accept");
  assert.deepEqual([acc.by, acc.askId, acc.source, acc.outputSha], ["hamr", "ask-1", "later", r.outputSha]);
});

test("recordAccept is refused (throws + audit line) on a live checkpoint, a non-requiresHuman one, a non-green verdict, a wrong sha, no verdict, blank by", async (t) => {
  const { gate, auditPath } = await mk(t);
  const live = await gate.checkStep("review", OK);
  const plain = await gate.checkStep("resume", OK);
  const red = await gate.checkStep("parked", BAD);
  await assert.rejects(() => gate.recordAccept({ checkpoint: "review", outputSha: live.outputSha, by: "h" }), /accept: "live"/);
  await assert.rejects(() => gate.recordAccept({ checkpoint: "resume", outputSha: plain.outputSha, by: "h" }), /not requiresHuman/);
  await assert.rejects(() => gate.recordAccept({ checkpoint: "parked", outputSha: red.outputSha, by: "h" }), /no green verdict/);
  const green = await gate.checkStep("parked", OK);
  await assert.rejects(() => gate.recordAccept({ checkpoint: "parked", outputSha: "e".repeat(64), by: "h" }), /outputSha is not the one/);
  await assert.rejects(() => gate.recordAccept({ checkpoint: "parked", outputSha: green.outputSha, by: " " }), /by must name/);
  await assert.rejects(() => gate.recordAccept({ checkpoint: "ghost", outputSha: green.outputSha, by: "h" }), /unknown checkpoint/);
  await assert.rejects(() => gate.recordAccept(null), TypeError);
  const spec2 = { ...SPEC, checkpoints: { parked: SPEC.checkpoints.parked } };
  const { gate: fresh } = await mk(t, { rubric: rubricCfg(spec2) });
  await assert.rejects(() => fresh.recordAccept({ checkpoint: "parked", outputSha: green.outputSha, by: "h" }), /no green verdict/);
  const refusals = lines(auditPath).filter((l) => l.phase === "rubric_accept_refused");
  assert.equal(refusals.length, 6);
  assert.equal(lines(auditPath).filter((l) => l.phase === "rubric_accept").length, 0);
  // none of the refusals unlocked the advance
  assert.equal((await gate.check(advance(green, "parked"))).rule, "rubric.needs-accept");
  await assert.rejects(() => new Gate({}).recordAccept({}), /no rubric/);
});

// --- drainGaps ----------------------------------------------------------------------

test("drainGaps: clears on read; worker view only (no rule text, no stopped fault); a newer mint replaces", async (t) => {
  const spec = { schema: 1, goal: "g", checkpoints: {
    a: { gating: true, checks: [{ id: "cap", rule: "maxWords", field: "text", value: 2, text: "SECRET RULE TEXT: keep it short" }] },
    s: { gating: true, checks: [{ id: "n", rule: "notWorse", direction: "lower-is-better", baseline: "seed" }] },
  } };
  const { gate } = await mk(t, { rubric: rubricCfg(spec) });
  assert.deepEqual(gate.drainGaps(), []);
  await gate.checkStep("a", "one two three four");
  const stopped = await gate.checkStep("s", "x");
  assert.equal(stopped.verdict, "stopped");
  const gaps = gate.drainGaps();
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].key, "a:cap");
  assert.ok(!JSON.stringify(gaps).includes("SECRET RULE TEXT"), "no rule text");
  assert.ok(!JSON.stringify(gaps).includes("fault") && !JSON.stringify(gaps).includes("missing-measurement"));
  assert.deepEqual(gate.drainGaps(), [], "cleared on read");
  gaps[0].measured = 999; // a copy: mutating it does nothing to later drains
  await gate.checkStep("a", "one two three four");
  await gate.checkStep("a", "one two three four five");
  const again = gate.drainGaps();
  assert.equal(again.length, 1, "the newer mint replaced the earlier try's gaps");
  assert.equal(again[0].measured, 5);
  await gate.checkStep("a", "ok");
  assert.deepEqual(gate.drainGaps(), [], "a green mint leaves no stale gap");
  assert.deepEqual(new Gate({}).drainGaps(), []);
});

// --- audit ---------------------------------------------------------------------------

test("the audit rubric line exists with the contract fields; a stopped line carries the fault", async (t) => {
  const { gate, auditPath } = await mk(t);
  const r = await gate.checkStep("resume", BAD);
  await gate.checkStep("seeded", "x");
  const ls = lines(auditPath).filter((l) => l.phase === "rubric");
  assert.equal(ls.length, 2);
  assert.deepEqual([ls[0].rubricSha, ls[0].checkpoint, ls[0].verdict, ls[0].outputSha], [rubricSha(SPEC), "resume", "red", r.outputSha]);
  assert.equal(ls[0].gaps[0].key, "resume:cap");
  assert.equal(ls[0].gapsTotal, 1);
  assert.equal(ls[0].reds, 1);
  assert.equal(ls[1].verdict, "stopped");
  assert.equal(ls[1].fault.kind, "missing-measurement");
  assert.equal(ls[1].gaps, undefined, "stopped carries no gaps");
});

test("the audit rubric line is bounded under a huge gap set and redacts a secret in a gap", async (t) => {
  const spec = { schema: 1, goal: "g", checkpoints: { big: { gating: true, checks: [
    { id: "keys", rule: "in", field: "k", values: ["ok"] },
    ...Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, rule: "in", field: "f" + i, values: ["ok"] })),
  ] } } };
  const out = { k: "Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789SECRET" };
  for (let i = 0; i < 60; i++) out["f" + i] = "x".repeat(300);
  const { gate, auditPath } = await mk(t, { rubric: rubricCfg(spec) });
  const r = await gate.checkStep("big", out);
  assert.equal(r.verdict, "red");
  assert.ok(r.gaps.length > 20);
  const raw = fs.readFileSync(auditPath, "utf8").split("\n").filter((l) => l.includes('"phase":"rubric"'))[0];
  assert.ok(Buffer.byteLength(raw + "\n", "utf8") <= 3500, `line was ${Buffer.byteLength(raw)} bytes`);
  assert.ok(!raw.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789SECRET"), "secret redacted");
  const line = JSON.parse(raw);
  assert.equal(line.verdict, "red");
  assert.equal(line.outputSha, r.outputSha, "state carriers survive the bound");
  assert.equal(line.rubricSha, rubricSha(spec));
  assert.equal(line.checkpoint, "big");
  // and a secret in the FIRST (small) gap is redacted when the line fits
  const spec1 = { schema: 1, goal: "g", checkpoints: { s: { gating: true, checks: [{ id: "k", rule: "in", field: "k", values: ["ok"] }] } } };
  const { gate: g1, auditPath: p1 } = await mk(t, { rubric: rubricCfg(spec1) });
  await g1.checkStep("s", { k: "Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789SECRET" });
  const raw1 = fs.readFileSync(p1, "utf8");
  assert.ok(!raw1.includes("0123456789SECRET"));
  assert.match(raw1, /REDACTED/);
});

// --- invalid at runtime ------------------------------------------------------------------

test("runtime config swap to an invalid shape / a different signature -> rubric.invalid (every action), checkStep refuses", async (t) => {
  for (const mutate of [
    (g) => { g.cfg.rubric = "garbage"; },
    (g) => { g.cfg.rubric = { ...g.cfg.rubric, advanceOn: 5 }; },
    (g) => { g.cfg.rubric = { ...g.cfg.rubric, sha256: "0".repeat(64) }; },
    (g) => { g.cfg.rubric = null; },
  ]) {
    const { gate } = await mk(t);
    const r = await gate.checkStep("resume", OK);
    mutate(gate);
    const d = await gate.check(advance(r, "resume"));
    assert.deepEqual([d.outcome, d.rule], ["deny", "rubric.invalid"]);
    assert.equal((await gate.check({ type: "bash", args: { command: "ls" } })).rule, "rubric.invalid", "fail closed for every action");
    await assert.rejects(() => gate.checkStep("resume", OK), /rubric.invalid/);
  }
  // a floor deny still wins its own rule over rubric.invalid
  const { gate } = await mk(t, { tools: { denylist: ["x"] } });
  gate.cfg.rubric = "garbage";
  assert.equal((await gate.check({ type: "x" })).rule, "tools.denylist");
});

test("every deny rule string is distinct", () => {
  const rules = ["rubric.invalid", "rubric.red", "rubric.stopped", "rubric.unminted", "rubric.output-mismatch", "rubric.exhausted", "rubric.needs-accept"];
  assert.equal(new Set(rules).size, rules.length);
});

// --- maxReds -------------------------------------------------------------------------------

test("maxReds absent = no cap; set = rubric.exhausted at the count (stopped does not count)", async (t) => {
  const { gate: nocap } = await mk(t);
  for (let i = 0; i < 10; i++) await nocap.checkStep("resume", BAD);
  const g = await nocap.checkStep("resume", OK);
  assert.equal((await nocap.check(advance(g, "resume"))).outcome, "allow", "no cap: never exhausted");

  const { gate } = await mk(t, { rubric: rubricCfg({ ...SPEC, maxReds: 3 }) });
  await gate.checkStep("resume", BAD);
  await gate.checkStep("seeded", "x"); // stopped: other checkpoint AND not a red
  await gate.checkStep("resume", BAD);
  const ok = await gate.checkStep("resume", OK);
  assert.equal((await gate.check(advance(ok, "resume"))).outcome, "allow", "2 reds < maxReds 3");
  await gate.checkStep("resume", BAD);                    // 3rd red
  const g2 = await gate.checkStep("resume", OK);
  const d = await gate.check(advance(g2, "resume"));
  assert.deepEqual([d.outcome, d.rule], ["deny", "rubric.exhausted"]);
  // counted per checkpoint: another checkpoint is unaffected
  const other = await gate.checkStep("note", OK);
  assert.equal((await gate.check(advance(other, "note"))).outcome, "allow");
});

test("a re-sign (new rubricSha) resets the red count; an ACCEPT at that requiresHuman checkpoint resets it; nothing else does", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath, runId } = uniquePaths(dir);
  const mkG = async (spec, extra = {}) => { const g = new Gate({ audit: { path: auditPath }, runId, rubric: rubricCfg(spec), ...extra }); await g.init(); return g; };
  const specA = { ...SPEC, maxReds: 2 };
  const a = await mkG(specA);
  await a.checkStep("resume", BAD); await a.checkStep("resume", BAD);
  const gA = await a.checkStep("resume", OK);
  assert.equal((await a.check(advance(gA, "resume"))).rule, "rubric.exhausted");
  // re-sign: a different signed spec (new sha) on the same run starts clean
  const specB = { ...specA, goal: "g (re-signed)" };
  const b = await mkG(specB);
  const gB = await b.checkStep("resume", OK);
  assert.equal((await b.check(advance(gB, "resume"))).outcome, "allow");
  // ACCEPT resets at a requiresHuman checkpoint
  const ch = makeHumanChannel([{ decision: "allow" }]);
  const c = await mkG(specB, { humanChannel: ch });
  await c.checkStep("review", BAD);
  const rv = await c.checkStep("review", OK);
  assert.equal((await c.check(advance(rv, "review"))).outcome, "allow");
  assert.equal(lines(auditPath).filter((l) => l.phase === "rubric" && l.rubricSha === rubricSha(specB) && l.checkpoint === "review" && l.verdict === "red").length, 1);
  await c.checkStep("review", BAD); // a 2nd red AFTER the accept: count is 1, not 2 -> not exhausted
  const rv2 = await c.checkStep("review", OK);
  const d = await c.check(advance(rv2, "review"));
  assert.notEqual(d.rule, "rubric.exhausted");
});

// --- no rubric: unchanged --------------------------------------------------------------------

test("no rubric config: gate behaviour is unchanged (decisions, audit lines, methods inert)", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const base = { tools: { denylist: ["bad"] }, bash: { allow: ["ls"] }, flags: { provenance: { web: "ask" } } };
  const run = async (extra) => {
    const p = uniquePaths(dir);
    const ch = makeHumanChannel([{ decision: "allow" }]);
    const g = new Gate({ ...base, audit: { path: p.auditPath }, runId: "fixed", rootRunId: "fixed", humanChannel: ch, _clock: () => 0, ...extra });
    await g.init();
    const out = [];
    for (const a of [{ type: "bad" }, { type: "bash", args: { command: "ls" } }, { type: "x", provenance: "web" }, { type: "done", checkpoint: "resume", outputSha: "q" }]) out.push(await g.check(a));
    return { out: out.map(({ aid, ...d }) => d), audit: lines(p.auditPath).map(({ aid, ...l }) => l), events: ch.events.map((e) => e.rule) };
  };
  const plain = await run({});
  const withNull = await run({ rubric: null });
  assert.deepEqual(withNull, plain);
  assert.ok(plain.audit.every((l) => !String(l.phase).startsWith("rubric")));
  assert.equal(plain.out[3].outcome, "allow", "an 'advance'-shaped action means nothing without a rubric");
});

// --- concurrency ---------------------------------------------------------------------------------

test("concurrent checkStep + advance checks: audit line order = decision order", async (t) => {
  const { gate, auditPath } = await mk(t);
  const green = await gate.checkStep("resume", OK);
  // fire a red mint and 6 advances for the green sha at the same time
  const mint = gate.checkStep("resume", BAD);
  const checks = Array.from({ length: 6 }, () => gate.check(advance(green, "resume")));
  const [, ...ds] = await Promise.all([mint, ...checks]);
  const ls = lines(auditPath);
  const mintIdx = ls.findIndex((l) => l.phase === "rubric" && l.verdict === "red");
  const decisions = ls.filter((l) => l.phase === "gate" && l.action?.type === "done");
  assert.equal(decisions.length, 6);
  assert.equal(ds.length, 6);
  // every decision line is consistent with its position relative to the mint line
  for (const dl of decisions) {
    const pos = ls.indexOf(dl);
    if (pos < mintIdx) assert.equal(dl.decision, "allow", "before the red mint line: allowed");
    else {
      assert.equal(dl.decision, "deny", "after the red mint line: denied");
      assert.ok(["rubric.red", "rubric.output-mismatch"].includes(dl.rule));
    }
  }
  // the returned decisions agree with their audit lines
  const byAid = new Map(decisions.map((l) => [l.aid, l]));
  for (const d of ds) assert.equal(byAid.get(d.aid).decision, d.outcome);
});

test("construct: a rubric spec with a NUL in a check id or checkpoint name throws (no silently re-seeded baseline)", () => {
  const seed = { rule: "notWorse", direction: "lower-is-better", baseline: "seed" };
  const badId = { schema: 1, goal: "g", checkpoints: { seeded: { gating: true, checks: [{ id: "n\0x", ...seed }] } } };
  const badCp = { schema: 1, goal: "g", checkpoints: { "se\0eded": { gating: true, checks: [{ id: "n", ...seed }] } } };
  for (const spec of [badId, badCp]) {
    assert.throws(() => new Gate({ rubric: rubricCfg(spec) }), /NUL/);
  }
});
