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
