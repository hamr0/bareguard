// bareguard POC — phase 3 (PRD §20)
// Multi-process: shared budget under lock contention, parent_run_id + spawn_depth
// stitching across separate audit files, limits.maxChildren and limits.maxDepth
// across a real spawn tree.
// Anti-goals: no API polish, no docs, no tests, single file. Crude.
// Run: node poc/phase3.mjs              (parent / scenario driver)
//      ROLE=worker ... node poc/phase3.mjs   (child invocation; not run by hand)

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn as cpSpawn } from "node:child_process";
import lockfile from "proper-lockfile";

// =============================================================================
// minimal Gate — trimmed for phase 3 (budget + audit + limits.spawn)
// =============================================================================

class Audit {
  constructor(filePath, runId, parentRunId, spawnDepth) {
    this.filePath = filePath; this.runId = runId;
    this.parentRunId = parentRunId; this.spawnDepth = spawnDepth;
    this.seq = 0;
  }
  async emit(line) {
    line.ts = new Date().toISOString();
    line.seq = ++this.seq;
    line.run_id = this.runId;
    line.parent_run_id = this.parentRunId;
    line.spawn_depth = this.spawnDepth;
    await fsp.appendFile(this.filePath, JSON.stringify(line) + "\n");
  }
}

class Budget {
  constructor(cfg) {
    this.capUsd = cfg.maxCostUsd ?? Infinity;
    this.sharedFile = cfg.sharedFile;
    this.spentUsd = 0;
  }
  async init() {
    if (!this.sharedFile) return;
    try {
      const s = JSON.parse(await fsp.readFile(this.sharedFile, "utf8"));
      this.spentUsd = s.spent_usd ?? 0;
      this.capUsd = s.cap_usd ?? this.capUsd;
    } catch {
      await fsp.writeFile(this.sharedFile, JSON.stringify({ cap_usd: this.capUsd, spent_usd: 0 }, null, 2));
    }
  }
  async _withLock(fn) {
    const release = await lockfile.lock(this.sharedFile, {
      retries: { retries: 20, minTimeout: 20, maxTimeout: 200 },
    });
    try { return await fn(); } finally { await release(); }
  }
  check() {
    if (this.spentUsd >= this.capUsd) {
      return { outcome: "askHuman", severity: "halt", rule: "budget.maxCostUsd",
               reason: `spent $${this.spentUsd.toFixed(4)} >= cap $${this.capUsd.toFixed(2)}` };
    }
    return null;
  }
  async refresh() {
    if (!this.sharedFile) return;
    try {
      const s = JSON.parse(await fsp.readFile(this.sharedFile, "utf8"));
      this.spentUsd = s.spent_usd ?? 0;
      this.capUsd = s.cap_usd ?? this.capUsd;
    } catch { /* keep local */ }
  }
  async record(result) {
    const dUsd = result?.costUsd ?? 0;
    if (!this.sharedFile) { this.spentUsd += dUsd; return; }
    await this._withLock(async () => {
      const s = JSON.parse(await fsp.readFile(this.sharedFile, "utf8"));
      s.spent_usd = (s.spent_usd ?? 0) + dUsd;
      this.spentUsd = s.spent_usd;
      this.capUsd = s.cap_usd ?? this.capUsd;
      await fsp.writeFile(this.sharedFile, JSON.stringify(s, null, 2));
    });
  }
}

class Limits {
  constructor(cfg) {
    this.maxChildren = cfg.maxChildren ?? Infinity;
    this.maxDepth    = cfg.maxDepth    ?? Infinity;
    this.startingDepth = cfg.startingDepth ?? 0;
    this.children = 0;
  }
  spawnCheck() {
    if (this.children + 1 > this.maxChildren) {
      return { outcome: "deny", severity: "action", rule: "limits.maxChildren",
               reason: `${this.children + 1} > ${this.maxChildren}` };
    }
    if (this.startingDepth + 1 > this.maxDepth) {
      return { outcome: "deny", severity: "action", rule: "limits.maxDepth",
               reason: `depth ${this.startingDepth + 1} > ${this.maxDepth}` };
    }
    return null;
  }
  noteSpawn() { this.children += 1; }
}

