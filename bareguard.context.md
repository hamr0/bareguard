# bareguard — Integration Guide

> For AI assistants and developers wiring bareguard into a project.
> v0.2.0 | Node.js >= 20 | 1 production dep (`proper-lockfile`) | Apache-2.0
>
> Full design spec: [`docs/01-product/bareguard-prd.md`](docs/01-product/bareguard-prd.md) — unified PRD (v0.6, folds prior v0.5 amendments + v0.1.1 review fixes inline).

## What this is

bareguard is the action-side runtime policy library every agent uses (or
should). One class (`Gate`), three call sites (`redact`, `check`, `record`),
twelve primitives (bash, fs, net, budget, content, secrets, audit, limits,
tools, defer-rate, spawn-rate, approval). Single audit log per
agent family. One `humanChannel` callback for all human escalations.

```
npm install bareguard
```

One entry point:
- `import { Gate, redact, defaultAuditPath, BudgetUnavailableError, SAFE_DEFAULT_DENY_PATTERNS, SAFE_DEFAULT_ASK_PATTERNS, globToRegex, matchAny } from "bareguard"`

## Which primitives do I need?

| I want to... | Use these |
|---|---|
| Gate every action my agent takes | `new Gate({...})` + `await gate.check(action)` before exec, `await gate.record(action, result)` after |
| Stop runaway spend or runaway turns | `budget.maxCostUsd`, `budget.maxTokens`, `limits.maxTurns` — all halt severity |
| Cap concurrent / nested children | `limits.maxChildren`, `limits.maxDepth` — action severity |
| Allowlist commands per-tool | `bash.allow: ["git", "ls"]` |
| Deny destructive command patterns | `bash.denyPatterns: [/sudo/, /rm\s+-rf/]` |
| Restrict file paths the agent can read/write | `fs.readScope`, `fs.writeScope`, `fs.deny` |
| Egress allowlist / private-IP block | `net.allowDomains`, `net.denyPrivateIps: true` |
| Share budget across parent + child processes | `budget.sharedFile: "/path/budget.json"` (uses `proper-lockfile`) |
| Reconstruct family tree from audit | one file at `$XDG_STATE_HOME/bareguard/<root-run-id>.jsonl`; grep `parent_run_id` |
| Redact API keys from actions before audit | `secrets.envVars: ["ANTHROPIC_API_KEY"]`, `secrets.patterns: [/sk-[A-Za-z0-9]{40,}/]` |
| Ask the human before destructive verbs | safe-default `content.askPatterns` ship; provide `humanChannel` callback |
| Pre-filter MCP catalog by what the agent CAN call | `await gate.allows(action)` — pure boolean, no audit, no budget delta |
| One-shot wrapper: check + execute + record | `await gate.run(action, executor)` |
| Stop the run cleanly with a paper trail | `await gate.terminate(reason)` |
| Get deterministic stats at halt time | `await gate.haltContext()` — spend, turns, rate over audit log |

**Most projects start with `Gate({ tools, budget, limits, humanChannel })`.** Add primitives as needed.

## Minimal wiring

```javascript
import { Gate } from "bareguard";

const gate = new Gate({
  tools: { allowlist: ["bash", "read", "fetch"] },
  bash:  { allow: ["git", "ls"], denyPatterns: [/sudo/, /rm\s+-rf/] },
  budget: { maxCostUsd: 5.00, maxTokens: 100_000 },
  humanChannel: async (event) => {
    // Your UX: TUI, Slack, web button, PIN — bareguard knows none of it.
    return { decision: "allow" };
  },
});
await gate.init();

// In your agent loop:
const action = { type: "bash", cmd: "git status" };
const decision = await gate.check(gate.redact(action));
if (decision.outcome === "allow") {
  const result = await yourExecutor(action);                // your code
  await gate.record(action, result);                        // budget + audit
}
// decision.outcome is always "allow" or "deny" — never "askHuman".
// bareguard resolves askHuman internally via humanChannel.
```

## Wiring with humanChannel (the most important section)

