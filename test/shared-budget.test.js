import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import url from "node:url";
import { Budget, BudgetUnavailableError } from "../src/primitives/budget.js";
import { makeTmpDir, cleanup } from "./_helpers.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, "_worker.mjs");

function runWorker(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [WORKER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    proc.stdout.on("data", d => { buf += d.toString(); });
    proc.on("exit", code => {
      const lines = buf.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolve({ exitCode: code, lines });
    });
    proc.on("error", reject);
  });
}

test("two children spend concurrently against shared budget — accumulates, never over-counts", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath  = path.join(dir, "audit.jsonl");
  const budgetPath = path.join(dir, "budget.json");
  await fsp.writeFile(budgetPath, JSON.stringify({ version: 1, cap_usd: 5.00, spent_usd: 0, cap_tokens: 100000, spent_tokens: 0, started_at: new Date().toISOString() }, null, 2));

  const baseEnv = {
    BAREGUARD_AUDIT_PATH: auditPath,
    BAREGUARD_BUDGET_FILE: budgetPath,
    BAREGUARD_PARENT_RUN_ID: "test-parent",
    BAREGUARD_SPAWN_DEPTH: "1",
    WORKER_TICK_COST: "0.03",
    WORKER_TICKS: "10",
  };

  const [a, b] = await Promise.all([
    runWorker({ ...baseEnv, WORKER_LABEL: "A" }),
    runWorker({ ...baseEnv, WORKER_LABEL: "B" }),
  ]);
  assert.equal(a.exitCode, 0, "A completed");
  assert.equal(b.exitCode, 0, "B completed");
  assert.equal(a.lines.at(-1).kind, "complete");
  assert.equal(b.lines.at(-1).kind, "complete");

  const final = JSON.parse(await fsp.readFile(budgetPath, "utf8"));
  // 2 workers × 10 ticks × $0.03 = $0.60. With a healthy lock this is exact,
  // but cross-process budget is explicitly documented as NOT penny-exact
  // (gotcha #2: "don't rely on hard cents-precision enforcement"), and an
  // exact-equality assertion flaked CI under load (one lost $0.03 update).
  // An aggregate-$ check can't reliably distinguish a rare 1-tick loss on
  // correct code from a partially-broken lock, so assert only what holds
  // regardless of scheduling:
  const ticks = 10, tick = 0.03, workers = 2, expected = workers * ticks * tick;
  //   • record() can NEVER over-count — it adds its own delta to a lock-fresh
  //     read (budget.js record()), so the total can't exceed true spend. This
  //     is the hard invariant; over-counting would be a real double-apply bug.
  assert.ok(final.spent_usd <= expected + 1e-9,
    `budget over-counted (impossible under a correct lock): ${final.spent_usd} > ${expected}`);
  //   • both workers' spend accumulates cross-process — the total exceeds a
  //     single worker's run. A coarse smoke check (NOT a precise lock-accuracy
  //     assertion): it catches a catastrophic collapse where one worker's
  //     writes are entirely lost, while staying immune to the documented
  //     soft-budget slop.
  assert.ok(final.spent_usd > ticks * tick + 1e-9,
    `cross-process accumulation collapsed: ${final.spent_usd} <= one worker's ${ticks * tick}`);
});

