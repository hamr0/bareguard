// rwx.askUnheld (ruling #70, requested by the barebox sandbox). An entry whose
// letter the agent does NOT hold asks (rwx.ask) instead of denying rwx.denied,
// for the letters listed. Default [] is byte-identical to before.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { rwxCheck } from "../src/primitives/rwx.js";
import { REAL_SLASH_TMP } from "./_helpers.js";

const X = REAL_SLASH_TMP + "/x";

function rwxCfg(over = {}) {
  return {
    agent: "reader",
    agents: { reader: "r--", ghost: "---" },
    tools: {
      read: "r",
      write: "w",
      edit: { letter: "w", marker: "tight" },
      deploy: "x",
    },
    bash: { "git status": "r", "git commit": "w", "git push": "x" },
    ...over,
  };
}

function gateFor(rwxOver = {}, humanChannel) {
  return new Gate({
    audit: { path: null },
    fs: { readScope: [REAL_SLASH_TMP], writeScope: [REAL_SLASH_TMP] },
    rwx: rwxCfg(rwxOver),
    ...(humanChannel ? { humanChannel } : {}),
  });
}

// ─── defaults are byte-identical ────────────────────────────────────────────

test("askUnheld: unset, null and [] all deny rwx.denied identically", () => {
  const act = { type: "deploy" };
  const base = rwxCheck(act, rwxCfg());
  assert.equal(base.rule, "rwx.denied");
  assert.deepEqual(rwxCheck(act, rwxCfg({ askUnheld: null })), base);
  assert.deepEqual(rwxCheck(act, rwxCfg({ askUnheld: [] })), base);
  const bash = { type: "bash", cmd: "git push" };
  const b = rwxCheck(bash, rwxCfg());
  assert.equal(b.rule, "rwx.denied");
  assert.deepEqual(rwxCheck(bash, rwxCfg({ askUnheld: [] })), b);
});

// ─── construct-time validation ──────────────────────────────────────────────

test("askUnheld: construct throws for non-array, bad element, non-string, duplicate", () => {
  const mk = (v) => () => new Gate({ audit: { path: null }, rwx: rwxCfg({ askUnheld: v }) });
  assert.throws(mk("x"), /invalid bareguard config: rwx\.askUnheld must be an array/);
  assert.throws(mk({ 0: "x" }), /rwx\.askUnheld must be an array/);
  assert.throws(mk(["q"]), /invalid bareguard config: rwx\.askUnheld elements must each be/);
  assert.throws(mk(["rw"]), /rwx\.askUnheld elements/);
  assert.throws(mk([1]), /rwx\.askUnheld elements/);
  assert.throws(mk([null]), /rwx\.askUnheld elements/);
  assert.throws(mk(["x", "x"]), /invalid bareguard config: rwx\.askUnheld has a duplicate/);
  assert.doesNotThrow(mk(["r", "w", "x"]));
  assert.doesNotThrow(mk([]));
  assert.doesNotThrow(mk(null));
});

// ─── TOCTOU fallback ────────────────────────────────────────────────────────

test("askUnheld: a value made unusable AFTER construct falls back to [] (deny)", () => {
  for (const bad of ["x", ["q"], ["x", "x"], [1], { length: 1, 0: "x" }]) {
    const cfg = rwxCfg({ askUnheld: ["x"] });
    assert.equal(rwxCheck({ type: "deploy" }, cfg).rule, "rwx.ask"); // sanity: valid asks
    cfg.askUnheld = bad;
    assert.equal(rwxCheck({ type: "deploy" }, cfg).rule, "rwx.denied", JSON.stringify(bad));
    assert.equal(rwxCheck({ type: "bash", cmd: "git push" }, cfg).rule, "rwx.denied", JSON.stringify(bad));
  }
  const cfg = rwxCfg();
  Object.defineProperty(cfg, "askUnheld", { get() { throw new Error("boom"); } });
  assert.equal(rwxCheck({ type: "deploy" }, cfg).rule, "rwx.denied");
});

// ─── decision: tools branch and bash branch ─────────────────────────────────

test("askUnheld: tools branch asks for a listed unheld letter, with fields", () => {
  const d = rwxCheck({ type: "deploy" }, rwxCfg({ askUnheld: ["x"] }));
  assert.equal(d.outcome, "askHuman");
  assert.equal(d.rule, "rwx.ask");
  assert.equal(d.severity, "action");
  assert.equal(d.rwxLetters, "r--");
  assert.equal(d.rwxLetter, "x");
  assert.equal("rwxMarker" in d, false);
  assert.match(d.reason, /"deploy" is tagged "x" but agent "reader" only holds "r--"/);
  assert.match(d.reason, /rwx\.askUnheld/);
});

test("askUnheld: marker rides along on the tools-branch ask", () => {
  const d = rwxCheck({ type: "edit" }, rwxCfg({ askUnheld: ["w"] }));
  assert.equal(d.rule, "rwx.ask");
  assert.equal(d.rwxLetter, "w");
  assert.equal(d.rwxMarker, "tight");
});

test("askUnheld: bash branch asks for a listed unheld letter", () => {
  const d = rwxCheck({ type: "bash", cmd: "git commit" }, rwxCfg({ askUnheld: ["w"] }));
  assert.equal(d.outcome, "askHuman");
  assert.equal(d.rule, "rwx.ask");
  assert.equal(d.rwxLetters, "r--");
  assert.equal(d.rwxLetter, "w");
  assert.match(d.reason, /"git commit" is tagged "w" but agent "reader" only holds "r--"/);
});

