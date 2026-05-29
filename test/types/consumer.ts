// Consumer-facing type smoke test. NOT run by `node --test` — it exists only to
// be type-checked (`npm run typecheck`), proving the shipped .d.ts resolves
// through the package's `exports.types` mapping and that the public surface is
// correctly typed. Import the package by name (self-reference) exactly as a
// downstream TypeScript consumer would.

import {
  Gate,
  redact,
  globToRegex,
  matchAny,
  defaultAuditPath,
  BudgetUnavailableError,
  SAFE_DEFAULT_DENY_PATTERNS,
  SAFE_DEFAULT_ASK_PATTERNS,
} from "bareguard";
import type {
  GateConfig,
  Action,
  Decision,
  HumanEvent,
  HumanResponse,
  HaltContext,
} from "bareguard/types";

// --- Config is fully typed, including nested sections + humanChannel shape ---
const config: GateConfig = {
  tools: { allowlist: ["bash", "read", "write", "fetch"] },
  bash: { allow: ["git", "ls"], denyPatterns: [/sudo/, /rm\s+-rf/] },
  fs: { writeScope: ["/tmp/agent"], readScope: ["/tmp"], deny: ["~/.ssh"] },
  net: { allowDomains: ["example.com"], denyPrivateIps: true },
  budget: { maxCostUsd: 5.0, maxTokens: 100_000, strict: true },
  limits: { maxTurns: 50, maxToolRounds: 100 },
  content: { denyPatterns: [/DROP TABLE/i], askPatterns: [] },
  secrets: { envVars: ["ANTHROPIC_API_KEY"], patterns: [/sk-[a-z0-9]+/] },
  defer: { ratePerMinute: 15 },
  spawn: { ratePerMinute: 10 },
  humanChannel: async (event: HumanEvent): Promise<HumanResponse> => {
    const _kind: "ask" | "halt" = event.kind;
    const _ctx: HaltContext = event.context;
    void _kind;
    void _ctx;
    return { decision: "allow" };
  },
  humanChannelTimeoutMs: 30_000,
};

async function main(): Promise<void> {
  const gate = new Gate(config);
  await gate.init();

  const action: Action = { type: "bash", cmd: "git status" };

  // check() returns a terminal Decision (never askHuman).
  const decision: Decision = await gate.check(action);
  if (decision.outcome === "allow") {
    await gate.record(action, { costUsd: 0.01, tokens: 1234 });
  }

  // allows() is a boolean query and accepts a tool-name shorthand.
  const ok: boolean = await gate.allows("read");
  void ok;

  // run() returns the executor result or a structured error.
  const result = await gate.run(action, async () => ({ costUsd: 0, tokens: 0 }));
  void result;

  await gate.raiseCap("costUsd", 10);
  const ctx: HaltContext = await gate.haltContext();
  void ctx.spent.costUsd;
  await gate.terminate("done");

  // Re-exported primitives.
  const re: RegExp = globToRegex("a*");
  const m: boolean = matchAny("abc", ["a*"]);
  const p: string = defaultAuditPath("run-1");
  const cleaned = redact({ type: "bash", cmd: "echo $TOKEN" }, { envVars: ["TOKEN"] });
  const denies: RegExp[] = SAFE_DEFAULT_DENY_PATTERNS;
  const asks: RegExp[] = SAFE_DEFAULT_ASK_PATTERNS;
  void re; void m; void p; void cleaned; void denies; void asks;

  try {
    await gate.check(action);
  } catch (err) {
    if (err instanceof BudgetUnavailableError) {
      void err.message;
    }
  }
}

void main;
