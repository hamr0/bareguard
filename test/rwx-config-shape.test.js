// rwx construct-time validation + mutual exclusivity (PRD §23.2/§23.3/§23.8),
// plus the runtime `<key>.invalid` fail-closed family (config held by
// reference, mutable post-construction — same TOCTOU class every other
// primitive in this codebase already guards against).

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { rwxCheck, assertRwxConfig } from "../src/primitives/rwx.js";

const VALID_RWX = {
  agent: "fixer",
  agents: { researcher: "r--", fixer: "rw-", deployer: "rwx" },
  tools: { read: "r", write: "w", deploy: "x" },
  bash: { ls: "r", "git commit": "w", "git push": "x" },
};

// ─── mutual exclusivity (§23.2) ───────────────────────────────────────────────

test("rwx: rwx + tools.allowlist together throws at construct time", () => {
  assert.throws(
    () => new Gate({ rwx: VALID_RWX, tools: { allowlist: ["bash"] } }),
    /mutually exclusive.*tools\.allowlist/s,
  );
});

test("rwx: rwx + bash.allow together throws at construct time", () => {
  assert.throws(
    () => new Gate({ rwx: VALID_RWX, bash: { allow: ["git"] } }),
    /mutually exclusive.*bash\.allow/s,
  );
});

test("rwx: rwx + bash.denyPatterns together throws at construct time", () => {
  assert.throws(
    () => new Gate({ rwx: VALID_RWX, bash: { denyPatterns: [/sudo/] } }),
    /mutually exclusive.*bash\.denyPatterns/s,
  );
});

test("rwx: rwx + bash.classify:true throws at construct time (§23.8 — classify is allowlist-mode only)", () => {
  assert.throws(
    () => new Gate({ rwx: VALID_RWX, bash: { classify: true } }),
    /bash\.classify.*rwx/s,
  );
});

test("rwx: rwx + bash.classify:false does NOT throw (only true is a conflict)", () => {
  assert.doesNotThrow(() => new Gate({ rwx: VALID_RWX, bash: { classify: false } }));
});

test("rwx: rwx alone (no allowlist-mode keys) constructs cleanly", () => {
  assert.doesNotThrow(() => new Gate({ rwx: VALID_RWX }));
});

test("rwx: with no rwx config at all, tools.allowlist/bash.allow/bash.classify still construct exactly as before", () => {
  assert.doesNotThrow(() => new Gate({
    tools: { allowlist: ["bash"] },
    bash: { allow: ["git"], classify: true },
  }));
});

// ─── construct-time shape validation ─────────────────────────────────────────

test("rwx: a non-plain-object rwx section throws", () => {
  for (const bad of ["oops", 42, ["a"], new Map()]) {
    assert.throws(() => new Gate({ rwx: bad }), /rwx must be a plain object/);
  }
});

test("rwx: a non-plain-object tools/bash/agents map throws", () => {
  assert.throws(() => new Gate({ rwx: { ...VALID_RWX, tools: "oops" } }), /rwx\.tools must be a plain object/);
  assert.throws(() => new Gate({ rwx: { ...VALID_RWX, bash: ["a"] } }), /rwx\.bash must be a plain object/);
  assert.throws(() => new Gate({ rwx: { ...VALID_RWX, agents: 42 } }), /rwx\.agents must be a plain object/);
});

