// Regression tests for the fs path-traversal and net SSRF bypasses found in
// the v0.4.3 security audit. Each test asserts a previously-bypassing action
// is now denied, with paired "legit still allowed" cases to guard against
// over-blocking. Driven through the public Gate API.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

async function gateWith(t, cfg) {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const gate = new Gate({ audit: { path: auditPath }, ...cfg });
  await gate.init();
  return gate;
}

// ---------------------------------------------------------------------------
// fs: lexical traversal must not escape deny entries or scope roots.
// ---------------------------------------------------------------------------

test("fs.deny — `.` and `..` segments cannot bypass a deny entry", async (t) => {
  const gate = await gateWith(t, { fs: { deny: ["/etc/secrets"] } });

  for (const path of [
    "/etc/./secrets/key",
    "/etc/secrets/../secrets/key",
    "/var/../etc/secrets/key",
    "/etc/secrets",
    "/etc/secrets/sub/key",
  ]) {
    const d = await gate.check({ type: "read", path });
    assert.equal(d.outcome, "deny", `${path} must be denied`);
    assert.equal(d.rule, "fs.deny");
  }

  // legit: a sibling that merely shares a prefix is NOT under the deny entry
  const ok = await gate.check({ type: "read", path: "/etc/secrets-public/readme" });
  assert.equal(ok.outcome, "allow", "/etc/secrets-public must not match deny /etc/secrets");
});

test("fs.readScope — traversal and prefix-boundary cannot escape the scope", async (t) => {
  const gate = await gateWith(t, { fs: { readScope: ["/app/data"] } });

  // traversal out of scope
  const esc = await gate.check({ type: "read", path: "/app/data/../../etc/passwd" });
  assert.equal(esc.outcome, "deny", "traversal out of readScope must be denied");
  assert.equal(esc.rule, "fs.readScope");

  // prefix-boundary: /app/data-secrets is NOT inside /app/data
  const sib = await gate.check({ type: "read", path: "/app/data-secrets/creds" });
  assert.equal(sib.outcome, "deny", "/app/data-secrets must not satisfy readScope /app/data");
  assert.equal(sib.rule, "fs.readScope");

  // legit reads inside scope still pass, including a normalized no-op `.`
  assert.equal((await gate.check({ type: "read", path: "/app/data/file.txt" })).outcome, "allow");
  assert.equal((await gate.check({ type: "read", path: "/app/data/./sub/file.txt" })).outcome, "allow");
  assert.equal((await gate.check({ type: "read", path: "/app/data" })).outcome, "allow");
});

test("fs.writeScope — traversal and prefix-boundary cannot escape the scope", async (t) => {
  const gate = await gateWith(t, { fs: { writeScope: ["/app/uploads"] } });

  const esc = await gate.check({ type: "write", path: "/app/uploads/../../etc/cron.d/job", content: "x" });
  assert.equal(esc.outcome, "deny", "traversal out of writeScope must be denied");
  assert.equal(esc.rule, "fs.writeScope");

  const sib = await gate.check({ type: "write", path: "/app/uploads-evil/payload", content: "x" });
  assert.equal(sib.outcome, "deny", "/app/uploads-evil must not satisfy writeScope /app/uploads");

  // edit shares writeScope semantics
  const editEsc = await gate.check({ type: "edit", path: "/app/uploads/../secret", content: "x" });
  assert.equal(editEsc.outcome, "deny", "edit traversal must be denied too");

  assert.equal((await gate.check({ type: "write", path: "/app/uploads/ok.bin", content: "x" })).outcome, "allow");
});

// ---------------------------------------------------------------------------
// net: denyPrivateIps must cover IPv6, IPv4-mapped, link-local, and 0.0.0.0.
// ---------------------------------------------------------------------------