test("askUnheld: a letter NOT in the list still denies rwx.denied", () => {
  const cfg = rwxCfg({ askUnheld: ["w"] });
  assert.equal(rwxCheck({ type: "deploy" }, cfg).rule, "rwx.denied");
  assert.equal(rwxCheck({ type: "bash", cmd: "git push" }, cfg).rule, "rwx.denied");
});

test("askUnheld: a held letter still allows (never asks)", () => {
  const cfg = rwxCfg({ askUnheld: ["r", "w", "x"] });
  assert.equal(rwxCheck({ type: "read" }, cfg).rule, "rwx.allow");
  assert.equal(rwxCheck({ type: "bash", cmd: "git status" }, cfg).rule, "rwx.allow");
});

test("askUnheld: askOn:\"loose\" is unchanged for held letters", () => {
  const cfg = rwxCfg({
    agent: "rw", agents: { rw: "rw-" },
    askOn: "loose", askUnheld: ["x"],
    tools: { edit: { letter: "w", marker: "loose" }, deploy: "x" },
  });
  const loose = rwxCheck({ type: "edit" }, cfg);
  assert.equal(loose.rule, "rwx.ask");
  assert.match(loose.reason, /askOn:"loose"/);
  assert.match(rwxCheck({ type: "deploy" }, cfg).reason, /askUnheld/);
});

// ─── unchanged denies, even with every letter listed ────────────────────────

test("askUnheld:[r,w,x] never softens unlisted / joined / invalidTool / invalid denies", () => {
  const all = ["r", "w", "x"];
  const cfg = rwxCfg({ askUnheld: all });
  assert.equal(rwxCheck({ type: "nope" }, cfg).rule, "rwx.unlisted");
  assert.equal(rwxCheck({ type: "bash", cmd: "rm -rf /tmp/zz" }, cfg).rule, "rwx.unlisted");
  assert.equal(rwxCheck({ type: "bash", cmd: "git push && git push" }, cfg).rule, "rwx.joined");
  assert.equal(rwxCheck({ type: "deploy", tool: 7 }, cfg).rule, "tools.invalidTool");
  assert.equal(rwxCheck({ type: "deploy" }, rwxCfg({ askUnheld: all, agent: "stranger" })).rule, "rwx.unlisted");
  assert.equal(
    rwxCheck({ type: "deploy" }, rwxCfg({ askUnheld: all, tools: { deploy: "q" } })).rule,
    "rwx.invalid",
  );
  assert.equal(
    rwxCheck({ type: "bash", cmd: "git push" }, rwxCfg({ askUnheld: all, bash: { "git push": "q" } })).rule,
    "rwx.invalid",
  );
  assert.equal(rwxCheck({ type: "bash", cmd: 5 }, cfg).rule, "rwx.invalid");
});

// ─── through the real gate.check + humanChannel ─────────────────────────────

test("askUnheld: human allow -> allow, human sees the event, audit has both lines", async () => {
  let event = null;
  const gate = gateFor({ askUnheld: ["w"] }, async (e) => { event = e; return { decision: "allow" }; });
  await gate.init();
  const d = await gate.check({ type: "write", path: X, args: {} });
  assert.equal(d.outcome, "allow");
  assert.equal(d.rule, "humanChannel.allow");
  assert.ok(event, "humanChannel must be called");
  assert.equal(event.rule, "rwx.ask");
  assert.equal(event.rwxLetters, "r--");
  assert.equal(event.rwxLetter, "w");
  assert.match(event.reason, /askUnheld/);

  const gateLines = (await gate.audit.readAll()).filter((l) => l.phase === "gate");
  assert.equal(gateLines.length, 2);
  assert.equal(gateLines[0].decision, "askHuman");
  assert.equal(gateLines[0].rule, "rwx.ask");
  assert.equal(gateLines[0].rwxLetters, "r--");
  assert.equal(gateLines[0].rwxLetter, "w");
  assert.equal(gateLines[1].decision, "allow");
  assert.equal(gateLines[1].rule, "humanChannel.allow");
});

test("askUnheld: human deny -> deny; bash branch; marker in audit", async () => {
  const gate = gateFor({ askUnheld: ["w", "x"] }, async () => ({ decision: "deny", reason: "no" }));
  await gate.init();
  const d1 = await gate.check({ type: "bash", cmd: "git push" });
  assert.equal(d1.outcome, "deny");
  const d2 = await gate.check({ type: "edit", path: X, args: {} });
  assert.equal(d2.outcome, "deny");
  const lines = (await gate.audit.readAll()).filter((l) => l.phase === "gate" && l.decision === "askHuman");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].rwxLetter, "x");
  assert.equal(lines[0].rwxMarker, undefined);
  assert.equal(lines[1].rwxLetter, "w");
  assert.equal(lines[1].rwxMarker, "tight");
});

test("askUnheld: an unlisted tool never reaches the humanChannel", async () => {
  let asked = false;
  const gate = gateFor({ askUnheld: ["r", "w", "x"] }, async () => { asked = true; return { decision: "allow" }; });
  await gate.init();
  const d = await gate.check({ type: "bash", cmd: "git push; git push" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.joined");
  assert.equal(asked, false);
});

test("askUnheld: default (no list) denies and never asks", async () => {
  let asked = false;
  const gate = gateFor({}, async () => { asked = true; return { decision: "allow" }; });
  await gate.init();
  const d = await gate.check({ type: "bash", cmd: "git push" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.denied");
  assert.equal(asked, false);
});

test("askUnheld: with no humanChannel the ask denies as any ask does today (rule rwx.ask)", async () => {
  const gate = gateFor({ askUnheld: ["x"] });
  await gate.init();
  const d = await gate.check({ type: "bash", cmd: "git push" });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.ask");
  assert.match(d.reason, /no humanChannel registered/);
});