test("rwx: an invalid tools/bash letter value throws (must be exactly r, w, or x, or a { letter, marker? } object)", () => {
  for (const bad of ["rw", "R", "", "rwx", null, 1, ["r"]]) {
    assert.throws(
      () => new Gate({ rwx: { ...VALID_RWX, tools: { deploy: bad } } }),
      /rwx\.tools\.deploy must be "r"\/"w"\/"x" or \{ letter:/,
      `tools letter ${JSON.stringify(bad)} should throw`,
    );
    assert.throws(
      () => new Gate({ rwx: { ...VALID_RWX, bash: { ls: bad } } }),
      /rwx\.bash\.ls must be "r"\/"w"\/"x" or \{ letter:/,
      `bash letter ${JSON.stringify(bad)} should throw`,
    );
  }
});

test("rwx: an invalid agents letters value throws (must be a 3-char [r-][w-][x-] string)", () => {
  for (const bad of ["rw", "rwxx", "RWX", "abc", "", null, 1]) {
    assert.throws(
      () => new Gate({ rwx: { ...VALID_RWX, agents: { fixer: bad } } }),
      /rwx\.agents\.fixer must be a 3-char letters string/,
      `agents letters ${JSON.stringify(bad)} should throw`,
    );
  }
});

test("rwx: every legal 3-char letters combination constructs", () => {
  const combos = ["rwx", "r--", "-w-", "--x", "rw-", "r-x", "-wx", "---"];
  for (const letters of combos) {
    assert.doesNotThrow(() => new Gate({ rwx: { ...VALID_RWX, agents: { a: letters } } }), letters);
  }
});

test("rwx: an invalid rwx.letters override throws", () => {
  assert.throws(() => new Gate({ rwx: { ...VALID_RWX, letters: "bogus" } }), /rwx\.letters must be a 3-char letters string/);
});

test("rwx: a non-string rwx.agent throws", () => {
  assert.throws(() => new Gate({ rwx: { ...VALID_RWX, agent: 42 } }), /rwx\.agent must be a string/);
});

test("rwx: assertRwxConfig is a no-op for undefined/null rwx", () => {
  assert.doesNotThrow(() => assertRwxConfig({}));
  assert.doesNotThrow(() => assertRwxConfig({ rwx: null }));
});

// ─── runtime `<key>.invalid` fail-closed backstop (cfg held by reference) ────

test("rwx: mutating rwx to a non-object post-construction fails CLOSED at runtime (rwx.invalid), not a thrown TypeError", async () => {
  // `Gate` holds `this.cfg = config` BY REFERENCE (verified elsewhere in this
  // suite), so mutating the SAME config object the gate was constructed with
  // is the real TOCTOU: `cfg.rwx = ...` on a copy would not reach it.
  const cfg = { audit: { path: null }, rwx: { ...VALID_RWX }, humanChannel: async () => ({ decision: "deny" }) };
  const gate = new Gate(cfg);
  await gate.init();
  cfg.rwx = "oops"; // swap the value out after construction validated it
  const d = await gate.check({ type: "read", args: {} });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.invalid");
});

test("rwx: mutating rwx.tools to a non-object post-construction fails CLOSED at runtime", async () => {
  const cfg = { audit: { path: null }, rwx: { ...VALID_RWX, tools: { ...VALID_RWX.tools } }, humanChannel: async () => ({ decision: "deny" }) };
  const gate = new Gate(cfg);
  await gate.init();
  cfg.rwx.tools = "oops";
  const d = await gate.check({ type: "read", args: {} });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.invalid");
});

test("rwx: a tools-map value corrupted to a bad letter post-construction denies rwx.invalid at that lookup", () => {
  const cfg = { ...VALID_RWX, tools: { ...VALID_RWX.tools } };
  cfg.tools.deploy = "rw"; // was valid "x" at construction; corrupted after
  const d = rwxCheck({ type: "deploy" }, cfg);
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.invalid");
});

test("rwx: an agents-map value corrupted to a bad letters string post-construction denies rwx.invalid", () => {
  const cfg = { ...VALID_RWX, agents: { ...VALID_RWX.agents } };
  cfg.agents.fixer = "xyz"; // was valid "rw-" at construction; corrupted after
  const d = rwxCheck({ type: "read" }, cfg);
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.invalid");
});

// ─── legal shapes still construct — the check must not over-reject ──────────

test("rwx: legal shapes construct without throwing", () => {
  const legal = [
    { rwx: { agent: "x", agents: {}, tools: {}, bash: {} } },
    { rwx: { agent: "x" } }, // agents/tools/bash all absent (unlisted agent → "---")
    { rwx: { letters: "rw-" } }, // spawned-child style, no agent/agents at all
    { rwx: VALID_RWX },
  ];
  for (const cfg of legal) {
    assert.doesNotThrow(() => new Gate(cfg), JSON.stringify(cfg));
  }
});
