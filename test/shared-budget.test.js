import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import url from "node:url";
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

test("two children spend concurrently against shared budget — total is exact", async (t) => {
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
  // 2 workers × 10 ticks × $0.03 = $0.60 exact (no lost updates from contention)
  assert.ok(Math.abs(final.spent_usd - 0.60) < 1e-9, `expected 0.60, got ${final.spent_usd}`);
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
