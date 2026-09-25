# pico-type — fit assessment for bareagent / bareguard

> **Status: SEED / NOT-NOW.** Evaluation note, no code committed, no backlog item. Same shelf as
> barecontext: an idea parked until a *real adopter* needs secret-redaction **beyond** the deterministic
> pattern floor. bareguard adds detectors on demand, not on interesting tech — there is no adopter ask
> behind this yet. **Date:** 2026-06-29.
>
> **Graduation gate (do not soften):** the spike's pass/fail is **risk-head precision/recall on a real
> secrets/PII corpus at acceptable in-gate latency** — *not* the headline "95.2%," which the README itself
> qualifies as 20/21 hand-curated inputs (the secrets head reports no precision/recall number at all). Build
> the `contentDetector` seam only if measurement shows it beats the static pattern floor on recall without
> wrecking the per-call budget. The seam (any injected detector) is the reusable idea; pico-type is one
> optional impl of it, never a core/required dependency.
>
> **Subject:** [`eulogik/pico-type`](https://github.com/eulogik/pico-type) — a tiny byte-level
> content classifier — and whether it belongs in **bareagent** (the agent orchestration library)
> or **bareguard** (the governance gate).
> **TL;DR:** Best fit is **bareguard, as an optional pluggable detector** (its secrets/risk head is
> exactly a gate's job), **never a core dependency**. bareagent's fit is shallower but available
> **today, with zero new code, via the MCP bridge**.

---

## 1. What pico-type actually is (correct the framing first)

It was described to us as a "regex model." **It is not.** Per its README:

- A **byte-level neural network** (NOT regex, NOT magic-bytes): byte embedding (256→96d) → 3 parallel
  Conv1D → bidirectional self-attention with rotary position embeddings → pooling → 7 classification heads.
- **7 heads in one pass:** coarse type · modality · subtype · code language (62) · text language (30) ·
  MIME type (90) · **risk flags (API keys, passwords, SSH keys, secrets, …)**.
- **~9 MB ONNX model**, ~1.5M params (4 matryoshka tiers), **<6 ms CPU** inference, **95.2%** reported accuracy.
- Python + Rust core. Interfaces: **CLI**, **Python library**, **MCP server**, **browser WASM demo (ONNX Runtime)**.
- **Apache 2.0** (license-compatible with both projects).

Two facts drive everything below:
1. It is a **9 MB model + an inference runtime** — heavier than regex, so it **cannot be a required dependency**
   in either project (both are zero-required-dep, pure-JS).
2. It is **deterministic local inference, no network, no LLM provider** — so using it does **not** violate
   bareguard's "the gate never makes an LLM call / is provider-agnostic" invariant. It behaves like
   "a smarter regex," which is precisely the role the gate already fills with pattern lists.

---

## 2. The fit question, against each project's principles

| Principle | bareagent | bareguard |
|---|---|---|
| Core mission | Orchestrate agents (Loop, Planner, spawn, tools) | **Govern**: policy, budget, audit, **content inspection + redaction** |
| Existing content-inspection surface | none (it's an executor) | **yes** — `redact`, `classifyCommand`, `DESTRUCTIVE_PATTERNS`, deny-pattern lists |
| "Never calls an LLM" constraint | n/a | **holds** (local ONNX inference is not an LLM call) |
| Zero-required-dep | required | required |
| Natural role for a secrets/type classifier | a *tool the agent may call* | a *detector the gate consults to allow/deny/redact* |

**The decisive match is bareguard's risk-flags head.** Detecting credentials (API keys, passwords, SSH keys)
in tool inputs/outputs — to **redact before they reach an audit log**, or **deny a tool call that would
exfiltrate a secret** — is a textbook gate responsibility. bareguard already does a coarse version with
static pattern lists; pico-type is the same job done with ~95% accuracy and MIME/type awareness on top.

---

## 3. Recommendation — by use case

- **Attachment / content *governance*** (block or redact secrets; deny disallowed file types before they
  enter the transcript or the audit log) → **bareguard**, as an **optional, pluggable detector behind a
  seam**. This is the strong fit. The secrets head is the feature that earns it.

- **Attachment / content *routing* by the agent** (the agent detects an attachment's type/modality/secrets
  to decide how to handle it) → **bareagent**, and it works **today with zero new code**: pico-type ships an
  **MCP server**, and `createMCPBridge` auto-discovers MCP servers and exposes them as tools. No integration
  code, no new dependency in bareagent itself.

**Never:** a *required* dependency of either core. The 9 MB model + runtime must stay optional (a peer dep, a
companion package, or an out-of-process MCP/CLI call) to preserve the zero-required-dep guarantee.

---

## 4. Integration sketches (illustrative — not built)

### 4a. bareguard — an optional `contentDetector` seam (the strong fit)

The gate exposes a small interface and stays zero-dep; pico-type is *one* implementation behind it (loaded
via `onnxruntime-node` — the browser WASM demo proves a pure-JS inference path exists, so **no Python is
required**), or the gate shells out to the `picotype` CLI / MCP server out-of-process.

```js
// Shape only — the detector is injected, never bundled.
const gate = new Gate({
  redact: { /* existing static patterns stay as the zero-dep floor */ },
  // NEW optional seam: a detector consulted on tool I/O before audit/return.
  contentDetector: async ({ text }) => {
    const r = await picotype.classify(text);          // local ONNX, ~6ms, no network
    return { secrets: r.risk.secrets, mime: r.mime };  // gate decides: redact / deny / allow
  },
});
```

The gate decides the *policy* (redact vs deny vs allow); pico-type only *detects*. This keeps the
meter→gate→deterministic-decision model intact and adds no LLM call.

### 4b. bareagent — via MCP, today, no code

```js
const { createMCPBridge } = require('bare-agent/mcp');
// pico-type's MCP server is auto-discovered from the IDE/MCP config; its
// classify tool becomes a normal bareagent tool the agent (or a recurse worker) can call.
const { tools } = await createMCPBridge(/* discovers the picotype MCP server */);
```

---

## 5. Caveats & risks (be honest before adopting)

- **Model size / cold start.** 9 MB + an ONNX runtime is real footprint; fine as an optional detector, fatal
  as a core dep. Measure cold-start in the gate's hot path — a gate runs on *every* tool call.
- **Accuracy ≠ guarantee.** 95.2% means ~1-in-20 misclassification. For **secret *detection*** treat it as a
  **recall aid layered on top of** the deterministic pattern floor, never a replacement — a missed key is a
  leak. Compose: static patterns OR pico-type flags → redact (union, fail-safe), never pico-type alone.
- **Language/runtime boundary.** Python+Rust core; the JS path is `onnxruntime-node`/WASM. Validate the JS
  inference path (POC-first) before committing to in-process; otherwise prefer the out-of-process MCP/CLI.
- **Determinism.** Confirm the ONNX model is deterministic across runs/platforms (it should be — fixed weights,
  no sampling) so the gate stays reproducible (RC-3-style).

---

## 5.5 POC findings — the spike was run (2026-06-29). The gate FAILS.

Ran the real `base`-tier ONNX (pulled from HF — see setup notes) against an **independent** corpus the
model's own synthetic generator never produced: real repo files for type, freshly-generated real-format
secrets for keys, benign near-misses as negatives so the test *could* fail. Sigmoid≥0.5 on the risk head
(the architecturally-correct multi-label reading — *more* generous than the shipped CLI, which wrongly
softmaxes risk). Numbers are measured, not quoted.

**Risk head (the feature that was supposed to earn adoption):** independent **recall 0.46, precision 0.86** —
vs the author's synthetic **AP = 1.0**. Root cause, confirmed by a confound check: **pico-type is a
whole-blob classifier, not a span detector.** The *same* `sk_live_…` key scores `api_key 0.96` standalone but
goes **completely silent** (coarse flips to `code`, zero flags) the instant it's line 2 of a 2-line `.env`,
inside a code comment, or past the 1 KB `max_bytes` window. Bare email/phone fire; an email inside a normal
sentence misses. **This is exactly the shape a gate inspects** — a credential is almost always a minority of
the bytes in a tool input/output. The misses are precisely the embedded cases a 5-line regex
(`sk_live_\w+`, `AKIA\w+`, `BEGIN .*PRIVATE KEY`) catches trivially.

**File-type (real repo files):** coarse **5/10** (config/YAML/Markdown/PDF all misread as `code`); `code_lang`
and `file_mime` do **not** generalize off the synthetic set (`.js`→`scss`/`scala`, `.py`→`nim`, `png`→
`application/x-parquet`). The author's synthetic 100% coarse/MIME does not survive contact with real files.

**Latency:** warm **~38 ms single-call** (base tier, onnxruntime, this CPU) — **not** the headline `<6 ms`.
That `5.5 ms` is batch-amortized (eval `batch_size=64`); a gate pays the single-call cost on every tool call.

**Setup reality (worthiness signal in itself):** the PyPI wheel `0.1.9` ships **no weights** (deps are
`torch`+`safetensors`, not `onnxruntime`); weights come only from HF. The import is `model.pico_type`, not the
README's `from picotype import PicoType`, and the CLI softmaxes a multi-label head. The `onnxruntime-node`
JS path was **not** validated (moot given the accuracy result). Untested: the `pro` tier — bigger/slower, and
unlikely to fix a *structural* whole-blob limitation.

## 6. Verdict

**Confirmed SEED / NOT-NOW — do not build the secrets seam.** The doc's original premise ("the secrets head
is the feature that earns it") is **refuted by measurement** on the realistic, embedded case: recall 0.46,
and it misses exactly what the deterministic pattern floor already catches, while adding a 9 MB model + ~38 ms
per gate call. It does **not** beat the floor on recall — it underperforms it where it matters. Compose-as-a-
recall-aid doesn't survive either: the union only helps when the NN catches something patterns miss, and here
the NN's misses are a *superset* of the easy cases.

The separable, lower-stakes path stands unchanged: **type/MIME routing for bareagent via MCP, zero new code**
— but note coarse type is only 5/10 on real files, so even that is "nice-to-have," not load-bearing. For
bareguard's content-inspection surface, the deterministic floor wins; revisit only if a real adopter brings a
secrets-detection need the floor genuinely can't meet **and** pico-type (or a successor) demonstrably clears
the §-banner gate on embedded, real data.
