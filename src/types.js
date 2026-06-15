// Central JSDoc type definitions for bareguard's public API.
//
// This file carries no runtime code — it exists only so the type definitions
// have a single home that the rest of the source (and consumers, via the
// generated .d.ts) can reference with `import("./types.js").GateConfig`.
// Field names here mirror exactly what each primitive's constructor / *Check
// function destructures; the CI typecheck (`npm run typecheck`) is what keeps
// the two in sync.

export {};

/**
 * A single agent action passed to the gate. `type` selects which primitives
 * apply; the remaining fields are action-specific. bareguard reads both the
 * flat shape (`action.cmd`, `action.path`, `action.url`) and the nested
 * `wireGate`-style shape (`action.args.cmd` / `.command`, `action.args.path`,
 * `action.args.url`), so either composes without a translation layer.
 *
 * Well-known types: `"bash"` (`cmd`), `"read"` / `"write"` / `"edit"` (`path`),
 * `"fetch"` (`url`), `"llm"` (token/cost-bearing model call — does not tick
 * `maxToolRounds`), `"spawn"` (subagent), `"defer"` (hand-back). Any other
 * string is a custom tool name matched against `tools.allowlist` / `denylist`.
 *
 * @typedef {{ type: string, [key: string]: any }} Action
 */

/**
 * Outcome of executing an action, fed to {@link "./gate.js".Gate#record}.
 * Both fields are optional; absent values count as zero spend.
 *
 * @typedef {object} Result
 * @property {number} [costUsd]  Cost of this action in USD.
 * @property {number} [tokens]   Tokens consumed by this action.
 * @property {Object<string,number>} [counts]  Per-resource deltas accrued against
 *   `budget.resources` caps, e.g. `{ writes: 1, rows: 50 }` (OQ3).
 */

/**
 * Terminal decision returned by `gate.check()`. Never `"askHuman"` — the gate
 * resolves ask/halt internally via `humanChannel` before returning.
 *
 * @typedef {object} Decision
 * @property {"allow"|"deny"} outcome
 * @property {string} severity  `"halt"` denotes a run-level cap (budget /
 *   turns); `"action"` is a per-action rule.
 * @property {string} rule    Rule id that decided this, e.g. `"fs.writeScope"`,
 *   `"budget.maxCostUsd"`, `"default"`, `"humanChannel.allow"`.
 * @property {string|null} reason  Human-readable explanation, or `null`.
 * @property {string} [aid]  Per-eval correlation id (OQ4); pass to `record(action,
 *   result, { aid })` to join the request to its outcome in the audit log.
 */

/**
 * Run-state snapshot attached to every {@link HumanEvent} and returned by
 * `gate.haltContext()`. Lets a `humanChannel` make an informed allow / topup
 * decision.
 *
 * @typedef {object} HaltContext
 * @property {{ costUsd: number, tokens: number }} spent  Totals from the audit log.
 * @property {{ costUsd: number, tokens: number }} cap    Current caps (may be `Infinity`).
 * @property {number} turns          Records seen so far.
 * @property {number} maxTurns       Configured turn cap (may be `Infinity`).
 * @property {number} timeElapsedMs  Wall time between the first and last audit line.
 * @property {{ avgPerTurn: number, last5Avg: number, last5: number[] }} spendRate
 */

/**
 * Event handed to the `humanChannel` callback when an action escalates.
 *
 * @typedef {object} HumanEvent
 * @property {"ask"|"halt"} kind     `"halt"` = a run-level cap was hit; `"ask"`
 *   = a per-action escalation (e.g. a `content.askPatterns` match).
 * @property {Action} action         The action under evaluation.
 * @property {string} severity       `"action"` or `"halt"`.
 * @property {string} rule
 * @property {string|null} reason
 * @property {HaltContext} context
 * @property {Annotation[]} [annotations]  Axis-B facts riding this ask (§6.6);
 *   absent when none buffered or none should surface (so the event is unchanged
 *   for callers that never use `annotate()`).
 */

/**
 * Axis-B annotation fact (§6.6/§8.2) — a caller-computed verdict on whether a
 * returned value honored the user's request. bareguard never computes this (no
 * LLM) and never decides an outcome; it buffers, audits, lets it ride the next
 * human ask, and exposes it for agent feedback via `gate.drainAnnotations()`.
 * `surface` is the one load-bearing field — the caller sets it (e.g. to
 * `verdict !== "honored"`); the rest is carried, not interpreted.
 *
 * @typedef {object} Annotation
 * @property {boolean} surface  true ⇒ the answer did NOT honor the request (show the human).
 * @property {string|null} [verdict]  decisive hint, e.g. `"honored"` | `"broke"` (carried text).
 * @property {string|null} [where]  human-readable description of the mismatch.
 * @property {object|null} [meta]  optional structured detail (e.g. field/stated/returned).
 */

