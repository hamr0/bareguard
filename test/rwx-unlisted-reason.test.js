// rwx.unlisted deny reasons are worded to name the config file AND the
// operator as the one who must edit it (commit 967c9d7). This is
// load-bearing: the rwx constitution is USER-authored and the agent only
// writes the body — a reason that reads like "add it as r, w or x" invites
// the agent to go edit the map itself, eroding that boundary. Assert on the
// substrings ("bareguard.rwx.json", "operator"), not the whole sentence —
// a full match would break on any harmless rewording.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

import { REAL_SLASH_TMP } from "./_helpers.js";
const RWX = {
  agents: { researcher: "r--" },
  tools: { read: "r" },
  bash: { ls: "r" },
};

function gateFor(agent, overrides = {}) {
  return new Gate({
    audit: { path: null },
    // Broad fs scope so a "read"-typed action's fs step (which runs BEFORE
    // the rwx step) passes through on a real path, letting these tests
    // exercise rwx.unlisted reason wording, not fs scoping.
    fs: { readScope: [REAL_SLASH_TMP] },
    rwx: { agent, ...RWX, ...overrides },
    humanChannel: async () => ({ decision: "deny" }),
  });
}

test("rwx.unlisted (agent): reason names bareguard.rwx.json and operator", async () => {
  const gate = gateFor("nobody");
  await gate.init();
  const d = await gate.check({ type: "read", path: REAL_SLASH_TMP + "/x", args: {} });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.unlisted");
  assert.match(d.reason, /bareguard\.rwx\.json/);
  assert.match(d.reason, /operator/);
});

test("rwx.unlisted (bash): reason names bareguard.rwx.json and operator", async () => {
  const gate = gateFor("researcher");
  await gate.init();
  const d = await gate.check({ type: "bash", args: { command: "totally_unknown_cmd" } });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.unlisted");
  assert.match(d.reason, /bareguard\.rwx\.json/);
  assert.match(d.reason, /operator/);
});

test("rwx.unlisted (tool): reason names bareguard.rwx.json and operator", async () => {
  const gate = gateFor("researcher");
  await gate.init();
  const d = await gate.check({ type: "totally_unknown_tool", args: {} });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.unlisted");
  assert.match(d.reason, /bareguard\.rwx\.json/);
  assert.match(d.reason, /operator/);
});
