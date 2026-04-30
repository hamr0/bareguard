// bareguard POC — phase 1 (PRD §20)
// Goal: single gate with bash + budget + audit, in-memory state, 6-step eval order.
// Anti-goals: no API polish, no error handling, no tests, no docs. CRUDE on purpose.
// Run: node poc/phase1.mjs

import { randomUUID } from "node:crypto";

// ---- glob → regex (the 30-line helper from PRD Appendix D) ------------------
function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + esc + "$");
}
const matchAny = (name, globs) => globs.some(g => globToRegex(g).test(name));

// ---- primitive: bash ---------------------------------------------------------
function bashCheck(action, cfg) {
  if (action.type !== "bash") return null;
  const cmd = action.cmd ?? "";
  if (cfg.denyPatterns?.some(re => re.test(cmd))) {
    return { outcome: "deny", rule: "bash.denyPatterns", reason: "denied pattern" };
  }
  if (cfg.allow && !cfg.allow.some(prefix => cmd.startsWith(prefix))) {
    return { outcome: "deny", rule: "bash.allow", reason: "not in allowlist" };
  }
  return null; // pass through to next layer
}

// ---- primitive: budget (in-memory only for phase 1) -------------------------
class Budget {
  constructor(cfg) {
    this.capUsd = cfg.maxCostUsd ?? Infinity;
    this.capTokens = cfg.maxTokens ?? Infinity;
    this.spentUsd = 0;
    this.spentTokens = 0;
  }
  check() {
    if (this.spentUsd >= this.capUsd) {
      return { outcome: "deny", rule: "budget.maxCostUsd", reason: `spent ${this.spentUsd} >= cap ${this.capUsd}` };
    }
    if (this.spentTokens >= this.capTokens) {
      return { outcome: "deny", rule: "budget.maxTokens", reason: `spent ${this.spentTokens} >= cap ${this.capTokens}` };
    }
    return null;
  }
  record(result) {
    this.spentUsd += result?.costUsd ?? 0;
    this.spentTokens += result?.tokens ?? 0;
  }
}

// ---- primitive: audit (JSONL, in-memory buffer for POC) ---------------------
class Audit {
  constructor(runId) {
    this.runId = runId;
    this.seq = 0;
    this.lines = [];
  }
  emit(phase, action, decision, result) {
    const line = {
      ts: new Date().toISOString(),
      seq: ++this.seq,
      run_id: this.runId,
      parent_run_id: null,
      spawn_depth: 0,
      phase,
      action,
      decision: phase === "gate" ? decision.outcome : null,
      rule: phase === "gate" ? decision.rule : null,
      reason: phase === "gate" ? (decision.reason ?? null) : null,
      result: phase === "record" ? result : null,
    };
    this.lines.push(JSON.stringify(line));
    return line;
  }
}

// ---- the Gate (6-step eval order, PRD §9.1) ---------------------------------
class Gate {
  constructor(cfg) {
    this.cfg = cfg;
    this.budget = new Budget(cfg.budget ?? {});
    this.audit = new Audit(cfg.runId ?? randomUUID());
  }

  // 6-step eval. First terminal wins.
  async check(action) {
    const name = action.type;
    const serialized = JSON.stringify(action);
    const t = this.cfg.tools ?? {};
    const c = this.cfg.content ?? {};

    // 1. tools.denylist match → deny
    if (t.denylist && matchAny(name, t.denylist)) {
      return this._dec("deny", "tools.denylist", `${name} on denylist`, action);
    }
    // 2. content.denyPatterns match → deny
    const denyHit = c.denyPatterns?.find(re => re.test(serialized));
    if (denyHit) {
      return this._dec("deny", "content.denyPatterns", `matched ${denyHit}`, action);
    }
    // bash-specific check (treated as part of layer 2-ish for POC)
    const bashDec = bashCheck(action, this.cfg.bash ?? {});
    if (bashDec) return this._dec(bashDec.outcome, bashDec.rule, bashDec.reason, action);

    // budget gate (cross-cutting; deny if exceeded)
    const budgetDec = this.budget.check();
    if (budgetDec) return this._dec(budgetDec.outcome, budgetDec.rule, budgetDec.reason, action);

    // 3. tools.allowlist match → allow (short-circuits ask)
    if (t.allowlist && matchAny(name, t.allowlist)) {
      return this._dec("allow", "tools.allowlist", null, action);
    }
    // 4. content.askPatterns match → askHuman
    const askHit = c.askPatterns?.find(re => re.test(serialized));
    if (askHit) {
      return this._dec("askHuman", "content.askPatterns", `matched ${askHit}`, action);
    }
    // 5. tools.denyArgPatterns match → deny (after allow short-circuit, so it doesn't fire here in POC)
    //    Phase 1 stub: would run if action passed allowlist but had bad args. Not exercised here.

    // 6. default → allow
    return this._dec("allow", "default", null, action);
  }

