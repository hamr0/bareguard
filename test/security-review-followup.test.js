// Regression tests for the issues a /code-review pass found in the v0.4.4 /
// v0.4.5 security changes (shipped as v0.4.6):
//   F1 — fs `within()` mishandled a deny/scope entry written with a trailing
//        slash: fail-open on deny (dir node itself), fail-closed on scope.
//   F2 — redact() with a non-global pattern only masked the first match,
//        leaking later secrets on the same line.
//   minors — net: IPv4-compatible IPv6 (::a.b.c.d) and site-local fec0::/10.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate, redact } from "../src/index.js";
import { makeTmpDir, cleanup, uniquePaths } from "./_helpers.js";

async function gateWith(t, cfg) {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const { auditPath } = uniquePaths(dir);
  const gate = new Gate({ audit: { path: auditPath }, ...cfg });
  await gate.init();
  return gate;
}

// ---------------------------------------------------------------------------
// F1 — trailing slash in a deny / scope entry
// ---------------------------------------------------------------------------

test("fs.deny — a trailing-slash entry still denies the directory node itself", async (t) => {
  const gate = await gateWith(t, { fs: { deny: ["/etc/secret/"] } });

  // the directory node itself (the fail-open case) must be denied
  assert.equal((await gate.check({ type: "read", path: "/etc/secret" })).outcome, "deny");
  // children too
  assert.equal((await gate.check({ type: "read", path: "/etc/secret/key" })).outcome, "deny");
  // and a prefix sibling must NOT be denied
  assert.equal((await gate.check({ type: "read", path: "/etc/secret-public/x" })).outcome, "allow");
});

test("fs.writeScope — a trailing-slash entry still allows the scope root itself", async (t) => {
  const gate = await gateWith(t, { fs: { writeScope: ["/app/data/"] } });

  // writing the scope root itself (the fail-closed regression) must be allowed
  assert.equal((await gate.check({ type: "write", path: "/app/data", content: "x" })).outcome, "allow");
  assert.equal((await gate.check({ type: "write", path: "/app/data/f", content: "x" })).outcome, "allow");
  // escapes still denied
  assert.equal((await gate.check({ type: "write", path: "/app/data/../etc/x", content: "x" })).outcome, "deny");
});

test("fs.deny — root entry denies every absolute path", async (t) => {
  const gate = await gateWith(t, { fs: { deny: ["/"] } });
  assert.equal((await gate.check({ type: "read", path: "/anything/at/all" })).outcome, "deny");
});

// ---------------------------------------------------------------------------
// F2 — redaction masks every occurrence, even for a non-global pattern
// ---------------------------------------------------------------------------

test("redact — a non-global pattern still masks ALL matches on a line", async () => {
  const out = redact(
    { type: "bash", cmd: "use sk-aaaa1111 then sk-bbbb2222 then sk-cccc3333" },
    { patterns: [/sk-[a-z0-9]+/] }, // intentionally NOT global
  );
  for (const tok of ["sk-aaaa1111", "sk-bbbb2222", "sk-cccc3333"]) {
    assert.ok(!out.cmd.includes(tok), `${tok} must be redacted`);
  }
});

test("audit auto-redaction masks every secret on a line (non-global pattern)", async (t) => {
  const gate = new Gate({
    audit:   { path: null },
    secrets: { patterns: [/sk-[a-z0-9]+/] }, // non-global
    content: { denyPatterns: [], askPatterns: [] },
  });
  await gate.init();
  await gate.check({ type: "fetch", url: "http://x", body: "sk-first0001 and sk-second02" });
  const line = JSON.stringify(gate.audit.entries.find(e => e.phase === "gate"));
  assert.ok(!line.includes("sk-first0001"), "first secret redacted");
  assert.ok(!line.includes("sk-second02"), "second secret redacted");
});

// ---------------------------------------------------------------------------
// net minors — IPv4-compatible IPv6 and site-local
// ---------------------------------------------------------------------------

test("net.denyPrivateIps — IPv4-compatible IPv6 and site-local are blocked", async (t) => {
  const gate = await gateWith(t, { net: { denyPrivateIps: true } });

  for (const url of [
    "http://[::127.0.0.1]/",   // IPv4-compatible loopback (deprecated)
    "http://[fec0::1]/",       // site-local (deprecated)
  ]) {
    const d = await gate.check({ type: "fetch", url });
    assert.equal(d.outcome, "deny", `${url} must be denied`);
    assert.equal(d.rule, "net.denyPrivateIps");
  }

  // public addresses must still pass (no false-positive from the new arms)
  assert.equal((await gate.check({ type: "fetch", url: "http://[2606:4700::1]/" })).outcome, "allow");
  assert.equal((await gate.check({ type: "fetch", url: "http://8.8.8.8/" })).outcome, "allow");
});