/**
 * `axisB` config — the operator's return-time-judge routing preset (§6.6/§8.2).
 *
 * @typedef {object} AxisBConfig
 * @property {"strict"|"relaxed"} [reversibleEscalation]  The knob; default
 *   `"strict"`. On a reversible action a `broke` fact rides the human ask under
 *   `strict`, or goes to audit + agent-feedback only under `relaxed`. Pure noise
 *   control, never safety (the floor + reversibility own safety).
 * @property {string[]} [reversible]  Action TYPES the operator declares undoable
 *   (e.g. `["recall","search"]`). Reversibility is read off the GATED ACTION's
 *   `type` against this list — never from the fact, the agent, or the model.
 *   Absent / unmatched ⇒ treated as not reversible (safe default).
 */

/**
 * Value a `humanChannel` resolves with. Anything missing / unknown is treated
 * as a defensive deny.
 *
 * @typedef {object} HumanResponse
 * @property {"allow"|"deny"|"topup"|"terminate"} decision  `"topup"` is only
 *   meaningful for halt events and requires a finite `newCap >= 0`.
 * @property {string} [reason]
 * @property {number} [newCap]  New cap for the halted dimension, used with `"topup"`.
 */

/**
 * Callback that routes ask / halt events to a human (TUI, Slack, web, PIN…).
 * @callback HumanChannel
 * @param {HumanEvent} event
 * @returns {Promise<HumanResponse>|HumanResponse}
 */

/**
 * `tools` config — tool-name allowlist / denylist (glob-matched, `*` only) plus
 * per-tool argument deny patterns matched over the serialized action.
 *
 * @typedef {object} ToolsConfig
 * @property {string[]} [allowlist]  Scope-only: set + match → allow, set + miss
 *   → deny. Does not silence asks.
 * @property {string[]} [denylist]
 * @property {Object.<string, RegExp[]>} [denyArgPatterns]  Keyed by tool name.
 */

/**
 * `bash` config — applies when `action.type === "bash"`.
 *
 * @typedef {object} BashConfig
 * @property {string[]} [allow]  Command prefixes. When set, any shell
 *   metacharacter (`; & | < > $ \` ( ) newline`) is denied — a prefix
 *   allowlist can't bound chaining.
 * @property {RegExp[]} [denyPatterns]
 */

/**
 * `fs` config — applies to `read` / `write` / `edit`. Paths are normalized
 * (`.`/`..` collapsed) and segment-boundary matched; symlinks are not resolved.
 *
 * @typedef {object} FsConfig
 * @property {string[]} [writeScope]  Allowed roots for `write` / `edit`.
 * @property {string[]} [readScope]   Allowed roots for `read`.
 * @property {string[]} [deny]        Denied paths/roots (wins over scope).
 */

/**
 * `net` config — applies when `action.type === "fetch"`.
 *
 * @typedef {object} NetConfig
 * @property {string[]} [allowDomains]   Host must equal or be a subdomain of an
 *   entry. This is the fail-closed control — prefer it when egress must be bounded.
 * @property {boolean} [denyPrivateIps]  Deny loopback / private / link-local
 *   (incl. cloud metadata 169.254.169.254), IPv4 and IPv6. Matches the URL's
 *   literal host only — it does NOT resolve DNS, so a hostname whose record
 *   points at a private address is not caught. Defense-in-depth, not an SSRF
 *   boundary; pair with `allowDomains`.
 */

/**
 * `budget` config — token + USD caps, halt severity. Optionally shared across
 * processes via a lock file.
 *
 * @typedef {object} BudgetConfig
 * @property {number} [maxCostUsd]  Default `Infinity`.
 * @property {number} [maxTokens]   Default `Infinity`.
 * @property {Object<string,number>} [resources]  Cap-map for arbitrary countable
 *   resources, `{ <name>: cap }` (e.g. `{ writes: 100, rows: 10000 }`). Accrued
 *   from `result.counts`; same post-fact halt as money (rule `budget.resource.<name>`). (OQ3.)
 * @property {number|null} [softRatio]  Soft-warn threshold in (0,1) (e.g. `0.8`).
 *   Crossing `ratio * cap` on any dimension emits a non-blocking `budget_warn`
 *   audit line — observability only, never halts. Default off. (OQ3.)
 * @property {boolean} [strict]     Pre-flight halt using a trailing-average
 *   projection (needs >=3 samples). Default `false`.
 * @property {string|null} [sharedFile]  Path to the cross-process budget file.
 *   Falls back to `BAREGUARD_BUDGET_FILE`.
 */