  _dec(outcome, rule, reason, action) {
    const decision = { outcome, rule, reason };
    this.audit.emit("gate", action, decision);
    return decision;
  }

  async record(action, result) {
    this.budget.record(result);
    this.audit.emit("record", action, null, result);
  }
}

// ---- driver: exercise the 6 eval outcomes -----------------------------------
const gate = new Gate({
  bash: {
    allow: ["git", "ls", "cat"],
    denyPatterns: [/rm\s+-rf/, /sudo/],
  },
  budget: { maxCostUsd: 0.10, maxTokens: 1000 },
  tools: {
    allowlist: ["bash", "read"],
    denylist: ["mcp:*/admin_*", "mcp:*/delete_*"],
  },
  content: {
    denyPatterns: [/\bDROP\s+TABLE\b/i, /\brm\s+-rf\s+\//],
    askPatterns: [/\b(delete|drop|revoke|truncate)\b/i],
  },
});

const cases = [
  { label: "1. denylist hit",        action: { type: "mcp:foo/admin_revoke", args: {} },          expect: "deny",     expectRule: "tools.denylist" },
  { label: "2. content deny",        action: { type: "bash", cmd: "echo DROP TABLE users" },      expect: "deny",     expectRule: "content.denyPatterns" },
  { label: "2b. bash deny (sudo)",   action: { type: "bash", cmd: "sudo reboot" },                expect: "deny",     expectRule: "bash.denyPatterns" },
  { label: "2c. bash not in allow",  action: { type: "bash", cmd: "curl evil.com" },              expect: "deny",     expectRule: "bash.allow" },
  { label: "3. allowlist hit",       action: { type: "bash", cmd: "git status" },                 expect: "allow",    expectRule: "tools.allowlist" },
  { label: "3b. allow short-circuits ask", action: { type: "bash", cmd: "git revoke-token" },     expect: "allow",    expectRule: "tools.allowlist" },
  { label: "4. ask hit",             action: { type: "fetch", url: "https://api/delete-account" },expect: "askHuman", expectRule: "content.askPatterns" },
  { label: "6. default allow",       action: { type: "fetch", url: "https://api/healthz" },       expect: "allow",    expectRule: "default" },
];

console.log("=== 6-step eval order ===");
let pass = 0, fail = 0;
for (const c of cases) {
  const d = await gate.check(c.action);
  const ok = d.outcome === c.expect && d.rule === c.expectRule;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.label.padEnd(34)} → ${d.outcome.padEnd(9)} (${d.rule})${ok ? "" : `  EXPECTED ${c.expect}/${c.expectRule}`}`);
}
console.log(`\n${pass}/${pass + fail} passed`);

// budget exhaustion
console.log("\n=== budget exhaustion ===");
const exp1 = await gate.check({ type: "bash", cmd: "ls" });
console.log(`pre-spend ls → ${exp1.outcome}`);
await gate.record({ type: "bash", cmd: "ls" }, { costUsd: 0.15, tokens: 50 });
const exp2 = await gate.check({ type: "bash", cmd: "ls" });
console.log(`post-overspend ls → ${exp2.outcome} (${exp2.rule})`);

// audit dump
console.log("\n=== audit log (JSONL) ===");
for (const l of gate.audit.lines) console.log(l);
