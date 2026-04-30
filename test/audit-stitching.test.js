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

test("single audit file — multiple processes all append to one path with O_APPEND atomicity", async (t) => {
  const dir = await makeTmpDir(); t.after(async () => cleanup(dir));
  const auditPath  = path.join(dir, "audit.jsonl");
  const budgetPath = path.join(dir, "budget.json");
  await fsp.writeFile(budgetPath, JSON.stringify({ version: 1, cap_usd: 5.00, spent_usd: 0, cap_tokens: 100000, spent_tokens: 0, started_at: new Date().toISOString() }, null, 2));

  const parentRunId = "stitch-parent";
  const baseEnv = {
    BAREGUARD_AUDIT_PATH: auditPath,
    BAREGUARD_BUDGET_FILE: budgetPath,
    BAREGUARD_PARENT_RUN_ID: parentRunId,
    BAREGUARD_SPAWN_DEPTH: "1",
    WORKER_TICK_COST: "0.01",
    WORKER_TICKS: "5",
  };

  // Spawn 3 workers concurrently, all pointed at the same audit file.
  const results = await Promise.all([
    runWorker({ ...baseEnv, WORKER_LABEL: "A" }),
    runWorker({ ...baseEnv, WORKER_LABEL: "B" }),
    runWorker({ ...baseEnv, WORKER_LABEL: "C" }),
  ]);
  for (const r of results) assert.equal(r.exitCode, 0);

  // ONE file should contain all the events.
  const buf = await fsp.readFile(auditPath, "utf8");
  const lines = buf.split("\n").filter(Boolean);
  // Each worker emits 5 gate + 5 record = 10 lines. 3 workers → 30 lines.
  assert.equal(lines.length, 30, `expected 30 audit lines in single file, got ${lines.length}`);

  // Every line should parse as valid JSON (no torn writes).
  const parsed = lines.map(l => JSON.parse(l));

  // Group by run_id; expect 3 distinct run ids, each with 10 lines.
  const byRunId = new Map();
  for (const p of parsed) {
    if (!byRunId.has(p.run_id)) byRunId.set(p.run_id, []);
    byRunId.get(p.run_id).push(p);
  }
  assert.equal(byRunId.size, 3, "exactly 3 distinct run_ids in the audit file");
  for (const [, evs] of byRunId) {
    assert.equal(evs.length, 10, `each worker should have 10 events; got ${evs.length}`);
    for (const e of evs) {
      assert.equal(e.parent_run_id, parentRunId);
      assert.equal(e.spawn_depth, 1);
    }
  }
});
