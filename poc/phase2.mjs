// bareguard POC — phase 2 (PRD §20 + v0.5 amendments)
// Adds: fs, net, secrets, content (with safe defaults), JSONL-to-disk audit,
//       severity field, halt classification, shared budget file w/ proper-lockfile,
//       budget reconstruction from audit log, halt-flow methods.
// Anti-goals: no API polish, no error-handling polish, no tests, no docs. CRUDE.
// Run: node poc/phase2.mjs

import { randomUUID, createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

// =============================================================================
// helpers
// =============================================================================

function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + esc + "$");
}
const matchAny = (name, globs) => globs.some(g => globToRegex(g).test(name));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// =============================================================================
// primitive: secrets — pre-eval action redaction (amendment §10)
// =============================================================================

function redactAction(action, cfg) {
  let s = JSON.stringify(action);
  // Env-var match: redact value, tag with var name
  for (const v of cfg.envVars ?? []) {
    const val = process.env[v];
    if (val && val.length >= 8) {
      s = s.split(val).join(`[REDACTED:${v}]`);
    }
  }
  // Pattern match: redact value, tag with short pattern hint
  for (const re of cfg.patterns ?? []) {
    s = s.replace(re, m => `[REDACTED:pattern=${m.slice(0, 4)}...]`);
  }
  return JSON.parse(s);
}

// =============================================================================
// primitive: bash — step 5 (per-action-type)
// =============================================================================

function bashCheck(action, cfg) {
  if (action.type !== "bash") return null;
  const cmd = action.cmd ?? "";
  if (cfg.denyPatterns?.some(re => re.test(cmd))) {
    return { outcome: "deny", severity: "action", rule: "bash.denyPatterns", reason: "denied pattern" };
  }
  if (cfg.allow && !cfg.allow.some(p => cmd.startsWith(p))) {
    return { outcome: "deny", severity: "action", rule: "bash.allow", reason: "not in bash allow" };
  }
  return null;
}

// =============================================================================
// primitive: fs — step 5
// =============================================================================

function fsCheck(action, cfg) {
  if (!["read", "write", "edit"].includes(action.type)) return null;
  const p = action.path ?? "";
  if (cfg.deny?.some(d => p.includes(d))) {
    return { outcome: "deny", severity: "action", rule: "fs.deny", reason: `path matches deny: ${p}` };
  }
  if (action.type === "read" && cfg.readScope) {
    if (!cfg.readScope.some(s => p.startsWith(s))) {
      return { outcome: "deny", severity: "action", rule: "fs.readScope", reason: "outside read scope" };
    }
  }
  if (["write", "edit"].includes(action.type) && cfg.writeScope) {
    if (!cfg.writeScope.some(s => p.startsWith(s))) {
      return { outcome: "deny", severity: "action", rule: "fs.writeScope", reason: "outside write scope" };
    }
  }
  return null;
}

// =============================================================================
// primitive: net — step 5
// =============================================================================

