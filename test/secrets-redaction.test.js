import test from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/index.js";

test("env-var match → tagged with env var name, not leaked", () => {
  process.env.TEST_SECRET = "sk-thisIsASecretValueThatShouldNotLeak123456789";
  try {
    const action = {
      type: "fetch",
      headers: { authz: `Bearer ${process.env.TEST_SECRET}` },
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
