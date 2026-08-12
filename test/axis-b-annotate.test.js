// Axis B — gate.annotate (§6.6/§8.2). The thin return-time-judge primitive:
// bareguard buffers a CALLER-computed fact, audits it (sink 1), lets it ride the
// next human ask (sink 3), and drains it for agent feedback (sink 2). bareguard
// never runs an LLM and never decides an outcome. These are the §8.2.4 acceptance
// tests; each is mutation-verified to fail when the routing/wiring breaks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Gate, routeAnnotation } from "../src/index.js";
import { makeHumanChannel, makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

// pure-allow content (disable shipped safe-default patterns) + a structured flag
// to raise a CONTROLLED ask, so we observe only Axis-B behavior.
const PURE = { denyPatterns: [], askPatterns: [] };
const ASKFLAG = { needsReview: { yes: "ask" } };
const asks = (action = {}) => ({ type: "book", needsReview: "yes", ...action });

// §8.2.4 #1 — annotate() buffers, and the next HITL check() carries the facts.
test("annotate() buffers; the next ask check() carries the fact in its event", async () => {
  const channel = makeHumanChannel([{ decision: "allow" }]);
  const gate = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: channel });
  await gate.init();
  await gate.annotate({ surface: true, verdict: "broke", where: "you said under €300; the booking is €400" });
  const decision = await gate.check(asks());
  assert.equal(decision.outcome, "allow");
  assert.equal(channel.events.length, 1, "the ask reached the human channel");
  const ann = channel.events[0].annotations;
  assert.ok(Array.isArray(ann) && ann.length === 1, "event carries one annotation");
  assert.equal(ann[0].surface, true);
  assert.equal(ann[0].verdict, "broke");
  assert.equal(ann[0].where, "you said under €300; the booking is €400");
});

// §8.2.4 #2 — the routing function, every surface × reversible × knob cell.
test("routeAnnotation covers every surface × reversible × knob cell (§8.2.2)", () => {
  // honored (surface=false): never surfaced; reversible decides pass vs floor-ride.
  assert.equal(routeAnnotation(false, true,  "strict"),  "pass");
  assert.equal(routeAnnotation(false, false, "strict"),  "annotate-floor-ask");
  assert.equal(routeAnnotation(false, true,  "relaxed"), "pass");
  assert.equal(routeAnnotation(false, false, "relaxed"), "annotate-floor-ask");
  // broke (surface=true): irreversible always rides A's stop (knob irrelevant)...
  assert.equal(routeAnnotation(true, false, "strict"),  "annotate-floor-ask");
  assert.equal(routeAnnotation(true, false, "relaxed"), "annotate-floor-ask");
  // ...reversible is the only place the knob bites.
  assert.equal(routeAnnotation(true, true, "strict"),  "HITL");
  assert.equal(routeAnnotation(true, true, "relaxed"), "log");
  // default knob is strict.
  assert.equal(routeAnnotation(true, true), "HITL");
});

// §8.2.4 #3 — reversibility is read from the GATED ACTION's type, not the fact.
test("reversibility comes from the action's type (operator config), never the fact", async () => {
  // (a) fact lies with reversible:true, but the action type is NOT operator-declared
  // reversible → treated irreversible → surfaces even under relaxed. The fact's own
  // field is ignored; if it weren't, relaxed would have suppressed it.
  const ch1 = makeHumanChannel([{ decision: "allow" }]);
  const g1 = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: ch1,
    axisB: { reversibleEscalation: "relaxed", reversible: [] } });
  await g1.init();
  await g1.annotate({ surface: true, reversible: true, where: "x" });
  await g1.check(asks({ type: "book" }));
  assert.ok(ch1.events[0].annotations, "fact's reversible:true did NOT relax it — action type governs");

  // (b) same relaxed knob, but the ACTION's type IS declared reversible → log-only,
  // not attached. Proves the action drove the routing, not the fact.
  const ch2 = makeHumanChannel([{ decision: "allow" }]);
  const g2 = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: ch2,
    axisB: { reversibleEscalation: "relaxed", reversible: ["recall"] } });
  await g2.init();
  await g2.annotate({ surface: true, where: "x" });
  await g2.check(asks({ type: "recall" }));
  assert.equal(ch2.events[0].annotations, undefined, "reversible action + relaxed → logged, not surfaced");
});

// §8.2.4 #4 — facts hit the audit line AND are returned for agent feedback.
test("annotate audits the fact (sink 1) and drainAnnotations returns it (sink 2)", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.annotate({ surface: true, verdict: "broke", where: "w", meta: { field: "price" } });
  const lines = (await gate.audit.readAll()).filter((l) => l.phase === "annotate");
  assert.equal(lines.length, 1, "one annotate audit line");
  assert.equal(lines[0].where, "w");
  assert.equal(lines[0].surface, true);

  const drained = gate.drainAnnotations();
  assert.equal(drained.length, 1, "drain returns the buffered fact");
  assert.equal(drained[0].verdict, "broke");
  assert.deepEqual(drained[0].meta, { field: "price" });
  assert.equal(gate.drainAnnotations().length, 0, "drain clears the buffer");
});

