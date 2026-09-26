// net gates on URL PRESENCE (action.url / action.args.url), not on
// action.type === "fetch" (fixed in 0.18.0). Under rwx, web calls may be
// typed "fetch.get"/"fetch.post" (PRD §23.13 #3), "<vendor>.<operationId>"
// (§23.12), or a runtime spec-less "<host>.<METHOD> <path>" key (§23.21,
// added via gate.add()) — all of those carry a url but not type "fetch",
// and 0.17.0 skipped net entirely for them. Repro is the orchestrator's own:
// net {allowDomains:["example.com"], denyPrivateIps:true}, rwx tools
// {fetch:"r","fetch.get":"r","api.evil.com.GET /x":"r"}, agent "r--".

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { netCheck } from "../src/primitives/net.js";

const METADATA_URL = "http://169.254.169.254/latest/meta-data";
const NON_ALLOWLISTED_URL = "https://evil.example.org/x";

function gateFor(overrides = {}) {
  return new Gate({
    audit: { path: null },
    net: { allowDomains: ["example.com"], denyPrivateIps: true },
    rwx: {
      agent: "researcher",
      agents: { researcher: "r--" },
      tools: {
        fetch: "r",
        "fetch.get": "r",
        "fetch.post": "r",
        "api.evil.com.GET /x": "r",
        "custom.noUrl": "r",
      },
    },
    humanChannel: async () => ({ decision: "deny" }),
    ...overrides,
  });
}

// ─── the three repro types, metadata URL ──────────────────────────────────

test("net: type 'fetch' with metadata url still denies (baseline, unchanged)", async () => {
  const gate = gateFor();
  await gate.init();
  const dec = await gate.check({ type: "fetch", url: METADATA_URL });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "net.denyPrivateIps");
});

test("net: type 'fetch.get' with metadata url now denies (was: allow, 0.17.0 bug)", async () => {
  const gate = gateFor();
  await gate.init();
  const dec = await gate.check({ type: "fetch.get", url: METADATA_URL });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "net.denyPrivateIps");
});

test("net: spec-less '<host>.<METHOD> <path>' type with metadata url now denies (was: allow, 0.17.0 bug)", async () => {
  const gate = gateFor();
  await gate.init();
  const dec = await gate.check({ type: "api.evil.com.GET /x", url: METADATA_URL });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "net.denyPrivateIps");
});

// ─── same three types, non-allowlisted (but non-private) host ────────────

test("net: type 'fetch' with non-allowlisted host denies", async () => {
  const gate = gateFor();
  await gate.init();
  const dec = await gate.check({ type: "fetch", url: NON_ALLOWLISTED_URL });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "net.allowDomains");
});

test("net: type 'fetch.post' with non-allowlisted host denies (was: allow, 0.17.0 bug)", async () => {
  const gate = gateFor();
  await gate.init();
  const dec = await gate.check({ type: "fetch.post", url: NON_ALLOWLISTED_URL });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "net.allowDomains");
});

test("net: spec-less type with non-allowlisted host denies (was: allow, 0.17.0 bug)", async () => {
  const gate = gateFor();
  await gate.init();
  const dec = await gate.check({ type: "api.evil.com.GET /x", url: NON_ALLOWLISTED_URL });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "net.allowDomains");
});

// ─── nested args.url shape, non-"fetch" type ──────────────────────────────

test("net: nested action.args.url on a non-'fetch' type still gates", async () => {
  const gate = gateFor();
  await gate.init();
  const dec = await gate.check({ type: "fetch.get", args: { url: METADATA_URL } });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "net.denyPrivateIps");
});

// ─── allowlisted host is let through for the previously-skipped types ─────

test("net: allowlisted host allowed through for 'fetch.get'", async () => {
  const gate = gateFor();
  await gate.init();
  const dec = await gate.check({ type: "fetch.get", url: "https://api.example.com/v1" });
  assert.equal(dec.outcome, "allow");
});

test("net: allowlisted host allowed through for a spec-less key", async () => {
  const gate = gateFor({
    rwx: {
      agent: "researcher",
      agents: { researcher: "r--" },
      tools: { "example.com.GET /x": "r" },
    },
  });
  await gate.init();
  const dec = await gate.check({ type: "example.com.GET /x", url: "https://example.com/x" });
  assert.equal(dec.outcome, "allow");
});

// ─── custom tool with no url at all is unaffected ─────────────────────────

test("net: custom tool with no url anywhere is a no-op (falls through to rwx allow)", async () => {
  const gate = gateFor();
  await gate.init();
  const dec = await gate.check({ type: "custom.noUrl" });
  assert.equal(dec.outcome, "allow");
});

test("netCheck: no url anywhere returns null directly", () => {
  assert.equal(netCheck({ type: "custom.noUrl" }, { allowDomains: ["example.com"] }), null);
  assert.equal(netCheck({ type: "fetch" }, { allowDomains: ["example.com"] }), null);
});

// ─── non-string url on a non-"fetch" type denies ──────────────────────────

test("net: non-string url on a non-'fetch' type denies net.invalidUrl", async () => {
  const gate = gateFor();
  await gate.init();
  const dec = await gate.check({ type: "fetch.get", url: { not: "a string" } });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "net.invalidUrl");
});

test("netCheck: non-string args.url on a non-'fetch' type denies net.invalidUrl", () => {
  const dec = netCheck({ type: "some.custom.TYPE", args: { url: 12345 } }, {});
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.rule, "net.invalidUrl");
});

// ─── net deny fires before rwx would have allowed (ordering) ─────────────

test("net deny happens before rwx allow for a previously-skipped type", async () => {
  // rwx tools grants "fetch.get":"r" to researcher ("r--") — rwx alone would
  // allow this. net must still win because it runs at step 3, before rwx's
  // step 5.
  const gate = gateFor();
  await gate.init();
  const dec = await gate.check({ type: "fetch.get", url: METADATA_URL });
  assert.equal(dec.outcome, "deny");
  assert.equal(dec.severity, "action");
  assert.notEqual(dec.rule, "rwx.unlisted");
});