bareguard collapses every human escalation into ONE callback. You register it;
bareguard calls it whenever a content `askPattern` matches OR a halt-severity
limit is hit. The runner only ever branches on terminal `allow` / `deny`.

```javascript
const gate = new Gate({
  // ...
  humanChannel: async (event) => {
    // event.kind:    "ask" | "halt"
    // event.action:  redacted action (null when kind === "halt")
    // event.severity: "action" | "halt"
    // event.rule:    e.g., "content.askPatterns" | "budget.maxCostUsd"
    // event.reason:  human-readable
    // event.context: deterministic stats (spend, turns, rate, time-elapsed)

    if (event.kind === "halt") {
      // Run-level pause. Your UX should be loud and blocking.
      // Show event.context (spend, rate, last 5 ticks) so the human can decide.
      const choice = await loudPrompt(event);
      if (choice === "topup")    return { decision: "topup", newCap: 10.00 };
      if (choice === "terminate") return { decision: "terminate", reason: "operator stopped" };
      return { decision: "deny" };
    }

    // event.kind === "ask" — per-action confirmation
    const ok = await inlinePrompt(event);
    return { decision: ok ? "allow" : "deny" };
  },
});
```

**What bareguard does with each return value:**

- `{ decision: "allow" }` — emit `phase:"approval"` audit line, gate.check returns terminal `allow`.
- `{ decision: "deny", reason }` — emit `phase:"approval"`, gate.check returns terminal `deny` (severity preserved from original ask/halt).
- `{ decision: "topup", newCap, reason }` — only meaningful for halt. raises the cap atomically, emits `phase:"topup"`, **re-evaluates gate.check**. If still halts after re-eval, calls humanChannel again (capped at 5 iterations to prevent loops).
- `{ decision: "terminate", reason }` — emit `phase:"approval"` + `phase:"terminate"`, gate becomes sticky-terminated, every subsequent check returns deny.

**If `humanChannel` is not registered** and the eval reaches askHuman/halt: gate.check returns `{ outcome: "deny", severity: "halt", rule: "...originalRule...", reason: "...originalReason... (no humanChannel registered)" }`. Never silently allow.

**Optional `humanChannelTimeoutMs`** (default: unset = wait forever). If set, bareguard races your channel against a timer; if the timer wins, gate.check returns `{ outcome: "deny", severity: "halt", rule, reason: "humanChannel timeout after Xms" }` and emits a `phase:"approval"` audit line with the timeout reason. The timeout always denies — there is no "allow on timeout". If you want allow-on-timeout for an autonomous fleet, implement it inside your own `humanChannel` (return `{ decision: "allow" }` after your own setTimeout) so the policy is explicit in user code, not a bareguard default. The pending channel promise is not cancelled; if it later resolves, the result is dropped (the agent will re-prompt on the next gate.check).

## Wiring shared budget across processes

Parent and children share one budget file via `proper-lockfile`.

```javascript
// Parent
const gate = new Gate({
  budget: { maxCostUsd: 5.00, sharedFile: "/run/agent/budget.json" },
  limits: { maxChildren: 4, maxDepth: 3 },
  humanChannel: parentHumanChannel,
});

// When parent spawns a child, set env vars:
const child = spawn("node", ["worker.js"], {
  env: {
    ...process.env,
    BAREGUARD_BUDGET_FILE: "/run/agent/budget.json",
    BAREGUARD_AUDIT_PATH:  gate.audit.filePath,        // ONE audit file for the whole family
    BAREGUARD_PARENT_RUN_ID: gate.runId,
    BAREGUARD_SPAWN_DEPTH:   String(gate.spawnDepth + 1),
  },
});

// Child code (worker.js):
const childGate = new Gate({
  budget: { /* cap inherited from shared file */ },
  // path / parent_run_id / spawn_depth all picked up from env vars automatically
});
await childGate.init();
```

The child writes to the same audit file via `O_APPEND` atomicity (POSIX
guarantees < 4KB; Windows uses lock fallback automatically). Reconstruct the
family tree with one grep:

```bash
grep '"parent_run_id":"<parent-run-id>"' run.jsonl
```