// §8.2.4 #5 — no annotate() ⇒ byte-identical decision path (additive).
test("no annotate() ⇒ the event has no annotations key (no regression)", async () => {
  const channel = makeHumanChannel([{ decision: "allow" }]);
  const gate = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: channel });
  await gate.init();
  const decision = await gate.check(asks());
  assert.equal(decision.outcome, "allow");
  assert.equal("annotations" in channel.events[0], false, "untouched event has no annotations key");
});

// §8.2.4 #6 — knob defaults to strict; relaxed never interrupts a reversible path.
test("knob default is strict; B never creates an interrupt on a reversible path", async () => {
  // default knob (omitted) is strict → reversible broke rides the ask.
  const chS = makeHumanChannel([{ decision: "allow" }]);
  const gS = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: chS,
    axisB: { reversible: ["recall"] } });
  await gS.init();
  await gS.annotate({ surface: true, where: "x" });
  await gS.check(asks({ type: "recall" }));
  assert.ok(chS.events[0].annotations, "default knob is strict → reversible broke surfaces");

  // B never CREATES a stop: a reversible action with no floor ask → no human call.
  const chN = makeHumanChannel([]); // throws if ever called
  const gN = new Gate({ audit: { path: null }, content: PURE, humanChannel: chN,
    axisB: { reversibleEscalation: "relaxed", reversible: ["recall"] } });
  await gN.init();
  await gN.annotate({ surface: true, where: "x" });
  const dN = await gN.check({ type: "recall" }); // allowed, no floor ask
  assert.equal(dN.outcome, "allow");
  assert.equal(chN.events.length, 0, "B raised no human ask on a reversible path");
});

// §8.2.4 #7 — B never auto-rejects: worst case is HITL, never a B-authored deny.
test("annotate never turns an allow into a deny (B never blocks alone)", async () => {
  const gate = new Gate({ audit: { path: null }, content: PURE });
  await gate.init();
  await gate.annotate({ surface: true, verdict: "broke", where: "bad booking" });
  const d = await gate.check({ type: "anything" });
  assert.equal(d.outcome, "allow", "a surface fact cannot flip an allowed action to deny");
  assert.notEqual(d.rule, "axisB", "no Axis-B-authored decision rule exists");
});

// Security: the annotate audit line must not persist raw secrets in where/meta.
test("annotate audit line redacts secrets in where/meta (redaction is audit-only)", async () => {
  const gate = new Gate({ audit: { path: null }, secrets: { patterns: [/sk-[A-Za-z0-9]+/] } });
  await gate.init();
  await gate.annotate({ surface: true, where: "reply leaked sk-ABC123", meta: { token: "sk-XYZ789" } });
  const line = (await gate.audit.readAll()).find((l) => l.phase === "annotate");
  const serialized = JSON.stringify(line);
  assert.ok(!serialized.includes("sk-ABC123"), "where secret not persisted raw");
  assert.ok(!serialized.includes("sk-XYZ789"), "meta secret not persisted raw");
  // the live fact (drain / humanChannel) keeps the real value — redaction is audit-only.
  assert.equal(gate.drainAnnotations()[0].where, "reply leaked sk-ABC123");
});

// Security: oversized fields are bounded so the annotate audit line stays atomic.
test("annotate bounds oversized verdict/where/meta (audit line stays under PIPE_BUF)", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const huge = "x".repeat(5000);
  await gate.annotate({ surface: true, verdict: huge, where: huge, meta: { blob: "y".repeat(5000) } });
  const fact = gate.drainAnnotations()[0];
  assert.ok(fact.where.length <= 300, "where bounded to 300 chars");
  assert.ok(fact.verdict.length <= 80, "verdict bounded to 80 chars");
  assert.equal(fact.meta._truncated, true, "oversized meta replaced with a marker");
  const line = (await gate.audit.readAll()).find((l) => l.phase === "annotate");
  assert.ok(Buffer.byteLength(JSON.stringify(line), "utf8") < 3500, "annotate audit line under the atomic-append cap");
});

// Security: redaction EXPANDS matches; the persisted line must stay atomic anyway.
// (Uses a real file — fileless mode skips truncation by design — and an expanding
// redactor: each /a/ match becomes a ~22-byte [REDACTED:...] tag.)
test("annotate audit line stays atomic when redaction expands where/meta (file path)", async () => {
  const dir = await makeTmpDir();
  try {
    const { auditPath } = uniquePaths(dir);
    const gate = new Gate({ audit: { path: auditPath }, secrets: { patterns: [/a/] } });
    await gate.init();
    await gate.annotate({ surface: true, where: "a".repeat(300), meta: { k: "a".repeat(300) } });
    const raw = await readFile(auditPath, "utf8");
    for (const l of raw.split("\n").filter(Boolean)) {
      const bytes = Buffer.byteLength(l + "\n", "utf8");
      assert.ok(bytes <= 3500, `audit line must stay under the atomic-append cap; got ${bytes} bytes`);
    }
  } finally {
    await cleanup(dir);
  }
});

