---
type: reference
title: Relationships
status: stable
sources: [docs/archive/bareguard-prd.md]
---

# Relationships

## Appendix A: relationship to other agent-tooling layers

bareguard sits among five layers of agent-tooling control (bareguard-prd.md:1589-1597):

```
┌─────────────────────────────────────────────────────────────┐
│  System prompt           ← what the model should be like    │
│  guardrails-ai           ← what the model is allowed to say │
│  bareguard               ← what the agent is allowed to do  │
│  Sandbox (Docker/etc.)   ← what the action can affect       │
│  OS perms / SELinux      ← what the process can touch       │
└─────────────────────────────────────────────────────────────┘
```

Five layers. bareguard owns exactly one (bareguard-prd.md:1599).

## Appendix B: relationship inside the bare suite

Inside the bare suite, bareguard is depended on by bareagent (the agent loop
runner), and may also be used directly by any other agent runner
(bareguard-prd.md:1603-1611):

```
        bareagent  ← agent loop runner
            │
            ↓ depends on
        bareguard  ← policy + audit (this doc)
            ↑
            │ may also be used directly by
        any other agent runner
```

bareguard is a leaf dependency. It does not depend on bareagent or any other
suite member (bareguard-prd.md:1613-1614).

## Appendix D: file layout (as shipped in v0.1.1)

The file layout as shipped in v0.1.1 (bareguard-prd.md:1632-1674):

```
bareguard/
├── package.json                  # one prod dep: proper-lockfile
├── README.md
├── CHANGELOG.md
├── bareguard.context.md          # LLM integration guide
├── LICENSE                        # Apache-2.0
├── NOTICE
├── docs/
│   ├── 01-product/
│   │   └── bareguard-prd.md       # this document
│   ├── non-roadmap.md             # §17 NO-GO list verbatim
│   └── decisions-log.md           # §22 decisions log verbatim
├── src/
│   ├── index.js                   # public API
│   ├── gate.js                    # Gate class, full eval flow + humanChannel
│   ├── glob.js                    # *-only globToRegex
│   └── primitives/
│       ├── audit.js               # single-file JSONL with O_APPEND
│       ├── budget.js              # shared file + proper-lockfile + halt
│       ├── secrets.js             # env-var + pattern redaction
│       ├── bash.js                # cmd allow + denyPatterns
│       ├── fs.js                  # writeScope / readScope / deny
│       ├── net.js                 # allowDomains / denyPrivateIps
│       ├── limits.js              # maxTurns (halt) + maxChildren/maxDepth (action)
│       ├── tools.js               # denylist / allowlist (scope) / denyArgPatterns
│       └── content.js             # safe defaults + denyPatterns / askPatterns
├── test/
│   ├── eval-order.test.js
│   ├── safe-defaults.test.js
│   ├── shared-budget.test.js      # subprocesses
│   ├── audit-stitching.test.js    # subprocesses
│   ├── secrets-redaction.test.js
│   ├── halt-flow.test.js
│   ├── integration.test.js
│   ├── _helpers.js
│   └── _worker.mjs
└── .github/
    └── workflows/
        └── test.yml               # matrix: ubuntu/macos/windows × Node 20/22
```