## Wiring secrets redaction

Caller is responsible for redacting **results** before `gate.record(action, result)`.
bareguard's `redact()` helper handles both actions and results.

```javascript
import { redact } from "bareguard";

const cfg = {
  envVars:  ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN"],
  patterns: [/sk-[A-Za-z0-9]{40,}/, /ghp_[A-Za-z0-9]{36}/],
};

// Action-side: gate.redact() uses cfg from gate config
const cleanAction = gate.redact(rawAction);

// Result-side: redact yourself before record
const result = await yourExecutor(action);
const cleanResult = redact(result, cfg);
await gate.record(cleanAction, cleanResult);
```

Format: `[REDACTED:ANTHROPIC_API_KEY]` for env-var matches, `[REDACTED:pattern=sk-...]` for unknown-source pattern matches. **Never** shows full secrets, **never** shows the suffix.

## Eval order in detail

```
PRE-EVAL (cross-cutting, all halt severity)
  P0. secrets.redact(action)        ← mutation, not a decision step
  P1. budget.check()                ← halt if exceeded
  P2. limits.maxTurns               ← halt if exceeded
  P3. gate.terminated check         ← halt if previously terminated

THE 6 STEPS (first match wins; all action severity unless noted)
  1. tools.denylist                 → deny
  2. content.denyPatterns           → deny  (universal, e.g., DROP TABLE)
  3. per-action-type deny rules     → deny
        bash.denyPatterns / bash.allow (when action.type === "bash")
        fs.deny / fs.readScope / fs.writeScope (when read/write/edit)
        net.allowDomains / net.denyPrivateIps (when fetch)
        limits.maxChildren / limits.maxDepth (when spawn)
        tools.denyArgPatterns (any tool with matching args)
  4. content.askPatterns            → askHuman  (fires even on allowlisted tools)
  5. tools.allowlist enforcement    → set+match: allow; set+miss: deny (rule: tools.allowlist.exclusive)
  6. default                        → allow
```