// The bounds above cap SIZE. These four pin the LOSS SHAPE the `Annotation` typedef
// documents — how a caller finds out (or doesn't) that a field was cut. A judge author
// sizes their output against these, so a doc claim that drifts from the code is a
// silent data-loss path, not a typo.

// `where` clips SILENTLY: the fact carries no marker, so an over-long `where` is
// indistinguishable from one that always fit. This is why `where` is documented as a
// one-line ADDRESS and never a place for bulk evidence.
test("where clips silently — the clipped fact carries no truncation marker", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const addresses = Array.from({ length: 8 }, (_, i) =>
    `src/backup.js(${56 + i},48): error TS1016: A required parameter cannot follow an optional parameter.`).join(" ");
  assert.ok(addresses.length > 300, "fixture must exceed the cap or the test proves nothing");
  await gate.annotate({ surface: true, where: addresses });
  const fact = gate.drainAnnotations()[0];
  assert.equal(fact.where.length, 300, "clipped to exactly the cap");
  assert.ok(!fact.where.includes("TRUNCAT"), "no marker is appended");
  assert.equal(fact._truncated, undefined, "no flag anywhere on the fact");
  assert.ok(!addresses.startsWith(fact.where) === false, "it is a prefix — the tail is simply gone");
});

// `meta` is ALL-OR-NOTHING: over the cap the WHOLE object is replaced, so bulky
// evidence takes field/stated/returned down with it. This is the clause BA-20's
// judge contract depends on; the boundary is asserted from both sides.
test("meta over the cap loses EVERY key, not just the bulky one", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.annotate({
    surface: true,
    meta: { field: "price", stated: 300, returned: 400, evidence: "x".repeat(1200) },
  });
  const fact = gate.drainAnnotations()[0];
  assert.equal(fact.meta._truncated, true, "replaced by a marker (loud, unlike where)");
  assert.equal(fact.meta.field, undefined, "the mechanical fields are collateral damage");
  assert.equal(fact.meta.stated, undefined);
  assert.equal(fact.meta.returned, undefined);
});

test("the meta cap boundary: at 1000 bytes it survives, one byte over loses everything", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  const sized = (bytes) => {
    const meta = { e: "x".repeat(bytes - Buffer.byteLength(JSON.stringify({ e: "" }), "utf8")) };
    assert.equal(Buffer.byteLength(JSON.stringify(meta), "utf8"), bytes, "fixture sized exactly");
    return meta;
  };
  await gate.annotate({ surface: true, meta: sized(1000) });
  await gate.annotate({ surface: true, meta: sized(1001) });
  const [at, over] = gate.drainAnnotations();
  assert.equal(at.meta._truncated, undefined, "exactly at the cap rides intact");
  assert.equal(over.meta._truncated, true, "one byte over is replaced wholesale");
});

// The fail-open that BA-20's criterion 7 exists to catch, pinned from bareguard's side:
// annotate() normalizes strictly and NEVER throws, so a fact built to the retired
// pre-E6 sketch shape has every key dropped and `surface` defaults false — the fact
// then routes as `honored` and no human ever sees it.
test("a sketch-shaped fact fails OPEN: unknown keys dropped, surface defaults false", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  await gate.annotate({ kind: "violation", field: "price", stated: 300, returned: 400, text: "€400 exceeds €300" });
  const fact = gate.drainAnnotations()[0];
  assert.equal(fact.surface, false, "surface defaults false — this is the fail-open");
  assert.equal(fact.verdict, null, "`kind` is not a field and carries nothing");
  assert.equal(fact.where, null, "`text` is not the field name; `where` is");
  assert.equal(fact.meta, null, "top-level field/stated/returned do not reach meta");
  assert.equal(routeAnnotation(fact.surface, true, "strict"), "pass", "routes as honored — invisible");
});

test("a non-object fact is ignored entirely and annotate never throws", async () => {
  const gate = new Gate({ audit: { path: null } });
  await gate.init();
  for (const junk of [null, undefined, "broke", 42, true]) {
    await gate.annotate(junk); // must not throw into the agent loop
  }
  assert.equal(gate.drainAnnotations().length, 0, "nothing buffered from junk");
});

// honored facts (surface=false) never reach the human, even on an ask.
test("a honored fact (surface=false) is not attached to the ask", async () => {
  const channel = makeHumanChannel([{ decision: "allow" }]);
  const gate = new Gate({ audit: { path: null }, content: PURE, flags: ASKFLAG, humanChannel: channel });
  await gate.init();
  await gate.annotate({ surface: false, verdict: "honored", where: "all good" });
  await gate.check(asks());
  assert.equal(channel.events[0].annotations, undefined, "honored ⇒ nothing to surface");
});