class Gate {
  constructor(cfg) {
    this.cfg = cfg;
    this.runId = cfg.runId ?? randomUUID();
    this.parentRunId = cfg.parentRunId ?? null;
    this.spawnDepth = cfg.spawnDepth ?? 0;
    this.audit = new Audit(cfg.auditPath, this.runId, this.parentRunId, this.spawnDepth);
    this.budget = new Budget(cfg.budget ?? {});
    this.limits = new Limits({ ...cfg.limits, startingDepth: this.spawnDepth });
  }
  async init() {
    try { await fsp.access(this.cfg.auditPath); }
    catch { await fsp.writeFile(this.cfg.auditPath, ""); }
    await this.budget.init();
  }
  async check(action) {
    await this.budget.refresh();   // pick up cross-process updates
    const b = this.budget.check();
    if (b) { await this.audit.emit({ phase: "gate", action, decision: b.outcome, severity: b.severity, rule: b.rule, reason: b.reason }); return b; }
    if (action.type === "spawn") {
      const s = this.limits.spawnCheck();
      if (s) { await this.audit.emit({ phase: "gate", action, decision: s.outcome, severity: s.severity, rule: s.rule, reason: s.reason }); return s; }
    }
    const ok = { outcome: "allow", severity: "action", rule: "default", reason: null };
    await this.audit.emit({ phase: "gate", action, decision: ok.outcome, severity: ok.severity, rule: ok.rule, reason: null });
    return ok;
  }
  async record(action, result) {
    await this.budget.record(result);
    await this.audit.emit({ phase: "record", action, decision: null, severity: null, rule: null, reason: null, result });
  }
}

// =============================================================================
// child / worker mode: do bounded work, halt on budget exhaustion
// =============================================================================

async function runWorker() {
  const auditDir   = process.env.BAREGUARD_AUDIT_DIR;
  const budgetFile = process.env.BAREGUARD_BUDGET_FILE;
  const parentRunId = process.env.BAREGUARD_PARENT_RUN_ID;
  const spawnDepth = +(process.env.BAREGUARD_SPAWN_DEPTH ?? 0);
  const tickCost   = +(process.env.WORKER_TICK_COST ?? 0.03);
  const ticks      = +(process.env.WORKER_TICKS ?? 10);
  const label      = process.env.WORKER_LABEL ?? "worker";

  const runId = randomUUID();
  const gate = new Gate({
    runId, parentRunId, spawnDepth,
    auditPath: path.join(auditDir, `${label}-${runId}.jsonl`),
    budget: { sharedFile: budgetFile },   // cap inherited from file
    limits: { maxChildren: +(process.env.WORKER_MAX_CHILDREN ?? 0), maxDepth: +(process.env.WORKER_MAX_DEPTH ?? 0) },
  });
  await gate.init();

  // optional: this worker spawns a grandchild before doing its own work
  // (used for the maxDepth scenario)
  const grandConfig = process.env.WORKER_SPAWN_GRANDCHILD;
  if (grandConfig) {
    const dec = await gate.check({ type: "spawn", config: grandConfig });
    if (dec.outcome === "deny") {
      process.stdout.write(JSON.stringify({ type: "spawn-denied", rule: dec.rule, reason: dec.reason, depth: spawnDepth }) + "\n");
      process.exit(3);
    }
    gate.limits.noteSpawn();
    const grand = await spawnWorker({
      label: `gc-d${spawnDepth + 1}`,
      auditDir, budgetFile, parentRunId: runId, spawnDepth: spawnDepth + 1,
      tickCost: 0, ticks: 0,
      maxChildren: gate.limits.maxChildren, maxDepth: gate.limits.maxDepth,
      spawnGrandchild: process.env.WORKER_SPAWN_GREAT_GRANDCHILD ?? "",
    });
    // bubble grandchild's stdout JSONL up to our own stdout so the driver sees the full chain
    for (const line of grand.lines) process.stdout.write(JSON.stringify(line) + "\n");
  }

  for (let i = 0; i < ticks; i++) {
    const dec = await gate.check({ type: "work", iter: i });
    if (dec.severity === "halt") {
      process.stdout.write(JSON.stringify({ type: "halt", rule: dec.rule, reason: dec.reason, spent: gate.budget.spentUsd, label, runId }) + "\n");
      process.exit(2);
    }
    await gate.record({ type: "work", iter: i }, { costUsd: tickCost, tokens: 100 });
  }
  process.stdout.write(JSON.stringify({ type: "complete", spent: gate.budget.spentUsd, ticks, label, runId }) + "\n");
  process.exit(0);
}

