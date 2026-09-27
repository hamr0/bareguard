import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Regression for: a humanChannel that never resolves, raced against
// humanChannelTimeoutMs, used to hang the process forever. The timeout
// timer was unref'd, so once there was no other pending event-loop work
// (no other timer/socket/etc keeping Node alive), Node exited early with
// "unsettled top-level await" (exit 13) instead of ever firing the timer
// and letting check() resolve to the timeout deny.
//
// This can only be observed from a real child process: an in-process
// node:test run keeps the event loop alive for other reasons regardless
// of whether this timer is unref'd.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
// On Windows, a bare absolute path (e.g. "d:\\...") is not a valid ESM
// specifier — the child process's import needs a real file:// URL.
const gateModuleUrl = pathToFileURL(path.join(repoRoot, "src/index.js")).href;

function runScript(script) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, ["--input-type=module"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - start });
    });
    child.stdin.end(script);
  });
}

test("humanChannelTimeoutMs fires and exits cleanly when humanChannel never resolves", async () => {
  const script = `
    import { Gate } from ${JSON.stringify(gateModuleUrl)};
    const gate = new Gate({
      audit: { path: null },
      humanChannelTimeoutMs: 20,
      humanChannel: async () => new Promise(() => {}),
    });
    await gate.init();
    const dec = await gate.check({ type: "fetch", url: "https://api/delete-acct" });
    console.log(JSON.stringify({ outcome: dec.outcome, severity: dec.severity, rule: dec.rule }));
  `;
  const { code, stdout, stderr, elapsedMs } = await runScript(script);
  assert.equal(code, 0, `expected clean exit, got code=${code} stderr=${stderr}`);
  assert.ok(elapsedMs < 5000, `expected to resolve promptly, took ${elapsedMs}ms`);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.outcome, "deny");
  assert.equal(parsed.severity, "halt");
  assert.equal(parsed.rule, "content.askPatterns");
});

test("a settled humanChannel does not keep the process alive until humanChannelTimeoutMs", async () => {
  const script = `
    import { Gate } from ${JSON.stringify(gateModuleUrl)};
    const gate = new Gate({
      audit: { path: null },
      humanChannelTimeoutMs: 30000,
      humanChannel: async () => ({ decision: "allow", reason: "fast" }),
    });
    await gate.init();
    const dec = await gate.check({ type: "fetch", url: "https://api/delete-acct" });
    console.log(JSON.stringify({ outcome: dec.outcome }));
  `;
  const { code, stdout, stderr, elapsedMs } = await runScript(script);
  assert.equal(code, 0, `expected clean exit, got code=${code} stderr=${stderr}`);
  assert.ok(elapsedMs < 5000, `expected prompt exit well under the 30s timeout, took ${elapsedMs}ms`);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.outcome, "allow");
});