Universal denies first (1-2-3), universal asks second (4), capability scope third (5), default last (6). Allowlist is **scope-only** — does not silence asks (this is a v0.5 amendment to v0.4's original spec).

## Halt vs deny

| Scenario | Severity | What the runner does |
|---|---|---|
| `tools.denylist` match | action | return error to LLM, continue loop |
| `content.denyPatterns` match (e.g., `DROP TABLE`) | action | return error to LLM, continue loop |
| `bash.denyPatterns` (e.g., `sudo`) | action | return error to LLM, continue loop |
| `fs.deny`, `fs.readScope`, `fs.writeScope` | action | return error to LLM, continue loop |
| `net.allowDomains`, `net.denyPrivateIps` | action | return error to LLM, continue loop |
| `tools.allowlist.exclusive` (not in scope) | action | return error to LLM, continue loop |
| `tools.denyArgPatterns` | action | return error to LLM, continue loop |
| `limits.maxChildren`, `limits.maxDepth` | action | return error to LLM, continue loop |
| `content.askPatterns` (after humanChannel resolves) | action | terminal allow or deny |
| **`budget.maxCostUsd`, `budget.maxTokens`** | **halt** | **escalate to humanChannel; never bubble to LLM** |
| **`limits.maxTurns`** | **halt** | **escalate to humanChannel; never bubble to LLM** |
| **`gate.terminated`** (after previous terminate) | **halt** | **all subsequent checks deny+halt; agent loop exits cleanly** |

**Action severity:** the LLM sees a structured error and can adapt (try a different tool, ask the user, give up gracefully).

**Halt severity:** the run is over unless a human approves a topup. The LLM **must not** see this — it would loop trying to retry. bareguard handles this by calling humanChannel internally and only returning terminal allow/deny to the runner.

## Public API surface

```javascript
import {
  Gate,                           // the orchestrator
  redact,                         // standalone redaction helper
  defaultAuditPath,               // path resolver matching the env-var convention
  BudgetUnavailableError,         // thrown on lock failure / corrupt budget file
  SAFE_DEFAULT_DENY_PATTERNS,     // exposed in case you want to extend
  SAFE_DEFAULT_ASK_PATTERNS,      // exposed in case you want to extend
  globToRegex, matchAny,          // glob helpers (v0.1: `*` only)
} from "bareguard";

// Gate methods (all async unless noted):
const gate = new Gate(config);
await gate.init();                                // creates audit file, reads/writes shared budget
gate.redact(action);                              // SYNC — pre-eval secrets redaction
await gate.check(action);                         // returns { outcome, severity, rule, reason }
await gate.allows(action);                        // pure boolean — no audit, no budget delta
await gate.record(action, result);                // updates budget + emits record audit line
await gate.run(action, executor);                 // check + execute + record (one call)
await gate.terminate(reason);                     // sticky terminate
await gate.raiseCap(dimension, newCap);           // explicit cap raise (separate from humanChannel topup)
await gate.haltContext();                         // deterministic stats over audit log
```

## Audit log format

One JSONL file. Default path: `$XDG_STATE_HOME/bareguard/<root-run-id>.jsonl`. Override via `audit.path` in config or `BAREGUARD_AUDIT_PATH` env var.

**Phases:**

| `phase` | When | Key extra fields |
|---|---|---|
| `gate` | every `gate.check()` decision | `action`, `decision`, `severity`, `rule`, `reason` |
| `record` | every `gate.record()` | `action`, `result` (incl. `costUsd`, `tokens`) |
| `approval` | humanChannel returned a decision | `decision`, `reason`, `newCap` |
| `halt` | dedicated grep target on halt | `dimension` (`costUsd`/`tokens`/`turns`), `spent`, `cap`, `rule`, `awaiting` |
| `topup` | runner / humanChannel raised a cap | `dimension`, `oldCap`, `newCap` |
| `terminate` | gate terminated (graceful) | `reason` |

Every line carries: `ts`, `seq`, `run_id`, `parent_run_id`, `spawn_depth`. Use `parent_run_id` to reconstruct the family tree.

```bash
# What stopped the run last night?
grep '"phase":"halt"' run.jsonl | jq

# Spend total
jq 'select(.phase=="record") | .result.costUsd' run.jsonl | paste -sd+ | bc

# Just child runs
jq 'select(.spawn_depth >= 1)' run.jsonl
```

## Key contracts

- **Serial calls per Gate instance.** `gate.check` and `gate.record` MUST be called serially per `Gate`. Concurrent calls produce undefined `seq` ordering. Multiple Gate instances (parent + child processes) MAY run concurrently — they're independent.
- **Caller redacts results.** bareguard auto-redacts actions if `secrets` config is provided; results are the caller's responsibility before `gate.record`.
- **`humanChannel` returns a structured decision.** `{ decision: "allow" | "deny" | "topup" | "terminate", newCap?, reason? }`. Never `undefined`. Throwing or returning unknown decisions is treated as deny.
- **No `gate.checkBatch` in v0.1.** If a runner needs concurrent action evaluation, that's v0.2.
- **bareguard never invokes I/O on its own.** It calls a function YOU registered (`humanChannel`, `executor` in `gate.run`). All TUIs, prompts, and PINs are runner-side.

## Patterns, not features

These are deliberately NOT in bareguard. Don't look for them — build them or use a different layer.

| Pattern | Not built in because | How to do it |
|---|---|---|
| **Content guardrails** (toxicity, PII, schema) | Different layer — model output, not action | `guardrails-ai` for content; bareguard for actions. They compose. |
| **Sandboxing** (containment of effects) | Different layer — bareguard prevents calls; sandbox contains effects | Docker / gVisor / Firecracker. Wrap your executor in a sandbox call. |
| **Identity / authn / authz** | bareguard sees actions, not principals | Pass a different `Gate` instance per user. |
| **PIN / second-factor for approvals** | Authentication is the runner's UX | Implement in `humanChannel`: prompt for PIN before returning `decision`. |
| **Rate limits against external APIs** | The API's job, or a separate rate-limit lib | Wrap the executor; bareguard doesn't know about external services. |
| **Scheduler / daemon** | bareguard is a library, not a service | bareagent's `defer` tool + cron + a `wake.sh` script. |
| **Telemetry / SaaS / dashboards** | Bare-suite philosophy | JSONL is grep-able. Pipe it to whatever you want — Datadog, Loki, S3 are caller's adapters. |
| **Per-tool ask-patterns** | Use `tools.denyArgPatterns` for tool-specific rules; ask is universal | If you really need a per-tool ask, narrow `content.askPatterns` to match the tool name + the dangerous arg. |

## Gotchas

1. **Allowlist does NOT silence asks.** Allowlisting `bash` does not bypass `content.askPatterns: [/\bdelete\b/i]`. A `delete` in the bash command still triggers humanChannel. This is intentional (v0.5 §4) — the v0.4 short-circuit was a foot-gun that silently disabled safe defaults. To silence, narrow `content.askPatterns`.
2. **Budget caps are SOFT.** Cross-process budget can be exceeded by one action's spend before next refresh. Halt fires reliably on the next check after a record. Don't rely on hard cents-precision enforcement.
3. **Audit line size capped at 3.5KB.** POSIX `O_APPEND` atomicity requires < PIPE_BUF (4KB). Larger `action.args` are auto-truncated with `[TRUNCATED:...]` markers. Don't put 10MB blobs in your action.
4. **Glob is `*`-only in v0.1.** No `?`, no `[abc]`, no escapes. `mcp:*/admin_*` matches anything in the middle, including `/`. v0.2 may add `**`.
5. **Secrets redaction needs values ≥ 8 chars.** Short env vars (e.g., `PORT=5432`) are not redacted because they're likely not secrets and would over-match.
6. **`gate.allows()` returns true for askHuman.** Catalog pre-filters should show ask-gated tools so the LLM can attempt them and the human gets the prompt at invoke time.
7. **`gate.run(action, executor)` returns the executor's result on allow, OR `{ error: { type: "policy_denied", rule, reason, action_summary } }` on deny.** Doesn't throw. Halt severity inside `run` returns the same error shape with `severity: "halt"`.
8. **Topup loop max 5 iterations.** If humanChannel returns topup but the new cap still halts, bareguard re-calls humanChannel up to 5 times before forcing a deny+halt with reason `"topup loop exceeded 5 iterations"`. Defensive guard against runaway humans.
9. **Children inherit the audit file via env, not config.** Set `BAREGUARD_AUDIT_PATH` (and `BAREGUARD_BUDGET_FILE`, `BAREGUARD_PARENT_RUN_ID`, `BAREGUARD_SPAWN_DEPTH`) when spawning. The child's `new Gate({})` picks them up automatically.
10. **`gate.terminate()` is sticky.** Once called, every subsequent `gate.check` returns deny+halt with `rule: "gate.terminated"`. Your runner's loop should exit cleanly on this rule.
11. **Windows uses a lock fallback for audit.** `process.platform === "win32"` triggers `proper-lockfile` around audit appends. Slower than the POSIX `O_APPEND` fast path but correct.

## Recipes

### Recipe 1: Wrap an existing executor with `gate.run`

```javascript
const result = await gate.run(action, async (action) => {
  return await yourExecutor(action);
});
// result is either the executor's return OR { error: { type: "policy_denied", ... } } on deny.
```

### Recipe 2: Catalog pre-filter via `gate.allows`

```javascript
import { Gate } from "bareguard";

const gate = new Gate({
  tools: { allowlist: ["bash", "fetch", "mcp:linear.app/*"] },
});
await gate.init();

const catalog = await mcpServer.listTools();   // your code
const visible = [];
for (const t of catalog) {
  if (await gate.allows({ type: t.name, args: t.exampleArgs })) {
    visible.push(t);
  }
}
// `visible` excludes tools that would be denied. Tools that would ASK
// the human at invoke time STAY visible — the human is in the loop later.
```

### Recipe 3: Multi-process spawn with shared budget

```javascript
// parent.js
import { Gate } from "bareguard";
import { spawn } from "node:child_process";

const gate = new Gate({
  budget: { maxCostUsd: 5.00, sharedFile: "/run/agent/budget.json" },
  limits: { maxChildren: 4, maxDepth: 3 },
  humanChannel: async (event) => { /* loud prompt */ },
});
await gate.init();

const decision = await gate.check({ type: "spawn", config: "child" });
if (decision.outcome === "allow") {
  const child = spawn("node", ["child.js"], {
    env: {
      ...process.env,
      BAREGUARD_BUDGET_FILE: gate.budget.sharedFile,
      BAREGUARD_AUDIT_PATH:  gate.audit.filePath,
      BAREGUARD_PARENT_RUN_ID: gate.runId,
      BAREGUARD_SPAWN_DEPTH:  String(gate.spawnDepth + 1),
    },
  });
  await gate.record({ type: "spawn", config: "child" }, { child_run_id: child.pid, costUsd: 0 });
}
```

### Recipe 4: humanChannel via terminal readline

```javascript
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

const gate = new Gate({
  humanChannel: async (event) => {
    if (event.kind === "halt") {
      console.log(`\n[HALT] ${event.rule}: ${event.reason}`);
      console.log(`Spent: $${event.context.spent.costUsd.toFixed(4)} of $${event.context.cap.costUsd}`);
      console.log(`Last 5 ticks: ${event.context.spendRate.last5.map(x => x.toFixed(4)).join(", ")}`);
      const choice = await ask("(a)llow more — by how much? (t)erminate / (d)eny: ");
      if (choice.startsWith("t")) return { decision: "terminate", reason: "operator stopped" };
      if (choice.startsWith("d")) return { decision: "deny" };
      const amt = parseFloat(await ask("New cap (USD): "));
      return { decision: "topup", newCap: amt, reason: "operator approved topup" };
    }
    // event.kind === "ask"
    console.log(`\n[ASK] ${event.rule}: ${event.reason}`);
    console.log(`Action: ${JSON.stringify(event.action).slice(0, 200)}`);
    const ok = (await ask("Allow? (y/N): ")).toLowerCase().startsWith("y");
    return { decision: ok ? "allow" : "deny" };
  },
});
```

### Recipe 5: humanChannel via Slack reaction

```javascript
const gate = new Gate({
  humanChannel: async (event) => {
    const msg = await slack.chat.postMessage({
      channel: "#approvals",
      text: `*${event.kind.toUpperCase()}*: ${event.rule}\nReason: ${event.reason}\n\`\`\`${JSON.stringify(event.action || event.context, null, 2).slice(0, 1500)}\`\`\``,
    });
    await slack.reactions.add({ channel: msg.channel, timestamp: msg.ts, name: "white_check_mark" });
    await slack.reactions.add({ channel: msg.channel, timestamp: msg.ts, name: "x" });
    // poll for which reaction the operator added (or wait for events API)
    const choice = await waitForReaction(msg, ["white_check_mark", "x"], 300_000);
    if (!choice)                       return { decision: "deny", reason: "approval timed out" };
    if (choice === "x")                return { decision: "deny" };
    if (event.kind === "halt")         return { decision: "topup", newCap: event.context.cap.costUsd * 2 };
    return { decision: "allow" };
  },
});
```

### Recipe 6: humanChannel with PIN verification

```javascript
const gate = new Gate({
  humanChannel: async (event) => {
    const pin = await promptPin();
    if (!verifyPin(pin)) return { decision: "deny", reason: "PIN mismatch" };
    if (event.kind === "halt") return { decision: "topup", newCap: event.context.cap.costUsd + 5 };
    return { decision: "allow" };
  },
});
// PIN is bareguard's NO-GO list — authentication is YOUR layer. The recipe
// shows how to wire a PIN-checking runner; bareguard never sees the PIN.
```

### Recipe 7: Per-tool denyArgPatterns for an MCP tool

```javascript
const gate = new Gate({
  tools: {
    allowlist: ["mcp:linear.app/*"],
    denyArgPatterns: {
      "mcp:linear.app/update_issue": [/priority.*critical/i],
      "mcp:linear.app/delete_comment": [/.*/],   // never allow this one
    },
  },
});
// Even though Linear is allowlisted broadly, specific dangerous shapes are denied.
```

### Recipe 8: bareguard + bareagent + beeperbox (50+ messengers)

```javascript
import { Gate } from "bareguard";
import { Loop, createMCPBridge } from "bare-agent";

