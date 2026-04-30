# bareguard

Action-side runtime policy library for autonomous agents. Bounds what the
agent **does**, not what it **says**.

> Sibling of [`bareagent`](https://github.com/hamr0/bareagent) in the bare
> suite. bareagent runs the agent loop; bareguard is the single chokepoint
> every action passes through.

**Status:** v0.1.0-pre — implementation complete, pre-publish. Tests pass on
Linux + macOS. Windows works with a lock fallback (no O_APPEND atomicity).

## What it is

- A **policy library** with one class (`Gate`), three call sites (`redact`,
  `check`, `record`), and one allowed dep (`proper-lockfile`).
- An **action-side guard** — bash, fs, net, MCP invocation, child spawn,
  budget consumption.
- A **structured audit producer** — every gated event is one JSONL line in
  one file across the whole agent family (parent + children + grandchildren).
- A **library**, not a service. No daemon, no telemetry, no SaaS.

## What it isn't

- Not a content guardrail (use `guardrails-ai` for toxicity/PII/schema).
- Not a sandbox (use Docker/gVisor for containment).
- Not an authn/authz layer (caller's concern; pass a different `Gate` per user).
- Not a scheduler (cron + bareagent's `defer` tool handles that).

See `docs/non-roadmap.md` for the full NO-GO list.

## Install

```bash
npm install bareguard
```

Requires Node 20 LTS or higher.

## Quickstart

```js
import { Gate } from "bareguard";

const gate = new Gate({
  // Capability scope — only listed tools can be invoked at all.
  tools: { allowlist: ["bash", "read", "write", "fetch"] },

  // Per-tool deny rules.
  bash:  { allow: ["git", "ls", "cat"], denyPatterns: [/sudo/, /rm\s+-rf/] },
  fs:    { writeScope: ["/tmp/agent"], readScope: ["/tmp"], deny: ["~/.ssh", "/etc/passwd"] },
  net:   { allowDomains: ["api.example.com"], denyPrivateIps: true },

  // Hard caps that halt the run (escalate to human).
  budget: { maxCostUsd: 5.00, maxTokens: 100_000, sharedFile: "./.bareguard-budget.json" },
  limits: { maxTurns: 50, maxChildren: 4, maxDepth: 3 },

  // Secrets that should be redacted from actions before audit.
  secrets: {
    envVars:  ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    patterns: [/sk-[A-Za-z0-9]{40,}/],
  },

  // ONE callback bareguard calls whenever a human is needed.
  // Bareguard does NOT know what's behind it — TUI, Slack, web, PIN, all caller's choice.
  humanChannel: async (event) => {
    // event.kind:    "ask" | "halt"
    // event.action:  redacted action (null on halt)
    // event.severity: "action" | "halt"
    // event.rule:    e.g., "content.askPatterns" | "budget.maxCostUsd"
    // event.reason:  human-readable
    // event.context: deterministic stats (spend, turns, rate)
    console.log(`[HUMAN] ${event.kind}: ${event.rule} — ${event.reason}`);
    return { decision: "allow" };  // or "deny" / "topup" / "terminate"
  },
});

await gate.init();

// In your agent loop:
const action = { type: "bash", cmd: "git status" };
const decision = await gate.check(gate.redact(action));
if (decision.outcome === "allow") {
  const result = await yourExecutor(action);
  await gate.record(action, result);  // result.costUsd, result.tokens
} else {
  // decision.outcome is "deny" — return decision.error to your LLM
  // bareguard never returns "askHuman" to you; it resolves that internally
  // via humanChannel and gives you a terminal allow/deny.
}
```

## The eval order (PRD v0.5 §3)

`gate.check(action)` runs:

```
PRE-EVAL
  - secrets.redact(action) (mutates input only; not a decision step)
  - budget.check       — halt if exceeded
  - limits.maxTurns    — halt if exceeded

THE 6 STEPS (first match wins)
  1. tools.denylist    → deny
  2. content.denyPatterns       → deny  (universal, e.g., DROP TABLE)
  3. per-action-type rules      → deny  (bash/fs/net/limits.spawn/denyArgs)
  4. content.askPatterns        → askHuman (universal, e.g., delete/revoke)
  5. tools.allowlist enforcement → allow if listed, deny if set+miss
  6. default                    → allow
```

Universal denies first, universal asks second, capability scope third, default
last. **Allowlist does not silence asks** — even an allowlisted tool gets
asked when it matches a destructive content pattern.

## Halt vs deny

Two outcome classes (PRD v0.5 §1, §2):

- **action-severity deny:** structured error returns to the LLM; loop continues.
- **halt-severity:** budget/maxTurns exhaustion. **MUST** escalate to a human
  via `humanChannel`. **Never** bubbles to the LLM as a normal error.

If `humanChannel` is unregistered and the eval halts, `gate.check` returns
`{ outcome: "deny", severity: "halt", reason: "...no humanChannel registered" }`
— the runner terminates cleanly. **Never silently allow.**

## The audit log (one file, all processes)

bareguard writes one JSONL audit file per agent family. Parent + children +
grandchildren all `appendFile` the same path; POSIX `O_APPEND` guarantees
atomicity for writes < 4KB (this is how nginx access logs work).

- Default path: `$XDG_STATE_HOME/bareguard/<root-run-id>.jsonl` (cwd fallback).
- Children inherit via env var `BAREGUARD_AUDIT_PATH` (set by parent's spawn).
- Each line carries `run_id`, `parent_run_id`, `spawn_depth` so the writer is
  identifiable.
- Phase types: `gate`, `record`, `approval`, `halt`, `topup`, `terminate`.
- Reconstruct the family tree with one grep — no multi-file hunting.

## Safe defaults

bareguard ships ~10 lines of regex covering ~90% of dangerous things
agents do. Not a ceiling — users override or extend.

```js
// ALL of these trigger a human prompt (configurable):
bash: "delete a user"
bash: "git force-push"
bash: "TRUNCATE TABLE"

// ALL of these are denied outright:
bash: "rm -rf /"
sql:  "DROP TABLE users"
```

If you find these noisy, narrow them in `content.askPatterns` /
`content.denyPatterns`. If you want zero floor: `content: { askPatterns: [], denyPatterns: [] }`.

## Multi-process / shared budget

Pass `budget.sharedFile` to coordinate one budget cap across a parent + its
children. Coordination is via `proper-lockfile` (the only allowed dep).

```js
// Parent
const gate = new Gate({ budget: { maxCostUsd: 5.00, sharedFile: "/run/agent/budget.json" }});

// Spawn children with this env var so they read from the same file:
//   BAREGUARD_BUDGET_FILE=/run/agent/budget.json
```

Children write to the same audit file via `BAREGUARD_AUDIT_PATH`; their
`parent_run_id` and `spawn_depth` are set via `BAREGUARD_PARENT_RUN_ID` and
`BAREGUARD_SPAWN_DEPTH`. Reconstruction is `grep run_id=...` over one file.

## Public API surface

```js
import { Gate, redact, defaultAuditPath, BudgetUnavailableError,
         SAFE_DEFAULT_DENY_PATTERNS, SAFE_DEFAULT_ASK_PATTERNS } from "bareguard";

// Gate methods (all async unless noted):
gate = new Gate(config)
await gate.init()
gate.redact(action)                              // sync, action-side secrets redaction
await gate.allows(action)                         // pure boolean query (no audit, no budget delta)
await gate.check(action)                          // returns { outcome, severity, rule, reason }
await gate.record(action, result)                 // updates budget + emits record audit line
await gate.run(action, executor)                  // check + execute + record (one call)
await gate.terminate(reason)                      // sticky terminate; subsequent checks deny+halt
await gate.raiseCap(dimension, newCap)            // explicit cap raise (separate from humanChannel topup)
await gate.haltContext()                          // deterministic stats over audit log
```

## Contracts the caller commits to

1. **Call `gate.check` and `gate.record` serially** per `Gate` instance.
   Concurrent calls produce undefined `seq` ordering. Multiple `Gate` instances
   (parent + child processes) MAY run concurrently — they are independent.
2. **Redact tool results before passing to `gate.record`.** bareguard ships
   the `redact()` helper for actions; results follow the same model. Audit
   lines must not contain secrets.
3. **If you wire a `humanChannel`, never return `undefined`.** Return one of:
   `{ decision: "allow" | "deny" | "topup" | "terminate", newCap?, reason? }`.
   Throwing or returning unknown decisions is treated as deny.

## Known limitations (v0.1)

- **Glob:** only `*` is supported (matches anything including `/`). No `?`,
  `[abc]`, or escapes. v0.2 may add `**` if real use exposes pain.
- **Safe-default `askPatterns` may over-match.** `/\b(delete|drop|...)/i`
  fires on innocent strings ("delete-me.txt", URLs containing "delete").
  This is the right v1 trade — over-asking is recoverable; under-asking is
  incidents. Narrow patterns if you find them noisy.
- **Cross-platform:** Linux + macOS are the verified targets. POSIX `O_APPEND`
  atomicity for audit appends is not guaranteed on NFS or Windows; the budget
  file's lock fallback covers Windows but audit on Windows may interleave.
- **Rate limits not in v0.1.** `defer-rate` and `spawn-rate` primitives are
  v0.2; they need bareagent's `defer` and `spawn` tools to be useful and
  those don't exist yet.
- **Soft cap.** Budget can be exceeded by one action's worth of spend before
  next refresh. Acceptable design trade (PRD v0.5 §17). Halt fires reliably
  on the next check after a record.

## Spec

The full design lives in:

- `docs/01-product/bareguard-prd.md` — v0.4 implementation-ready spec
- `docs/01-product/bareguard-prd-v0.5-amendments.md` — v0.5 amendments
- `docs/non-roadmap.md` — the NO-GO list
- `docs/decisions-log.md` — decisions resolved during design

Read the v0.4 PRD first, then the v0.5 amendments. Where they conflict, v0.5
wins.

## License

Apache 2.0. See `LICENSE` and `NOTICE`.