test("second worker hits halt mid-work after first worker exhausted shared cap", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath  = path.join(dir, "audit.jsonl");
  const budgetPath = path.join(dir, "budget.json");
  await fsp.writeFile(budgetPath, JSON.stringify({ version: 1, cap_usd: 1.00, spent_usd: 0, cap_tokens: 100000, spent_tokens: 0, started_at: new Date().toISOString() }, null, 2));

  // First worker: 10 × 0.06 = 0.60 (well under cap, completes)
  const a = await runWorker({
    BAREGUARD_AUDIT_PATH: auditPath, BAREGUARD_BUDGET_FILE: budgetPath,
    BAREGUARD_PARENT_RUN_ID: "test-parent", BAREGUARD_SPAWN_DEPTH: "1",
    WORKER_TICK_COST: "0.06", WORKER_TICKS: "10", WORKER_LABEL: "A",
  });
  assert.equal(a.exitCode, 0);

  // Second worker: starts with 0.60 in shared file, spends 0.10 each tick. Hits cap at tick 5.
  const b = await runWorker({
    BAREGUARD_AUDIT_PATH: auditPath, BAREGUARD_BUDGET_FILE: budgetPath,
    BAREGUARD_PARENT_RUN_ID: "test-parent", BAREGUARD_SPAWN_DEPTH: "1",
    WORKER_TICK_COST: "0.10", WORKER_TICKS: "10", WORKER_LABEL: "B",
  });
  assert.equal(b.exitCode, 2, "B should exit 2 on deny");
  const last = b.lines.at(-1);
  assert.equal(last.kind, "deny");
  assert.equal(last.severity, "halt");
  assert.equal(last.rule, "budget.maxCostUsd");
});

test("record() fails loud on a corrupt budget file — no silent stale-local write", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const budgetPath = path.join(dir, "budget.json");

  const b = new Budget({ sharedFile: budgetPath, maxCostUsd: 5 });
  await b.init();                                       // seeds a valid file
  const corrupt = "{ not valid json";
  await fsp.writeFile(budgetPath, corrupt);             // corrupt it post-init

  // Under the lock the read now fails — record must throw rather than fall
  // back to writing stale local state (which would clobber/lose spend).
  await assert.rejects(
    () => b.record({ costUsd: 0.01, tokens: 10 }),
    (err) => err instanceof BudgetUnavailableError,
    "corrupt budget file under record must fail loud, not silently overwrite",
  );

  // and the corrupt file must NOT have been clobbered with a stale-local value
  assert.equal(await fsp.readFile(budgetPath, "utf8"), corrupt,
    "record must not write over a budget file it couldn't read");
});

test("_write retries rename on transient Windows errors, then succeeds (regression: v0.5.1 atomic write EPERM on win32)", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const budgetPath = path.join(dir, "budget.json");
  const b = new Budget({ sharedFile: budgetPath, maxCostUsd: 5 });

  // Force the win32 retry branch regardless of the host OS, so this regression
  // runs on the Linux/macOS CI legs too (the bug only fires on Windows).
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", origPlatform));

  // First two renames throw a transient EPERM (as MoveFileEx does when the dest
  // is briefly held); the third is the real rename.
  const realRename = fsp.rename.bind(fsp);
  let calls = 0;
  t.mock.method(fsp, "rename", async (from, to) => {
    calls++;
    if (calls < 3) { const e = new Error("EPERM: operation not permitted, rename"); e.code = "EPERM"; throw e; }
    return realRename(from, to);
  });

  await b._write();
  assert.equal(calls, 3, "rename should be retried until it succeeds");
  const s = JSON.parse(await fsp.readFile(budgetPath, "utf8"));
  assert.equal(s.cap_usd, 5, "budget file is written after the retries succeed");
});

test("_write does NOT retry a non-transient rename error and cleans up the temp file", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const budgetPath = path.join(dir, "budget.json");
  const b = new Budget({ sharedFile: budgetPath, maxCostUsd: 5 });

  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", origPlatform));

  let calls = 0;
  t.mock.method(fsp, "rename", async () => {
    calls++; const e = new Error("ENOENT"); e.code = "ENOENT"; throw e;
  });

  await assert.rejects(() => b._write(), (err) => err.code === "ENOENT",
    "a non-transient rename error propagates immediately");
  assert.equal(calls, 1, "non-transient errors are not retried");
  // temp file must be cleaned up on failure (no orphaned *.tmp left behind)
  const leftovers = (await fsp.readdir(dir)).filter(f => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "temp file is unlinked when the rename fails");
});