test("net.denyPrivateIps — IPv6 loopback/ULA/link-local are blocked (not dead code)", async (t) => {
  const gate = await gateWith(t, { net: { denyPrivateIps: true } });

  for (const url of [
    "http://[::1]/",                 // loopback
    "http://[0:0:0:0:0:0:0:1]/",     // expanded loopback
    "http://[::]/",                  // unspecified
    "http://[fd00::1]/",             // unique-local
    "http://[fe80::1]/",             // link-local
    "http://[::ffff:127.0.0.1]/",    // IPv4-mapped loopback
  ]) {
    const d = await gate.check({ type: "fetch", url });
    assert.equal(d.outcome, "deny", `${url} must be denied`);
    assert.equal(d.rule, "net.denyPrivateIps");
  }

  // legit public IPv6 must still pass
  assert.equal((await gate.check({ type: "fetch", url: "http://[2606:4700::1]/" })).outcome, "allow");
});

test("net.denyPrivateIps — IPv4 link-local (cloud metadata) and 0.0.0.0 are blocked", async (t) => {
  const gate = await gateWith(t, { net: { denyPrivateIps: true } });

  for (const url of [
    "http://169.254.169.254/",  // AWS/GCP/Azure instance metadata
    "http://169.254.0.1/",
    "http://0.0.0.0/",
  ]) {
    const d = await gate.check({ type: "fetch", url });
    assert.equal(d.outcome, "deny", `${url} must be denied`);
    assert.equal(d.rule, "net.denyPrivateIps");
  }

  // legit public IPv4 still passes
  assert.equal((await gate.check({ type: "fetch", url: "http://8.8.8.8/" })).outcome, "allow");
  assert.equal((await gate.check({ type: "fetch", url: "http://example.com/" })).outcome, "allow");
});

// ---------------------------------------------------------------------------
// tools.allowlist: an EMPTY allowlist must fail CLOSED. Before this fix `[]`
// was folded into "not configured", so step 5 was skipped and the action fell
// through to default allow — the tightest possible scope produced the loosest
// possible outcome, silently. Every sibling scope primitive (net.allowDomains,
// fs.readScope/writeScope, bash.allow) already denies on `[]`; tools was the
// sole outlier.
// ---------------------------------------------------------------------------

test("tools.allowlist — an empty allowlist denies every action (fails closed)", async (t) => {
  const gate = await gateWith(t, { tools: { allowlist: [] } });

  for (const action of [
    { type: "wireMoney", amount: 999999 },
    { type: "search", query: "anything" },
    { type: "read", path: "/tmp/x" },
  ]) {
    const d = await gate.check(action);
    assert.equal(d.outcome, "deny", `${action.type} must be denied by an empty allowlist`);
    assert.equal(d.rule, "tools.allowlist.exclusive");
  }
});

test("tools.allowlist — an ABSENT allowlist still means 'no opinion' (default allow)", async (t) => {
  const gate = await gateWith(t, { tools: { denylist: ["wireMoney"] } });

  // no allowlist key: scope is unconfigured, so unrelated types pass
  assert.equal((await gate.check({ type: "search", query: "x" })).outcome, "allow");
  // ...and the denylist still bites
  assert.equal((await gate.check({ type: "wireMoney", amount: 1 })).rule, "tools.denylist");
});

test("tools.allowlist — a bundle whose intersection is empty cannot widen the floor", async (t) => {
  const FLOOR_TOOLS = ["search", "read", "fetch", "bookFlight", "wireMoney"];
  // cookbook resolver shape: bundle names that miss the floor entirely (typos)
  const allowlist = ["reed", "serch"].filter((x) => FLOOR_TOOLS.includes(x));
  assert.deepEqual(allowlist, [], "precondition: the intersection is empty");

  const gate = await gateWith(t, { tools: { allowlist } });
  const d = await gate.check({ type: "wireMoney", amount: 999999 });
  assert.equal(d.outcome, "deny", "narrowest possible bundle must not allow-all");
  assert.equal(d.rule, "tools.allowlist.exclusive");
});