const gate = new Gate({
  tools: {
    allowlist: ["mcp:beeperbox/*"],
    denylist:  ["mcp:beeperbox/delete_*"],         // belt and suspenders
    denyArgPatterns: {
      "mcp:beeperbox/send_message": [/"chat_id":\s*"finance"/],   // no automated messages to finance team
    },
  },
  budget:  { maxCostUsd: 1.00 },                    // small cap — manual approve to extend
  humanChannel: yourSlackOrPinChannel,
});
await gate.init();

const bridge = await createMCPBridge();             // bareagent discovers beeperbox MCP server
const loop = new Loop({
  provider: yourProvider,
  policy:   async (toolName, args) => {
    // bareagent's policy hook → forward to bareguard.gate.check
    const decision = await gate.check({ type: toolName, args });
    return decision.outcome === "allow";
  },
  audit: gate.audit.filePath,                       // share the same JSONL file
});
const result = await loop.run([{ role: "user", content: "Tell mom I'm running late" }], bridge.tools);
```

beeperbox provides `send_message`, `list_chats`, `get_messages`, `mark_as_read` etc. across WhatsApp / iMessage / Signal / Telegram / Slack / Discord / RCS / SMS / and many more — one Docker container, one MCP server, all under one bareguard policy.

### Recipe 9: spawn / defer rate caps

Cap how many `defer` and `spawn` actions can pass through the gate per minute. Counted from the audit log (no separate counter file), per-family (across the spawn tree rooted at the topmost `run_id`).

```javascript
const gate = new Gate({
  defer: { ratePerMinute: 30 },         // default: 15
  spawn: { ratePerMinute: 5 },          // default: 10
  limits: { maxChildren: 8, maxDepth: 3 }, // concurrency caps still apply
  // ...
});