/**
 * `limits` config.
 *
 * @typedef {object} LimitsConfig
 * @property {number} [maxTurns]       Halt severity; every `record` ticks.
 * @property {number} [maxToolRounds]  Halt severity; ticks only on non-`llm` records.
 * @property {number} [maxChildren]    Action severity; lifetime total spawns.
 * @property {number} [maxDepth]       Action severity; spawn-tree depth.
 */

/**
 * `content` config — pattern matches over `JSON.stringify(action)`. When
 * omitted, the shipped safe defaults apply; pass `[]` for pure-allow.
 *
 * @typedef {object} ContentConfig
 * @property {RegExp[]} [denyPatterns]  Universal deny (step 2).
 * @property {RegExp[]} [askPatterns]   Universal ask (step 4) — fires even on
 *   allowlisted tools.
 */

/**
 * `flags` config — gate on a named action FIELD's value, read directly off the
 * action (never serialized). Shape: `{ <field>: { <value>: "deny" | "ask" } }`,
 * e.g. `{ provenance: { web: "ask" }, injectionRisk: { high: "deny" } }`.
 *
 * A flag only ever restricts: outcomes are `"deny"` / `"ask"`, never `allow`
 * (allow stays the default fall-through). The deny arm resolves at step 2 and
 * the ask arm at step 4 — both before the allowlist (step 5) — so a flagged
 * action is gated even when its `type` is allowlisted (floor supremacy). An
 * absent field, an unconfigured field, or an unmapped value is a no-op (like
 * `net` / `bash` on a non-matching `type`). Lets a memory adopter pass a
 * structured verdict (`provenance`, `injectionRisk`) without encoding it as
 * matchable text — the field is read directly, not via `JSON.stringify`.
 *
 * @typedef {Object.<string, Object.<string, "deny"|"ask">>} FlagsConfig
 */

/**
 * `secrets` config — when set, the gate auto-redacts `action` / `result` /
 * `reason` on every audit line (eval still sees the real action).
 *
 * @typedef {object} SecretsConfig
 * @property {string[]} [envVars]   Env-var names whose values are redacted.
 *   Values shorter than 8 characters are skipped (to avoid masking incidental
 *   short strings like port numbers), so very short secrets are NOT redacted —
 *   use `patterns` for those.
 * @property {RegExp[]} [patterns]  Credential patterns; forced global at match time.
 */

/**
 * `defer` / `spawn` rate config.
 *
 * @typedef {object} RateConfig
 * @property {number} [ratePerMinute]  Cap per trailing 60s. Defaults: defer 15,
 *   spawn 10. `Infinity` disables.
 */

/**
 * `audit` config.
 *
 * @typedef {object} AuditConfig
 * @property {string|null} [path]  Explicit JSONL path. `null` opts into fileless
 *   in-memory mode (test-only). Omit to use `BAREGUARD_AUDIT_PATH` / the XDG
 *   default.
 */

/**
 * Top-level config passed to `new Gate(config)`. Every field is optional.
 *
 * @typedef {object} GateConfig
 * @property {ToolsConfig} [tools]
 * @property {BashConfig} [bash]
 * @property {FsConfig} [fs]
 * @property {NetConfig} [net]
 * @property {BudgetConfig} [budget]
 * @property {LimitsConfig} [limits]
 * @property {ContentConfig} [content]
 * @property {FlagsConfig} [flags]
 * @property {AxisBConfig} [axisB]  Axis-B return-time-judge routing (§6.6/§8.2).
 * @property {SecretsConfig} [secrets]
 * @property {RateConfig} [defer]
 * @property {RateConfig} [spawn]
 * @property {AuditConfig} [audit]
 * @property {HumanChannel|null} [humanChannel]  Routes ask / halt events. If
 *   absent, ask / halt deny by default (with a one-time stderr warning).
 * @property {number|null} [humanChannelTimeoutMs]  Deny if the channel doesn't
 *   resolve within this many ms.
 * @property {string} [runId]        Defaults to a random UUID.
 * @property {string|null} [parentRunId]  Falls back to `BAREGUARD_PARENT_RUN_ID`.
 * @property {string} [rootRunId]    Falls back to `BAREGUARD_ROOT_RUN_ID` / parent / self.
 * @property {number} [spawnDepth]   Falls back to `BAREGUARD_SPAWN_DEPTH`.
 */

/**
 * Budget dimension that can be raised via `topup` / `raiseCap`: `"costUsd"`,
 * `"tokens"`, or a generic resource name (OQ3).
 * @typedef {"costUsd"|"tokens"|string} BudgetDimension
 */
