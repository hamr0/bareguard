import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/index.js";

test("env-var match → tagged with env var name, not leaked", () => {
  process.env.TEST_SECRET = "sk-thisIsASecretValueThatShouldNotLeak123456789";
  try {
    // NB: the env value is held under a non-Bearer key so the default-on
    // `Bearer …` value-pattern (BG-1) doesn't preempt the env-var tag here —
    // that interaction is covered by the dedicated default-on tests below.
    const action = {
      type: "fetch",
      headers: { x_authz: process.env.TEST_SECRET },
    };
    const clean = redact(action, { envVars: ["TEST_SECRET"] });
    const s = JSON.stringify(clean);
    assert.ok(!s.includes(process.env.TEST_SECRET), "secret must not appear in serialized form");
    assert.match(s, /\[REDACTED:TEST_SECRET\]/);
  } finally {
    delete process.env.TEST_SECRET;
  }
});

test("pattern match → tagged with short prefix only", () => {
  const action = { type: "bash", cmd: "use sk-abcdefghijklmnopqrstuvwx0123456789ABCD secret here" };
  const clean = redact(action, { patterns: [/sk-[A-Za-z0-9]{20,}/] });
  const s = JSON.stringify(clean);
  assert.ok(!s.includes("sk-abcdefghijklmnopqrstuvwx0123456789ABCD"));
  assert.match(s, /\[REDACTED:pattern=sk-/);
});

test("short env vars (< 8 chars) are NOT redacted (likely not secrets)", () => {
  process.env.TEST_PORT = "5432";
  try {
    const action = { type: "fetch", url: "http://x:5432/q" };
    const clean = redact(action, { envVars: ["TEST_PORT"] });
    assert.equal(JSON.stringify(clean), JSON.stringify(action), "short values should not be redacted");
  } finally {
    delete process.env.TEST_PORT;
  }
});

test("no match → action returned unchanged (referentially)", () => {
  const action = { type: "bash", cmd: "git status" };
  const clean = redact(action, { envVars: ["NONEXISTENT"] });
  assert.equal(clean, action, "no redaction → same object reference");
});

// ── BG-1: key-aware, default-on redaction (F16, defense-in-depth) ──────────

test("BG-1 default-on: apiKey value is blanked with NO secrets config", () => {
  const action = { type: "llm", apiKey: "sk-ant-realkey0123456789abcdef" };
  const clean = redact(action); // no cfg at all
  const s = JSON.stringify(clean);
  assert.ok(!s.includes("sk-ant-realkey0123456789abcdef"), "raw key must not appear");
  assert.equal(clean.apiKey, "[REDACTED:key=apiKey]");
  assert.equal(clean.type, "llm", "non-secret fields are preserved");
});

test("BG-1 default-on: nested _ctx.provider.apiKey (the F16 leak shape) is blanked", () => {
  const action = {
    type: "write",
    _ctx: { userId: "u1", provider: { name: "anthropic", apiKey: "sk-ant-deeplynested0123456789" } },
  };
  const clean = redact(action);
  const s = JSON.stringify(clean);
  assert.ok(!s.includes("sk-ant-deeplynested0123456789"), "nested key must not appear");
  assert.equal(clean._ctx.provider.apiKey, "[REDACTED:key=apiKey]");
  assert.equal(clean._ctx.userId, "u1");
});

test("BG-1 default-on: key match is case-insensitive (Authorization, api_key)", () => {
  const clean = redact({ Authorization: "Bearer abc.def.ghi", api_key: "kkkk1111kkkk2222" });
  assert.equal(clean.Authorization, "[REDACTED:key=Authorization]");
  assert.equal(clean.api_key, "[REDACTED:key=api_key]");
});

test("BG-1 default-on: `Bearer …` value pattern fires with no config", () => {
  const clean = redact({ type: "fetch", h: "Bearer sk-xyz9876543210abcdef" });
  const s = JSON.stringify(clean);
  assert.ok(!s.includes("sk-xyz9876543210abcdef"));
  assert.match(s, /\[REDACTED:pattern=Bear/);
});

test("BG-1 default-on: bare `sk-…` value pattern fires with no config", () => {
  const clean = redact({ cmd: "export KEY=sk-ant-bareleak0123456789abc" });
  assert.ok(!JSON.stringify(clean).includes("sk-ant-bareleak0123456789abc"));
});

test("BG-1 narrow default EXCLUDES *_token / *_secret globs (no page_token FP)", () => {
  const action = { type: "api", page_token: "next_page_abc123", csrf_token: "csrf_xyz789" };
  const clean = redact(action);
  assert.equal(clean, action, "benign *_token fields must pass untouched (same ref)");
});

test("BG-1 caller-configurable: operator may extend with the broad globs", () => {
  const action = { type: "api", page_token: "next_page_abc123" };
  const clean = redact(action, { keys: ["*_token"] });
  assert.equal(clean.page_token, "[REDACTED:key=page_token]");
});

test("BG-1 opt-out: redactKeys:false disables the default-on backstop", () => {
  const action = { type: "llm", apiKey: "sk-ant-optedout0123456789abc" };
  const clean = redact(action, { redactKeys: false });
  assert.equal(clean, action, "explicit opt-out → no redaction, same ref");
});

test("BG-1 opt-out still honors explicitly-configured keys", () => {
  const action = { type: "llm", apiKey: "kept", session_secret: "drop-me-please-1234" };
  const clean = redact(action, { redactKeys: false, keys: ["session_secret"] });
  assert.equal(clean.apiKey, "kept", "default key off");
  assert.equal(clean.session_secret, "[REDACTED:key=session_secret]", "explicit key on");
});