function isPrivateIp(host) {
  // crude — POC only: 10/8, 172.16-31, 192.168/16, 127, ::1, localhost
  if (/^(localhost|127\.|::1$)/i.test(host)) return true;
  const m = host.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
function netCheck(action, cfg) {
  if (action.type !== "fetch") return null;
  const url = action.url ?? "";
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (cfg.denyPrivateIps && isPrivateIp(host)) {
    return { outcome: "deny", severity: "action", rule: "net.denyPrivateIps", reason: `private host ${host}` };
  }
  if (cfg.allowDomains && !cfg.allowDomains.some(d => host === d || host.endsWith("." + d))) {
    return { outcome: "deny", severity: "action", rule: "net.allowDomains", reason: `host ${host} not in allowDomains` };
  }
  return null;
}

// =============================================================================
// primitive: content — steps 2 (deny) and 4 (ask), safe defaults shipped
// =============================================================================

const CONTENT_DEFAULTS = {
  denyPatterns: [
    /\bDROP\s+TABLE\b/i,
    /\bDELETE\s+FROM\s+\w+(?!\s+WHERE)/i,
    /\brm\s+-rf\s+\//,
    /:(force|--force|-f)\s/,
    /\bTRUNCATE\s+TABLE\b/i,
  ],
  askPatterns: [
    /\b(delete|drop|revoke|truncate|destroy|remove|purge)\b/i,
    /\bforce[- ]push\b/i,
    /"method"\s*:\s*"(DELETE|PUT|PATCH)"/i,
  ],
};
function contentDeny(serialized, cfg) {
  const all = [...(cfg?.denyPatterns ?? CONTENT_DEFAULTS.denyPatterns)];
  const hit = all.find(re => re.test(serialized));
  return hit ? { outcome: "deny", severity: "action", rule: "content.denyPatterns", reason: `matched ${hit}` } : null;
}
function contentAsk(serialized, cfg) {
  const all = [...(cfg?.askPatterns ?? CONTENT_DEFAULTS.askPatterns)];
  const hit = all.find(re => re.test(serialized));
  return hit ? { outcome: "askHuman", severity: "action", rule: "content.askPatterns", reason: `matched ${hit}` } : null;
}

// =============================================================================
// audit — JSONL to disk (append-only)
// =============================================================================

class Audit {
  constructor(filePath, runId) {
    this.filePath = filePath;
    this.runId = runId;
    this.seq = 0;
  }
  async emit(line) {
    line.ts = new Date().toISOString();
    line.seq = ++this.seq;
    line.run_id = this.runId;
    line.parent_run_id = line.parent_run_id ?? null;
    line.spawn_depth = line.spawn_depth ?? 0;
    await fsp.appendFile(this.filePath, JSON.stringify(line) + "\n");
    return line;
  }
}

// =============================================================================
// budget — shared file with proper-lockfile, halt severity
// =============================================================================

class Budget {
  constructor(cfg, audit) {
    this.capUsd    = cfg.maxCostUsd ?? Infinity;
    this.capTokens = cfg.maxTokens ?? Infinity;
    this.sharedFile = cfg.sharedFile;
    this.audit = audit;
    // local cache; truth lives in shared file (or audit on rebuild)
    this.spentUsd = 0;
    this.spentTokens = 0;
  }
  async init() {
    if (!this.sharedFile) return;
    try {
      const buf = await fsp.readFile(this.sharedFile, "utf8");
      const s = JSON.parse(buf);
      this.spentUsd = s.spent_usd ?? 0;
      this.spentTokens = s.spent_tokens ?? 0;
      this.capUsd = s.cap_usd ?? this.capUsd;
      this.capTokens = s.cap_tokens ?? this.capTokens;
    } catch {
      // file missing — reconstruct from audit log if it exists
      await this._rebuildFromAudit();
      await this._writeFile();
    }
  }
  async _rebuildFromAudit() {
    try {
      const buf = await fsp.readFile(this.audit.filePath, "utf8");
      for (const line of buf.split("\n").filter(Boolean)) {
        const o = JSON.parse(line);
        if (o.phase === "record" && o.result) {
          this.spentUsd += o.result.costUsd ?? 0;
          this.spentTokens += o.result.tokens ?? 0;
        }
        if (o.phase === "topup" && o.dimension === "costUsd") this.capUsd = o.newCap;
        if (o.phase === "topup" && o.dimension === "tokens") this.capTokens = o.newCap;
      }
    } catch { /* no audit yet */ }
  }
  async _writeFile() {
    if (!this.sharedFile) return;
    const state = {
      cap_usd: this.capUsd,
      spent_usd: this.spentUsd,
      cap_tokens: this.capTokens,
      spent_tokens: this.spentTokens,
      updated_at: new Date().toISOString(),
    };
    await fsp.writeFile(this.sharedFile, JSON.stringify(state, null, 2));
  }
  async _withLock(fn) {
    if (!this.sharedFile) return fn();
    // proper-lockfile requires the target file to exist
    try { await fsp.access(this.sharedFile); }
    catch { await this._writeFile(); }
    const release = await lockfile.lock(this.sharedFile, { retries: { retries: 5, minTimeout: 50, maxTimeout: 500 } });
    try { return await fn(); }
    finally { await release(); }
  }
  check() {
    if (this.spentUsd >= this.capUsd) {
      return { outcome: "askHuman", severity: "halt", rule: "budget.maxCostUsd",
               reason: `spent $${this.spentUsd.toFixed(4)} >= cap $${this.capUsd.toFixed(2)}` };
    }
    if (this.spentTokens >= this.capTokens) {
      return { outcome: "askHuman", severity: "halt", rule: "budget.maxTokens",
               reason: `spent ${this.spentTokens} >= cap ${this.capTokens}` };
    }
    return null;
  }
  async record(result) {
    const dUsd = result?.costUsd ?? 0;
    const dTok = result?.tokens ?? 0;
    await this._withLock(async () => {
      // re-read under lock to handle concurrent writers
      try {
        const buf = await fsp.readFile(this.sharedFile, "utf8");
        const s = JSON.parse(buf);
        this.spentUsd = s.spent_usd ?? 0;
        this.spentTokens = s.spent_tokens ?? 0;
      } catch { /* no shared file — local only */ }
      this.spentUsd += dUsd;
      this.spentTokens += dTok;
      await this._writeFile();
    });
  }
  async raiseCap(dim, newCap) {
    await this._withLock(async () => {
      if (dim === "costUsd") this.capUsd = newCap;
      else if (dim === "tokens") this.capTokens = newCap;
      await this._writeFile();
    });
  }
}

// =============================================================================
// limits — maxTurns is halt; maxChildren/maxDepth are action
// =============================================================================

class Limits {
  constructor(cfg) {
    this.maxTurns = cfg.maxTurns ?? Infinity;
    this.maxChildren = cfg.maxChildren ?? Infinity;
    this.maxDepth = cfg.maxDepth ?? Infinity;
    this.turns = 0;
    this.children = 0;
    this.depth = cfg.startingDepth ?? 0;
  }
  preCheck() {
    if (this.turns >= this.maxTurns) {
      return { outcome: "askHuman", severity: "halt", rule: "limits.maxTurns",
               reason: `turns ${this.turns} >= cap ${this.maxTurns}` };
    }
    return null;
  }
  spawnCheck(action) {
    if (action.type !== "spawn") return null;
    if (this.children >= this.maxChildren) {
      return { outcome: "deny", severity: "action", rule: "limits.maxChildren", reason: `${this.children} >= ${this.maxChildren}` };
    }
    if (this.depth + 1 > this.maxDepth) {
      return { outcome: "deny", severity: "action", rule: "limits.maxDepth", reason: `depth ${this.depth + 1} > ${this.maxDepth}` };
    }
    return null;
  }
  tick() { this.turns += 1; }
}

// =============================================================================
// gate — orchestrates everything
// =============================================================================

class Gate {
  constructor(cfg) {
    this.cfg = cfg;
    this.runId = cfg.runId ?? randomUUID();
    this.auditPath = cfg.auditPath;
    this.audit = new Audit(this.auditPath, this.runId);
    this.budget = new Budget(cfg.budget ?? {}, this.audit);
    this.limits = new Limits(cfg.limits ?? {});
    this.terminated = false;
  }
  async init() {
    // ensure audit file exists
    try { await fsp.access(this.auditPath); }
    catch { await fsp.writeFile(this.auditPath, ""); }
    await this.budget.init();
  }

  redact(action) { return redactAction(action, this.cfg.secrets ?? {}); }

  // pure query, no audit, no budget delta — true for allow OR askHuman
  async allows(action) {
    const d = await this._evaluate(action, { dryRun: true });
    return d.outcome !== "deny";
  }

  async check(action) {
    if (this.terminated) {
      return this._dec({ outcome: "deny", severity: "halt", rule: "gate.terminated", reason: "gate terminated" }, action);
    }
    const d = await this._evaluate(action, { dryRun: false });
    return this._dec(d, action);
  }

  async _evaluate(action, { dryRun }) {
    const t = this.cfg.tools ?? {};
    const c = this.cfg.content;
    const serialized = JSON.stringify(action);
    const name = action.type;

    // PRE-EVAL: budget + limits.maxTurns (halt)
    const bDec = this.budget.check();
    if (bDec) return bDec;
    const lDec = this.limits.preCheck();
    if (lDec) return lDec;

    // 1. tools.denylist
    if (t.denylist && matchAny(name, t.denylist)) {
      return { outcome: "deny", severity: "action", rule: "tools.denylist", reason: `${name} on denylist` };
    }
    // 2. content.denyPatterns (universal deny)
    const cDeny = contentDeny(serialized, c);
    if (cDeny) return cDeny;
    // 3. per-action-type deny primitives (bash/fs/net/limits-spawn/rate/denyArgs)
    const perType = this._perActionTypeDeny(action);
    if (perType) return perType;
    // 4. content.askPatterns (universal ask — fires even on allowlisted tools)
    const cAsk = contentAsk(serialized, c);
    if (cAsk) return cAsk;
    // 5. tools.allowlist enforcement (scope check; no trust shortcut)
    if (t.allowlist && t.allowlist.length > 0) {
      if (matchAny(name, t.allowlist)) {
        return { outcome: "allow", severity: "action", rule: "tools.allowlist", reason: null };
      }
      return { outcome: "deny", severity: "action", rule: "tools.allowlist.exclusive", reason: `${name} not in allowlist` };
    }
    // 6. default
    return { outcome: "allow", severity: "action", rule: "default", reason: null };
  }

  _perActionTypeDeny(action) {
    return bashCheck(action, this.cfg.bash ?? {})
        ?? fsCheck(action, this.cfg.fs ?? {})
        ?? netCheck(action, this.cfg.net ?? {})
        ?? this.limits.spawnCheck(action);
  }

  async _dec(d, action) {
    await this.audit.emit({
      phase: "gate", action,
      decision: d.outcome, severity: d.severity, rule: d.rule, reason: d.reason ?? null, result: null,
    });
    return d;
  }

  async record(action, result) {
    this.limits.tick();
    await this.budget.record(result);
    await this.audit.emit({
      phase: "record", action,
      decision: null, severity: null, rule: null, reason: null, result,
    });
  }

  async recordApproval(action, humanDecision) {
    await this.audit.emit({
      phase: "approval", action,
      decision: humanDecision.decision, severity: null, rule: null,
      reason: humanDecision.reason ?? null, result: null,
      newCap: humanDecision.newCap ?? null,
    });
  }

  async raiseCap(dimension, newCap) {
    const oldCap = dimension === "costUsd" ? this.budget.capUsd : this.budget.capTokens;
    await this.budget.raiseCap(dimension, newCap);
    await this.audit.emit({
      phase: "topup", action: null,
      decision: null, severity: null, rule: null, reason: null, result: null,
      dimension, oldCap, newCap,
    });
  }

  async terminate(reason) {
    this.terminated = true;
    await this.audit.emit({
      phase: "terminate", action: null,
      decision: null, severity: null, rule: null, reason, result: null,
    });
    return { ok: true, exitCode: 0 };
  }

  async haltContext() {
    // deterministic stats over audit log
    const buf = await fsp.readFile(this.auditPath, "utf8");
    const lines = buf.split("\n").filter(Boolean).map(l => JSON.parse(l));
    const records = lines.filter(l => l.phase === "record");
    const totUsd = records.reduce((a, r) => a + (r.result?.costUsd ?? 0), 0);
    const totTok = records.reduce((a, r) => a + (r.result?.tokens ?? 0), 0);
    const last5 = records.slice(-5).map(r => r.result?.costUsd ?? 0);
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    return {
      spent: { costUsd: totUsd, tokens: totTok },
      cap:   { costUsd: this.budget.capUsd, tokens: this.budget.capTokens },
      turns: this.limits.turns,
      maxTurns: this.limits.maxTurns,
      timeElapsedMs: lines.length ? (Date.parse(lines.at(-1).ts) - Date.parse(lines[0].ts)) : 0,
      spendRate: { avgPerTurn: records.length ? totUsd / records.length : 0,
                   last5Avg: avg(last5), last5 },
      // breakdown is out-of-scope for POC (would require result tagging "llm" vs "tool")
    };
  }
}

// =============================================================================
// driver
// =============================================================================

const runId = randomUUID();
const tmp = "/tmp";
const auditPath  = path.join(tmp, `bareguard-poc-${runId}.jsonl`);
const budgetPath = path.join(tmp, `bareguard-poc-budget-${runId}.json`);

// fake API key in env so secrets redaction has something to find
process.env.FAKE_API_KEY = "sk-thisIsASecretValueThatShouldNotLeak123456";

const gate = new Gate({
  runId,
  auditPath,
  bash:    { allow: ["git", "ls", "cat"], denyPatterns: [/sudo/] },
  fs:      { writeScope: ["/tmp/agent"], readScope: ["/tmp", "/etc/hostname"], deny: ["~/.ssh", "/etc/passwd"] },
  net:     { allowDomains: ["api.anthropic.com", "github.com"], denyPrivateIps: true },
  budget:  { maxCostUsd: 0.10, maxTokens: 1000, sharedFile: budgetPath },
  limits:  { maxTurns: 5, maxChildren: 2, maxDepth: 2 },
  tools:   { allowlist: ["bash", "read", "write", "fetch", "spawn"], denylist: ["mcp:*/admin_*"] },
  secrets: { envVars: ["FAKE_API_KEY"], patterns: [/sk-[A-Za-z0-9]{20,}/] },
  // content: omit → safe defaults apply
});
await gate.init();

const cases = [
  // regression of phase 1
  { label: "denylist hit",         action: { type: "mcp:foo/admin_revoke", args: {} },                 expect: { outcome: "deny",     severity: "action", rule: "tools.denylist" } },
  { label: "content deny default", action: { type: "bash", cmd: "echo DROP TABLE users" },             expect: { outcome: "deny",     severity: "action", rule: "content.denyPatterns" } },
  { label: "bash deny (sudo)",     action: { type: "bash", cmd: "sudo reboot" },                       expect: { outcome: "deny",     severity: "action", rule: "bash.denyPatterns" } },
  { label: "bash not in allow",    action: { type: "bash", cmd: "curl evil.com" },                     expect: { outcome: "deny",     severity: "action", rule: "bash.allow" } },
  { label: "allowlist allow",      action: { type: "bash", cmd: "git status" },                        expect: { outcome: "allow",    severity: "action", rule: "tools.allowlist" } },
  // 3b. allowlist exclusive
  { label: "allowlist exclusive",  action: { type: "fetch_other", url: "https://x" },                  expect: { outcome: "deny",     severity: "action", rule: "tools.allowlist.exclusive" } },
  // 4. askPatterns fire even on allowlisted tools (v0.5 §4 — no trust shortcut)
  { label: "ask fires on allowlisted",  action: { type: "fetch", url: "https://api.anthropic.com/delete-acct" }, expect: { outcome: "askHuman", severity: "action", rule: "content.askPatterns" } },
  // step 5 — fs
  { label: "fs.deny",              action: { type: "read", path: "/etc/passwd" },                      expect: { outcome: "deny",     severity: "action", rule: "fs.deny" } },
  { label: "fs.readScope",         action: { type: "read", path: "/var/log/messages" },                expect: { outcome: "deny",     severity: "action", rule: "fs.readScope" } },
  { label: "fs.writeScope",        action: { type: "write", path: "/etc/foo", content: "x" },          expect: { outcome: "deny",     severity: "action", rule: "fs.writeScope" } },
  // step 5 — net
  { label: "net.allowDomains",     action: { type: "fetch", url: "https://evil.com/x" },               expect: { outcome: "deny",     severity: "action", rule: "net.allowDomains" } },
  { label: "net.denyPrivateIps",   action: { type: "fetch", url: "http://192.168.1.1/admin" },         expect: { outcome: "deny",     severity: "action", rule: "net.denyPrivateIps" } },
  // step 5 — limits.maxChildren is action-severity
  // step 6 default allow (a bare action that bypasses everything except allowlist exclusive)
  // since allowlist is set-and-exclusive, default-allow path is hard to reach. skip; covered in phase 1.
];

console.log("=== eval order with severity ===");
let pass = 0, fail = 0;
for (const c of cases) {
  const d = await gate.check(c.action);
  const ok = d.outcome === c.expect.outcome && d.severity === c.expect.severity && d.rule === c.expect.rule;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.label.padEnd(28)} → ${d.outcome.padEnd(9)} sev=${d.severity.padEnd(6)} (${d.rule})${ok ? "" : `  EXPECTED ${c.expect.outcome}/${c.expect.severity}/${c.expect.rule}`}`);
}
console.log(`${pass}/${pass + fail} passed`);

// askPatterns fire when allowlist is unset
console.log("\n=== askPatterns (no allowlist set) ===");
const askGate = new Gate({
  runId: randomUUID(),
  auditPath: path.join(tmp, `bareguard-poc-ask-${randomUUID()}.jsonl`),
  // no tools.allowlist → step 3 doesn't short-circuit
});
await askGate.init();
const askDec = await askGate.check({ type: "fetch", url: "https://x/delete-account" });
console.log(`fetch with /delete/ → outcome=${askDec.outcome} rule=${askDec.rule}`);
console.log(askDec.outcome === "askHuman" && askDec.rule === "content.askPatterns" ? "PASS" : "FAIL");

// secrets redaction demo
console.log("\n=== secrets redaction ===");
const dirty = { type: "fetch", url: "https://api.anthropic.com/x", headers: { authz: `Bearer ${process.env.FAKE_API_KEY}` } };
const clean = gate.redact(dirty);
console.log("clean action:", JSON.stringify(clean));
const leaked = JSON.stringify(clean).includes(process.env.FAKE_API_KEY);
console.log(leaked ? "FAIL: secret leaked" : "PASS: secret redacted with name tag");

// halt: budget exhaustion
console.log("\n=== halt: budget exhaustion ===");
await gate.record({ type: "bash", cmd: "git status" }, { costUsd: 0.15, tokens: 50 }); // overspend
const haltDec = await gate.check({ type: "bash", cmd: "git log" });
console.log(`post-overspend → outcome=${haltDec.outcome} severity=${haltDec.severity} rule=${haltDec.rule}`);
console.log(haltDec.severity === "halt" && haltDec.rule === "budget.maxCostUsd" ? "PASS" : "FAIL");

// halt context (deterministic stats)
console.log("\n=== haltContext ===");
const ctx = await gate.haltContext();
console.log(JSON.stringify(ctx, null, 2));

// approval flow + raiseCap → continue
console.log("\n=== approval + raiseCap ===");
await gate.recordApproval({ type: "bash", cmd: "git log" }, { decision: "topup", newCap: 1.00, reason: "operator approved" });
await gate.raiseCap("costUsd", 1.00);
const post = await gate.check({ type: "bash", cmd: "git status" });
console.log(`post-topup → outcome=${post.outcome} severity=${post.severity} rule=${post.rule}`);
console.log(post.outcome === "allow" ? "PASS" : "FAIL");

// halt: maxTurns
console.log("\n=== halt: maxTurns ===");
// push turns to maxTurns. We've done 1 record so far → tick=1. Need to hit 5.
for (let i = 0; i < 4; i++) {
  await gate.record({ type: "bash", cmd: "ls" }, { costUsd: 0.01, tokens: 10 });
}
const turnsDec = await gate.check({ type: "bash", cmd: "ls" });
console.log(`turns=${gate.limits.turns} → outcome=${turnsDec.outcome} severity=${turnsDec.severity} rule=${turnsDec.rule}`);
console.log(turnsDec.severity === "halt" && turnsDec.rule === "limits.maxTurns" ? "PASS" : "FAIL");

// terminate
console.log("\n=== terminate ===");
const t = await gate.terminate("operator chose terminate");
console.log("terminate result:", JSON.stringify(t));
const afterTerm = await gate.check({ type: "bash", cmd: "ls" });
console.log(`after terminate → outcome=${afterTerm.outcome} severity=${afterTerm.severity} rule=${afterTerm.rule}`);
console.log(afterTerm.severity === "halt" && afterTerm.rule === "gate.terminated" ? "PASS" : "FAIL");

// rebuild budget from audit log (simulate fresh process)
console.log("\n=== rebuild budget from audit (sim fresh process) ===");
await fsp.unlink(budgetPath).catch(() => {});
const gate2 = new Gate({ runId, auditPath, budget: { maxCostUsd: 0.10, maxTokens: 1000, sharedFile: budgetPath } });
await gate2.init();
const expectedSpent = 0.15 + 4 * 0.01;
const spent = gate2.budget.spentUsd;
console.log(`reconstructed spent=$${spent.toFixed(4)}, expected=$${expectedSpent.toFixed(4)} (cap rebuilt: $${gate2.budget.capUsd})`);
console.log(Math.abs(spent - expectedSpent) < 1e-9 && gate2.budget.capUsd === 1.00 ? "PASS" : "FAIL");

// gate.allows() pure-query semantics
console.log("\n=== gate.allows() ===");
const gate3 = new Gate({
  runId: randomUUID(),
  auditPath: path.join(tmp, `bareguard-poc-allows-${randomUUID()}.jsonl`),
  tools: { allowlist: ["bash", "fetch"] },
});
await gate3.init();
const sizeBefore = (await fsp.readFile(gate3.auditPath, "utf8")).length;
const a1 = await gate3.allows({ type: "bash", cmd: "git x" });           // allow → true
const a2 = await gate3.allows({ type: "mcp:foo/x" });                    // not in allowlist → false
const a3 = await gate3.allows({ type: "fetch", url: "https://x.com/delete" }); // ask → true
const sizeAfter = (await fsp.readFile(gate3.auditPath, "utf8")).length;
console.log(`bash allow → ${a1}, not-listed → ${a2}, ask → ${a3}, audit-bytes: before=${sizeBefore}, after=${sizeAfter}`);
console.log(a1 === true && a2 === false && a3 === true && sizeBefore === sizeAfter ? "PASS" : "FAIL");

// final dump of audit log paths
console.log("\n=== artifacts ===");
console.log(`audit:  ${auditPath}`);
console.log(`budget: ${budgetPath}`);
const finalSize = (await fsp.readFile(auditPath, "utf8")).split("\n").filter(Boolean).length;
console.log(`audit lines: ${finalSize}`);