// helper: spawn a worker subprocess and collect its stdout JSONL
function spawnWorker({ label, auditDir, budgetFile, parentRunId, spawnDepth, tickCost, ticks, maxChildren, maxDepth, spawnGrandchild = "", spawnGreatGrand = "" }) {
  return new Promise((resolve, reject) => {
    const child = cpSpawn(process.execPath, [path.resolve(process.argv[1])], {
      env: {
        ...process.env,
        BAREGUARD_ROLE: "worker",
        BAREGUARD_AUDIT_DIR: auditDir,
        BAREGUARD_BUDGET_FILE: budgetFile,
        BAREGUARD_PARENT_RUN_ID: parentRunId,
        BAREGUARD_SPAWN_DEPTH: String(spawnDepth),
        WORKER_LABEL: label,
        WORKER_TICK_COST: String(tickCost),
        WORKER_TICKS: String(ticks),
        WORKER_MAX_CHILDREN: String(maxChildren ?? 0),
        WORKER_MAX_DEPTH: String(maxDepth ?? 0),
        WORKER_SPAWN_GRANDCHILD: spawnGrandchild,
        WORKER_SPAWN_GREAT_GRANDCHILD: spawnGreatGrand,
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", d => { buf += d.toString(); });
    child.on("exit", code => {
      const lines = buf.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
      resolve({ exitCode: code, lines });
    });
    child.on("error", reject);
  });
}

// =============================================================================
// parent / driver mode: run the four scenarios
// =============================================================================

async function runScenarios() {
  const auditDir = `/tmp/bareguard-poc-phase3-${randomUUID()}`;
  await fsp.mkdir(auditDir, { recursive: true });
  console.log(`[parent] audit dir: ${auditDir}`);

  let pass = 0, fail = 0;
  const expect = (label, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} ${label}`); };

  // ---------------------------------------------------------------------------
  // Scenario A: shared budget under contention (concurrent children spending)
  // ---------------------------------------------------------------------------
  console.log("\n=== A: shared budget under contention ===");
  const budgetA = path.join(auditDir, "A-budget.json");
  await fsp.writeFile(budgetA, JSON.stringify({ cap_usd: 5.00, spent_usd: 0 }, null, 2));
  const parentRunIdA = randomUUID();
  // launch 2 children concurrently, each spends 0.30 (10 ticks * 0.03)
  const [a1, a2] = await Promise.all([
    spawnWorker({ label: "A1", auditDir, budgetFile: budgetA, parentRunId: parentRunIdA, spawnDepth: 1, tickCost: 0.03, ticks: 10 }),
    spawnWorker({ label: "A2", auditDir, budgetFile: budgetA, parentRunId: parentRunIdA, spawnDepth: 1, tickCost: 0.03, ticks: 10 }),
  ]);
  const finalA = JSON.parse(await fsp.readFile(budgetA, "utf8"));
  console.log(`  A1: ${JSON.stringify(a1.lines.at(-1))}`);
  console.log(`  A2: ${JSON.stringify(a2.lines.at(-1))}`);
  console.log(`  shared file: spent_usd=${finalA.spent_usd.toFixed(4)}`);
  expect("A: both children completed", a1.exitCode === 0 && a2.exitCode === 0);
  expect("A: shared budget total = 0.6", Math.abs(finalA.spent_usd - 0.6) < 1e-9);

  // ---------------------------------------------------------------------------
  // Scenario B: budget halt cascade (sequential; second child halts mid-work)
  // ---------------------------------------------------------------------------
  console.log("\n=== B: budget halt cascade ===");
  const budgetB = path.join(auditDir, "B-budget.json");
  await fsp.writeFile(budgetB, JSON.stringify({ cap_usd: 1.00, spent_usd: 0 }, null, 2));
  const parentRunIdB = randomUUID();
  // child B1 spends 0.60 (10 * 0.06)
  const b1 = await spawnWorker({ label: "B1", auditDir, budgetFile: budgetB, parentRunId: parentRunIdB, spawnDepth: 1, tickCost: 0.06, ticks: 10 });
  console.log(`  B1: ${JSON.stringify(b1.lines.at(-1))}`);
  // child B2 starts with 0.60 already in shared file. tickCost 0.10, 10 ticks max → would push past 1.00 around tick 4-5
  const b2 = await spawnWorker({ label: "B2", auditDir, budgetFile: budgetB, parentRunId: parentRunIdB, spawnDepth: 1, tickCost: 0.10, ticks: 10 });
  console.log(`  B2: ${JSON.stringify(b2.lines.at(-1))}`);
  expect("B: first child completed", b1.exitCode === 0);
  expect("B: second child halted (exit 2)", b2.exitCode === 2);
  expect("B: halt rule = budget.maxCostUsd", b2.lines.at(-1)?.rule === "budget.maxCostUsd");

  // ---------------------------------------------------------------------------
  // Scenario C: limits.maxChildren denies the 3rd spawn at parent's gate
  // ---------------------------------------------------------------------------
  console.log("\n=== C: limits.maxChildren ===");
  const budgetC = path.join(auditDir, "C-budget.json");
  await fsp.writeFile(budgetC, JSON.stringify({ cap_usd: 5.00, spent_usd: 0 }, null, 2));
  const parentRunIdC = randomUUID();
  const parentGate = new Gate({
    runId: parentRunIdC, spawnDepth: 0,
    auditPath: path.join(auditDir, `C-parent-${parentRunIdC}.jsonl`),
    budget: { sharedFile: budgetC },
    limits: { maxChildren: 2, maxDepth: 5 },
  });
  await parentGate.init();
  const decC1 = await parentGate.check({ type: "spawn", config: "x" }); parentGate.limits.noteSpawn();
  const decC2 = await parentGate.check({ type: "spawn", config: "x" }); parentGate.limits.noteSpawn();
  const decC3 = await parentGate.check({ type: "spawn", config: "x" });
  console.log(`  spawn 1 → ${decC1.outcome} (${decC1.rule})`);
  console.log(`  spawn 2 → ${decC2.outcome} (${decC2.rule})`);
  console.log(`  spawn 3 → ${decC3.outcome} (${decC3.rule})`);
  expect("C: 1st spawn allow", decC1.outcome === "allow");
  expect("C: 2nd spawn allow", decC2.outcome === "allow");
  expect("C: 3rd spawn deny + maxChildren", decC3.outcome === "deny" && decC3.rule === "limits.maxChildren");

  // ---------------------------------------------------------------------------
  // Scenario D: limits.maxDepth across a 3-deep tree
  // parent (d=0) → child (d=1) → grandchild (d=2). maxDepth=2.
  // grandchild trying to spawn great-grandchild (d=3) → action deny.
  // ---------------------------------------------------------------------------
  console.log("\n=== D: limits.maxDepth (3-deep tree, cap=2) ===");
  const budgetD = path.join(auditDir, "D-budget.json");
  await fsp.writeFile(budgetD, JSON.stringify({ cap_usd: 5.00, spent_usd: 0 }, null, 2));
  const parentRunIdD = randomUUID();
  // give D a real parent gate at depth 0 so the audit tree has all 3 levels
  const parentGateD = new Gate({
    runId: parentRunIdD, spawnDepth: 0, parentRunId: null,
    auditPath: path.join(auditDir, `D-parent-${parentRunIdD}.jsonl`),
    budget: { sharedFile: budgetD },
    limits: { maxChildren: 2, maxDepth: 2 },
  });
  await parentGateD.init();
  const decDspawn = await parentGateD.check({ type: "spawn", config: "D-c-d1" });
  parentGateD.limits.noteSpawn();
  console.log(`  parent spawn (d=0→1) → ${decDspawn.outcome} (${decDspawn.rule})`);
  // parent spawns child at depth 1 with maxDepth=2; child spawns grandchild at d=2;
  // grandchild attempts to spawn great-grandchild at d=3 → deny.
  const d1 = await spawnWorker({
    label: "D-c-d1", auditDir, budgetFile: budgetD,
    parentRunId: parentRunIdD, spawnDepth: 1,
    tickCost: 0, ticks: 0,
    maxChildren: 2, maxDepth: 2,
    spawnGrandchild: "yes",         // child spawns grandchild
    spawnGreatGrand: "yes",         // grandchild attempts great-grandchild
  });
  // print the entire stdout chain for visibility
  console.log("  D-stdout chain:");
  for (const l of d1.lines) console.log(`    ${JSON.stringify(l)}`);
  expect("D: parent's gate allowed d=0→1 spawn",  decDspawn.outcome === "allow");
  expect("D: great-grandchild spawn-denied at d=2", d1.lines.some(l => l.type === "spawn-denied" && l.rule === "limits.maxDepth" && l.depth === 2));

  // ---------------------------------------------------------------------------
  // Audit stitching: grep across all audit files for parent_run_id
  // ---------------------------------------------------------------------------
  console.log("\n=== Audit stitching ===");
  const allFiles = await fsp.readdir(auditDir);
  const auditFiles = allFiles.filter(f => f.endsWith(".jsonl"));
  const tree = {};
  for (const f of auditFiles) {
    const buf = await fsp.readFile(path.join(auditDir, f), "utf8");
    for (const line of buf.split("\n").filter(Boolean)) {
      const o = JSON.parse(line);
      if (!o.run_id) continue;
      const parent = o.parent_run_id ?? "ROOT";
      tree[parent] ??= new Set();
      tree[parent].add(`${o.run_id} (depth=${o.spawn_depth})`);
    }
  }
  for (const [parent, kids] of Object.entries(tree)) {
    const tag = parent === "ROOT" ? "ROOT" : parent.slice(0, 8);
    console.log(`  ${tag}: ${[...kids].map(k => k.slice(0, 18)).join(", ")}`);
  }
  expect("stitching: A had 2 children of parentRunIdA", tree[parentRunIdA]?.size === 2);
  // D tree audit files: D-parent-{uuid} (d=0), D-c-d1-{uuid} (d=1), gc-d2-{uuid} (d=2)
  const dFiles = auditFiles.filter(f => f.startsWith("D-") || f.startsWith("gc-"));
  expect("stitching: D tree has all 3 audit levels (d0/d1/d2)", dFiles.length >= 3);

  console.log(`\n${pass}/${pass + fail} expectations passed`);
  console.log(`audit artifacts: ${auditDir}`);
  process.exit(fail === 0 ? 0 : 1);
}

// =============================================================================
// entry
// =============================================================================

if (process.env.BAREGUARD_ROLE === "worker") {
  await runWorker();
} else {
  await runScenarios();
}