// Eval order is unchanged — defer-rate / spawn-rate sit at step 3 alongside
// bash, fs, net, limits.maxChildren, tools.denyArgPatterns. First match wins.
const dec = await gate.check({ type: "defer", args: { action, when: "1h" } });
// dec.outcome === "deny", dec.rule === "defer.ratePerMinute" if exceeded
```

**Defense in depth on `defer`.** A defer is two distinct `gate.check` calls: the `defer` action at emit (counts toward `defer.ratePerMinute`) and the inner action at fire (counts toward whatever rules apply to its own type). The audit log records both decisions.

**Per-family scope is automatic.** The audit file is keyed by `root_run_id`, and spawned children inherit it via `BAREGUARD_AUDIT_PATH`. Counting that one file = the family's rate. Cross-family runs use different audit files, so they don't see each other's counts.

**See bareagent v0.9.0 for the consumer side.** The `defer` and `spawn` tools that exercise these caps shipped in [bare-agent@0.9.0](https://www.npmjs.com/package/bare-agent), with [`examples/wake.sh`](https://github.com/hamr0/bareagent/blob/main/examples/wake.sh) as the wake-script reference and [`examples/orchestrator/`](https://github.com/hamr0/bareagent/tree/main/examples/orchestrator) showing parent + child agents sharing one rate cap via inherited audit path.

## See also

- [`docs/01-product/bareguard-prd.md`](docs/01-product/bareguard-prd.md) — unified PRD (v0.6).
- [`docs/non-roadmap.md`](docs/non-roadmap.md) — the NO-GO list.
- [`docs/decisions-log.md`](docs/decisions-log.md) — decisions resolved across versions.
- [`CHANGELOG.md`](CHANGELOG.md) — release-by-release diff.
- [bareagent](https://github.com/hamr0/bareagent) — the loop runner that imports bareguard.
- [beeperbox](https://github.com/hamr0/beeperbox) — 50+ messenger reach via MCP.
