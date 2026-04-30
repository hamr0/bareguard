```
  ┌──────────────────────┐
  │   action ─────┐      │
  │               ▼      │
  │  ╭─────────────╮     │
  │  │   ▓ gate ▓  │     │
  │  ╰─────────────╯     │
  │   ╱     │     ╲      │
  │  ✓     ?     ✗       │
  │ allow  ask  deny     │
  └──────────────────────┘

  bareguard
```

> One chokepoint between your agent and the world. Bounds what the agent **does**, not what it **says**.
> Single audit log. Hard caps that halt with a human in the loop. ~930 lines, one production dep.

[![test](https://github.com/hamr0/bareguard/actions/workflows/test.yml/badge.svg)](https://github.com/hamr0/bareguard/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/bareguard.svg)](https://www.npmjs.com/package/bareguard)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

---

## What this is

bareguard is a runtime policy library every agent action passes through. One `Gate` class, three call sites (`redact`, `check`, `record`), twelve primitives — bash, fs, net, budget, content, secrets, audit, limits, tools, defer-rate, spawn-rate, approval. Each primitive is one small file you can read in a sitting.

Same patterns as [bareagent](https://www.npmjs.com/package/bare-agent), [barebrowse](https://www.npmjs.com/package/barebrowse), and [baremobile](https://www.npmjs.com/package/baremobile) — embed it, don't run it. No daemon, no SaaS, no telemetry.

Not a content guardrail (use `guardrails-ai` for toxicity / PII / schema). Not a sandbox (Docker / gVisor for containment). Not authn (caller's concern). Not a scheduler. The five-layer split: system prompt → guardrails-ai → **bareguard** → sandbox → OS perms. bareguard owns exactly one.

## Install

```
npm install bareguard
```

Requires Node.js >= 20. One production dep: `proper-lockfile`.

## Quick start

```js
import { Gate } from "bareguard";

const gate = new Gate({
  tools:  { allowlist: ["bash", "read", "write", "fetch"] },
  bash:   { allow: ["git", "ls"], denyPatterns: [/sudo/, /rm\s+-rf/] },
  fs:     { writeScope: ["/tmp/agent"], readScope: ["/tmp"], deny: ["~/.ssh"] },
  budget: { maxCostUsd: 5.00, maxTokens: 100_000 },
  limits: { maxTurns: 50 },
  humanChannel: async (event) => {
    // event.kind: "ask" | "halt" — your UX decides (TUI, Slack, web, PIN)
    return { decision: "allow" };  // or "deny" / "topup" / "terminate"
  },
});
await gate.init();

// In your agent loop:
const decision = await gate.check(gate.redact(action));
if (decision.outcome === "allow") {
  const result = await yourExecutor(action);
  await gate.record(action, result);  // result.costUsd / result.tokens
}
// gate.check never returns "askHuman" — bareguard resolves that internally
// via humanChannel and gives you a terminal allow/deny.
```

Full integration guide for AI assistants and developers: **[bareguard.context.md](bareguard.context.md)** — covers the `humanChannel` patterns (TUI / Slack / PIN), shared budget across processes, eval order, audit format, gotchas, and 8 recipes including the bareagent + beeperbox wiring.

## How it works

Every action traverses one gate. The eval order is `deny > ask > scope > default`, **first match wins**:

1. `tools.denylist` → deny
2. `content.denyPatterns` → deny (universal — catches `DROP TABLE`, `rm -rf /` on any tool)
3. per-action-type rules → deny (`bash` / `fs` / `net` / `limits.maxChildren` / `tools.denyArgPatterns`)
4. `content.askPatterns` → ask the human (universal — fires even on allowlisted tools)
5. `tools.allowlist` enforcement → allow if listed, deny if set+miss
6. default → allow

Pre-eval halt checks (`budget`, `maxTurns`, `gate.terminated`) run before step 1. Halt-severity events MUST escalate to a human via `humanChannel`; they NEVER bubble to the LLM.

One JSONL audit file per agent family. POSIX `O_APPEND` guarantees atomicity for writes < 4KB — same mechanism nginx access logs use. Parent + children + grandchildren all append the same file; `grep parent_run_id` reconstructs the tree. Windows uses a `proper-lockfile` fallback (auto-detected).

## What's inside

Every primitive is one file (~30–180 LOC).

| Primitive | What it does |
|---|---|
| **bash** | Command allowlist + `denyPatterns` when `action.type === "bash"`. |
| **budget** | Tokens + cost USD, **halt severity** (escalates to human). Shared across processes via `proper-lockfile`. |
| **fs** | `writeScope` / `readScope` / `deny` for `read` / `write` / `edit`. Path prefix matching. |
| **net** | Egress domain allowlist + private-IP deny for `fetch`. |
| **limits** | `maxTurns` (halt), `maxChildren` (action), `maxDepth` (action), `timeoutSeconds` (halt, v0.2). |
| **tools** | Tool-name `allowlist` / `denylist` (glob-matched) + per-tool `denyArgPatterns`. Allowlist is **scope-only** — does not silence asks. |
| **content** | Pattern matches over serialized action. Universal `denyPatterns` (step 2) + `askPatterns` (step 4). **Safe defaults shipped.** |
| **secrets** | Redacts known env-var values + cred patterns. Tags with name (`[REDACTED:ANTHROPIC_API_KEY]`); never leaks. |
| **audit** | One JSONL file per family. Phases: `gate`, `record`, `approval`, `halt`, `topup`, `terminate`. |
| **approval** | Routes ask events to the runner-supplied `humanChannel` callback. |
| **defer-rate** | Caps `defer` actions per minute (default 15). Counted from the audit log; per-family. |
| **spawn-rate** | Caps `spawn` actions per minute (default 10). Composes with `maxChildren` / `maxDepth`. |

**Safe defaults** ship in `content`. `rm -rf /`, `DROP TABLE`, `TRUNCATE` denied outright. Destructive verbs (`delete`, `revoke`, `force-push`, destructive HTTP methods) escalate to the human. Override with empty arrays for pure-allow.

## Common gotchas

The design choices that surprise people most often. Read these before wiring it up.

**1. `tools.allowlist` does NOT silence safe-default `content.askPatterns`.** Allowlist is scope-only ("which tools can be invoked at all"), not a trust shortcut. To silence an ask: narrow `content.askPatterns` or use `tools.denyArgPatterns`.

**2. Glob `*` matches anything including `/`.** `mcp:foo/admin_*` catches `mcp:foo/admin_baz` AND `mcp:foo/admin_baz/sub`. Safe for denylists; **can over-grant on allowlists** — list specific tools or use a tighter prefix. v0.2 may add `**` so `*` becomes "anything except `/`".

**3. `humanChannel` is effectively required for safe-default-shipped configs.** First time an ask fires without one wired, bareguard prints a one-time WARN to stderr and denies with `severity: "halt"`. Headless / CI runs that intentionally have no channel see this once and continue.

**4. Caps are soft, halts are hard.** Cross-process budget can be exceeded by one action's spend before next refresh. Halt fires reliably on the next check after a record.

**5. `gate.check` and `gate.record` MUST be called serially per `Gate` instance.** Multiple Gate instances (parent + child processes) run independently and concurrently fine.

## Tested against

46 tests pass on the CI matrix: **Linux + macOS + Windows × Node 20 + 22**. Real subprocesses verify shared-budget contention under `proper-lockfile`, halt-cascade across processes, single-audit-file atomicity (3 concurrent writers, no torn lines), `parent_run_id` / `spawn_depth` stitching across a 3-deep tree, and `maxChildren` / `maxDepth` enforcement.

## The bare ecosystem

Four vanilla JS modules. Zero deps where possible (bareguard has one). Same API patterns.

| | [**bareagent**](https://npmjs.com/package/bare-agent) | [**barebrowse**](https://npmjs.com/package/barebrowse) | [**baremobile**](https://npmjs.com/package/baremobile) | [**bareguard**](https://npmjs.com/package/bareguard) |
|---|---|---|---|---|
| **Does** | Gives agents a think→act loop | Gives agents a real browser | Gives agents Android + iOS devices | Gates everything an agent does |
| **How** | Goal in → coordinated actions out | URL in → pruned snapshot out | Screen in → pruned snapshot out | Action in → allow / deny / human-asked out |
| **Replaces** | LangChain, CrewAI, AutoGen | Playwright, Selenium, Puppeteer | Appium, Espresso, XCUITest | Hand-rolled allowlists, scattered policy |
| **Interfaces** | Library · CLI · subprocess | Library · CLI · MCP | Library · CLI · MCP | Library |
| **Solo or together** | Orchestrates the others as tools | Works standalone | Works standalone | Embedded in bareagent's loop; usable by any runner |

> **Reach 50+ messengers with one Docker container via [beeperbox](https://github.com/hamr0/beeperbox)** — a headless Beeper Desktop that exposes WhatsApp, iMessage, Signal, Telegram, Slack, Discord, RCS, SMS and more as a single MCP server. Wire it through bareagent's MCP bridge; bareguard policies the invocations like any other tool.

## Spec

- [PRD](docs/01-product/bareguard-prd.md) — unified design spec.
- [non-roadmap](docs/non-roadmap.md) — the NO-GO list.
- [decisions log](docs/decisions-log.md) — design calls resolved across versions.
- [CHANGELOG](CHANGELOG.md) — release-by-release diff.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
