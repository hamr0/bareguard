# The Agentic Web: Problem Space Breakdown

> Working note. Where A2A is going, which problems are real vs. solved vs. neglected,
> and where your existing assets (mailproof/DKIM) actually fit.

---

## Context in one line

A2A is becoming the horizontal bus for agent-to-agent communication (150+ orgs,
Linux Foundation, no real competitor after IBM's ACP merged in). The web doesn't
die — it grows a machine-readable face (agent cards at `/.well-known/`, MCP for
tools, A2A for agent↔agent). As that mesh forms, four governance problems surface.
They are **not** equally open. The value is in which one nobody else is solving.

---

## The four problems

### 1. Identity propagation — *who is acting*
- **Status:** Solved, in production. Signed agent cards, scoped OAuth tokens, delegation lineage.
- **Owner:** Enterprise security incumbents (Okta, CyberArk, Strata) + the A2A spec.
- **Open for you?** No. Funded, crowded, buyer is a CISO.

### 2. Traceability / audit — *reconstructing who authorized what, after the fact*
- **Status:** Solved-ish, same stack as #1.
- **Critical fork:** enterprise audit logs *upward* (operator audits user → enables tracking).
  The inverse — **user audits agent, logs stay local** — is unbuilt, because no
  enterprise buyer wants it.
- **Open for you?** Only the inverted, user-sovereign version — and only once you have
  users feeding it.

### 3. Identity-to-human — *binding an agent action to a real authorizing person*
- **Status:** Partial. OAuth/OIDC delegation exists; cross-operator mesh hops
  (user, requesting_agent, receiving_agent, task) still rough; IETF drafts, 12–24 mo to RFC.
- **Regulatory reality (corrected):** law mandates human *oversight* (EU AI Act Art. 14)
  and data *accountability* (GDPR) — **NOT** cryptographic traceability to the individual.
  That leap is the security vendors' sales pitch, not statute.
- **Open for you?** Partly — but it's protocol-standards turf: slow, committee-driven,
  not solo-shaped. **Unless** you shortcut it with already-deployed infra (see DKIM below).

### 4. Intent-integrity — *did the agent do what was MEANT*
- Stayed in scope. Didn't silently change the ask. Didn't take the shortcut that
  technically passes (tests green, root cause untouched).
- **Status: genuinely unsolved.** Standards solve authorization (who + what category),
  not semantic fidelity to intent. Intent is fuzzy, hard to cryptographically bind,
  doesn't fit the token model.
- **Key property:** shortcutting is often **undetectable from output** — tests pass
  either way. Only visible in the *process / reasoning trace*, not the result.
- **Open for you? THIS is the one.** Neglected precisely because it's fuzzy and
  unfundable as a compliance product.

---

## The cross-cutting tension

Traceability and tracking are **the same primitive pointed opposite directions.**

| | Direction | Serves | Example |
|---|---|---|---|
| Enterprise audit | up / outward | operator vs. user | "prove the human behaved" |
| Your inverse | local / inward | user vs. agent | "prove the agent behaved" |

You are not building a smaller CyberArk. You'd be pointing the same gun the other way.
No funded player is incentivized to build the inward-pointing version — which is
exactly why it's open, and why it fits the bare-suite posture.

---

## The actual unsolved core (one line)

> In a delegation mesh, my intent and my constraints degrade with every hop, the
> degradation is invisible from outputs, and the entire funded industry is solving
> *identity* instead of *intent* — pointed at the operator, not at me.

---

## DKIM / mailproof — where it fits

You already built `mailproof` (extracted from `gitdone`): DKIM-verified email as a
proof primitive. DKIM is an internet-wide, already-deployed cryptographic signature
on human-attributable messages (domain signs with private key, verifiable via DNS
public key). No new PKI, no new trust authority, no adoption problem.

**Where it's strong:**
- Aimed squarely at **#3 (identity-to-human)**. A DKIM-signed reply *is* proof a
  specific human at a specific domain assented. Sidesteps the thing that makes #3
  slow — you don't wait for an IETF agent-identity RFC, you reuse infra that's been
  load-bearing since 2004.
- **Best fit: async, cross-operator, non-repudiable receipts** in the mesh. When
  Agent B (different operator) acts on your behalf, a DKIM-signed message is a
  portable, verifiable receipt that survives across trust boundaries with zero new
  infrastructure.

**Where it does NOT fit (the category error to avoid):**
- As a **live in-loop authorization gate** ("agent must email + get DKIM reply
  before important decisions"):
  - Not too slow — too **coarse**. It reinvents human-in-the-loop confirmation with
    extra cryptographic steps nobody's asking to see. You already authorized the
    agent; you're confirming, not proving to a third party.
  - **Points the wrong way again.** DKIM proves *you* assented — upward-pointing
    traceability (#3), serving auditor/operator. It says **nothing** about whether
    the agent then stayed faithful to that assent (#4). You can DKIM-sign
    "book under €300" and the agent still books €450 three hops down.

**Verdict:** mailproof is a real asset for #3 and for mesh-era cross-operator
receipts. It does **not** touch #4 (the neglected core). File it as a primitive you
already hold — not a build to start now.

---

## Honest blockers (why #4 is a *watch*, not a *build* — yet)

- Intent-drift in **meshes** is ~2027 felt-pain. You don't yet make A2A handoffs
  where your policy drops.
- The intent-drift you **do** feel (Claude Code patching over fixes) you already
  handle — better by hand, via your security / code-review / ship routine — than a
  tool would.
- **No external users.** Any detection instrument generates findings with nowhere
  to go. Solo-testing hits diminishing returns; the missing input is one other
  person hitting a bug you'd never hit.

---

## Trigger conditions — what flips #4 from watch to build

Build when **either** is true:

1. You start making real agent-to-agent handoffs where your operator policy
   measurably drops between hops (you feel the degradation yourself), **or**
2. Someone who isn't you reports an intent-drift issue (external pain → the tool
   has someone to serve).

Until then: keep the review/ship routine, don't build more self-surfacing, spend the
freed attention on **getting users** for the bare suite. The next real build signal
won't come from reasoning harder — it'll come from the first person who isn't you.

---

## Asset map (what you already hold against this space)

| Asset | Problem it touches | Now or later |
|---|---|---|
| mailproof (DKIM) | #3 identity-to-human; mesh receipts | primitive on hand |
| weare suite | exposes the upward/tracking surveillance graph | shipping |
| barebrowse | accessibility-tree extraction → agent-legible web | shipping |
| bare suite posture | local-first, zero-dep edge tooling | the right shape for inward audit (#2/#4) |
| (unbuilt) inward audit instrument | #4 intent-integrity | watch — trigger-gated above |

---

## The local-intent-contract (the buildable edge of #4)

The only version that survives all three constraints — you're absent, intent atrophies
in the protocol at hop 1, intermediate hops are opaque — is:

> Hold the full original intent **locally** (the thing A2A drops at hop 1). Check the
> returned artifact against it **at the boundary of return** — not at every hop
> (impossible/opaque), not mid-loop nagging (self-defeating, products are removing
> friction not adding it).

### Flow
1. Agent reads back the ask → you confirm yes/no → confirmed statement **is** the local contract.
2. Agent goes off and works.
3. On return, artifact is checked against the contract.
4. Graded outcome (see below), bounded retry, human escalation on exhaustion.

### Contract clause types (this is what makes it usable, not brittle)
- **Hard constraints** — deviation = failure. ("Must depart Schiphol.") Binary.
- **Soft constraints + tolerance YOU set** — ("≤€300, stretch to €330.") Within → pass-with-note. Beyond → fail. **The agent never picks the tolerance.**
- **Ranked preferences** — ("direct > 1 stop > [2 stops = no].") Return best available, labeled.

> **The trap:** "some deviations accepted" must NOT mean *the agent decides* what's
> acceptable. That hands the fuzzy call back to the entity you don't trust. Deviation
> tolerance is **specified by you up front, or surfaced to you at decision time** —
> never inferred unilaterally by the agent.

### Cost control (answers the token worry)
- Most clauses are **deterministic** (`price<=300 && stops==0`) → **zero tokens**. Only
  irreducibly-semantic clauses ("tone professional") need a model call. Decompose into
  machine-checkable clauses at confirmation time; model-judge only the residue.
- Re-push is the bankruptcy risk, not the check. Use **bounded retry (2–3), not a
  while-loop.** Each re-push names the specific failed clause ("returned €340, needs
  ≤€300") so the agent corrects a named gap instead of flailing — and so it can't just
  **game the check** (the Claude-Code patch-over failure mode again).

### Failure should be informative, not terminal
Binary fail throws away the €310 direct flight you'd have taken. Instead:
1. Exact match → return, done.
2. No exact match, hard constraints OK → re-push **once** to widen ("none under €300, find direct regardless of price").
3. Still none after bounded retries → **return all near-misses, annotated + ranked by fit**, to the human (= `input-required`). You are the tolerance authority for deviations you didn't pre-specify.
4. Hard-constraint violation everywhere → the **only** true fail (return nothing).

### Why this isn't already out there
- Demos are happy-path; they skip "no match, now what" (the actual hard part).
- Funded players build **authorization** contracts (permission ceiling: *may spend ≤€300* — binary, enforced by the token), **not satisfaction** contracts (quality floor: *did the result match what I wanted* — graded, enforced by your check). Look alike, completely different. No enterprise buyer for the graded satisfaction floor at the edge → open lane, same recurring shape.

### What it still can't do (build it knowing this)
- **The unencoded miss** — a deviation in a dimension you never wrote a clause for is
  invisible to the contract (neither hard, soft, nor ranked). Same residue as "tests
  pass ≠ bug fixed."
- **The opaque intermediate hop** — you check the *return boundary*, not what happened
  inside the flight-agent's box.
- Graded degradation makes the contract **humane**, not **complete**. It's a better
  floor, never a ceiling. Trusting it more than that reopens the hole.

---

## Trying A2A for real — minimal build (CF Workers + bareagent)

A2A is just HTTP + JSON-RPC 2.0 + (optional) SSE. CF Workers do all of it natively.
Minimal real setup = **two Workers**: a *remote agent* (server) + a *client/orchestrator*.

### Remote agent Worker — 3 routes
- `GET /.well-known/agent-card.json` (also serve `/.well-known/agent.json` — path moved
  across spec versions) → the Agent Card: identity, endpoint URL, auth scheme, `skills[]`.
- `POST /` (JSON-RPC) handling **`message/send`** → receive Message w/ Parts, treat as a
  Task, do work, return a Message (immediate) or a Task → `completed` w/ an Artifact.
- *(optional v2)* `message/stream` w/ SSE emitting `TaskStatusUpdateEvent`s. Skip for v1.

### Client Worker — the loop
fetch card → parse `skills` → build Message (task in a TextPart/DataPart) →
`message/send` JSON-RPC POST → receive Artifact → **check against local contract** → accept / re-push.

### Build order (each step teaches one thing)
1. **Echo.** Remote serves static card + `message/send` that echoes input as artifact.
   Client fetches card, sends "hello", gets "hello". Proves discovery + JSON-RPC envelope. ~40 lines each.
2. **One real skill.** Flight stub: input `{from,to,date}` → output `{price,stops}` from a fixed list. Now there's a real contract surface.
3. **Orchestrator + contract check.** Client takes "direct flight under €300", **narrows it
   to the flight-agent's input shape** (you'll *feel* intent-atrophy at this exact hop),
   sends, gets artifact, runs deterministic check, re-pushes once with named gap. Whole
   loop from this doc, end to end.
4. *(optional, to feel the mesh)* Add a hotel-stub agent; orchestrator delegates to both
   and combines = canonical travel-planner pattern.

### bareagent's role
Use it as the **orchestrator's brain** on the client Worker: take the NL ask → match an
agent card → narrow into the structured sub-task. Keep it to **route + narrow + check
only** — the *work* lives in the remote agents. This is where you can literally watch
bareagent's interpretation diverge from what you meant (the whole thing you're chasing).

### Workers gotchas
- Skip the official JS SDK (Node-ish assumptions) — hand-implement the few JSON-RPC
  methods; it's small.
- Workers have `fetch`, `crypto.subtle`, SSE via `ReadableStream`. No `fs`, no raw TCP —
  confirm bareagent doesn't reach for Node APIs.
- Auth: start none / static Bearer in the card. No OAuth until the loop works.
- Serve card as `application/json`; permissive CORS if you'll poke it from a browser.
- Reminder of deployed reality: most "A2A" today is the **"agents as tools"** pattern
  (one orchestrator calling sub-agents like functions), not a true peer mesh. The mesh
  is the spec's ambition; function-calls are what's shipping.

### Run it as a measurement, not a demo (observe before you build)

The toy's real payoff isn't learning JSON-RPC — it's that it **manufactures
trigger-condition #1 on your own bench**, cheaply, instead of reasoning about
hop-1 atrophy you've never actually measured. So don't just *feel* the
degradation at the narrowing hop — **instrument it.**

Log, per request, three things at the NL-ask → structured-sub-task hop:
- the original NL intent (verbatim),
- the structured sub-task actually sent to the flight agent,
- the **delta**: which clauses survived, which silently vanished.

After ~20–30 varied asks you have decision-grade data on the question the whole
thesis currently *assumes the answer to*:

> What fraction of intent degrades at hop 1 — and is the lost part in the
> **encodable** clauses (`price<=300`, `stops==0`) or in the **unencodable
> residue** ("good itinerary", "not a miserable 5am layover")?

**The decision rule this produces:**
- Loss mostly in **encodable** clauses → the deterministic gate is worth
  building *when a user appears*. The atrophy is real and catchable.
- Loss mostly in **unencodable residue** → the gate is **cosmetic**: it would
  pass every check while missing what you meant. Don't build it. (Same shape as
  "tests pass ≠ bug fixed" — §198's unencoded miss, now measured instead of
  assumed.)
- Either way the rig **earns the build or kills it** for ~a weekend of Workers
  code. That ROI is why this is the one thing worth building now.

**Framing guard (don't let A2A inflate the build):** the mesh is *motivation,
not mechanism*. The gate you'd eventually build is operator-side egress
middleware that is **identical whether your agent calls one tool or delegates
six hops** — A2A is just the most convenient bench for *observing* the atrophy,
not a dependency of the fix. And name the buildable thing honestly: an
**irreversible-egress contract gate**, not "intent integrity." The grand name
re-opens the unencodable-residue hole every time you lean on it.

---

## Where the gate fires, and confirmation ≠ contract check

### When to check: at EGRESS, before the outbound call leaves
Check the **composed-but-unsent** irreversible request, on your side, before `fetch()`
fires. Not after — after a payment lands at the payee agent, it's done; there's nothing
to verify. The gate is **middleware on your own outbound HTTP**: inspect the request your
agent is about to emit, match its *shape* against your irreversible-action set, run the
contract check on the payload, then release or block. It's trustworthy *because* it sits
on your side of the wire, in code you control, before anything has left.

### How it knows to check: YOUR classifier, not the agent's self-tag
The gate recognizes irreversibility by the **shape of the outbound action against rules
you own** (any `message/send` to an external agent; any spend/send/delete-shaped call) —
**NOT** by the action carrying a "verify me" flag. Self-tagging = the gated thing
operating its own gate = the recurring trap. Customs decides; the package doesn't get to
declare itself exempt.

### Confirmation is NOT a contract check (they do opposite work)
| | Confirmation ("X, yes/no?") | Contract check |
|---|---|---|
| Depends on | **you catching it live** + honest presentation | pre-registered intent, measured automatically |
| Fails when | **you rubber-stamp** (fatigue → reflexive yes) | only on the **unencoded miss** |
| Who judges *when* to ask | the agent (→ self-tag trap) | the gate, on mismatch only |
| Model | voice-readback (needs you present) | customs gate (runs whether you watch or not) |

- The **payment rail's own confirmation** ("pay €340?") doesn't know your contract said
  ≤€300 → it confirms a *valid payment*, not a *faithful one*. Useless for your intent.
- **"My agent asks before irreversible actions"** slides the judgment back into the
  agent. The shortcut-prone agent buries the deviation or doesn't ask. Don't.
- **Right design:** match → proceed silently (you authorized the *shape* up front — that's
  what the contract IS). Mismatch → block, retry w/ named gap, then **raise to human**.
  Human gets pulled in *only on real violation* → rare → so they actually look. Blanket
  confirmation trains rubber-stamping; mismatch-escalation keeps the ask meaningful.

### Two boundaries interlock (don't let one absorb the other)
- **Your gate** = intent fidelity (#4): *did MY agent emit a faithful instruction?*
- **Their auth-trace** = identity-to-human (#3): *who authorized what they did?*
- #3 can't cover #4. Their trace is **forensic, not preventive** — it gives you a name to
  blame *after* the €340 already charged; it doesn't make €340 = €300. Converts silent
  loss → contestable loss (better, not solved). And it relies on the counterparty having
  implemented the least-mature half of the stack.
- A clean gate is what makes their trace usable **against them, not against you**: it
  establishes your half of the record so their deviation is unambiguous.
- Deepest mitigation isn't better gates/traces — it's preferring **reversible rails**
  (escrow, hold-then-capture, confirm-before-final) so the cliff has a guardrail at all.

### The irreversibility scoping knife (from the cheap-tokens objection)
Cheap tokens + better models do NOT dissolve this — they **relocate** it:
- **Reversible compute** (summarize, draft-unsent, refactor): wrong → just re-run. Contract
  here is **wasted effort. Skip it.** This is most usage *today* → why it feels theoretical.
- **Irreversible/world-touching** (book, send, pay, delete, external handoff): re-run ≠
  reverse. Token-to-retry is free; the *consequence* isn't. Cheap tokens irrelevant here.
- Better models raise the floor but **remove the human attention that caught the rare
  miss** → failure moves from *frequent-and-caught* to *rare-and-uncaught* (worse, in
  front of an irreversible action). More autonomy = more irreversible actions/hour, less
  watched. The dangerous region is the one the tech is *expanding into*.
- **Spec, sharpened:** don't gate every return — gate **only the hops that do something
  you can't undo.** Open question nobody knows yet: what fraction of real agent use is
  irreversible-acting vs reversible-compute. Mesh buildout (payments, commerce) suggests
  the irreversible share is *growing*.

---

## IETF / standards landscape (live, as of 2026)

This is the #3 layer being written *right now* — Internet-Drafts (proposed, unstable),
not finalized RFCs. IETF = the body that standardizes core internet protocols; an RFC is
a ratified spec, a "draft" is a proposal that expires (~6 months) unless renewed.
**Caveat: these are individual submissions; most are NOT yet adopted by a working group,
have "no formal standing," and may never become RFCs. ~12–24 mo horizon, much will change.**

### The one that names YOUR gap
- **Delegation Receipt Protocol** — `draft-nelson-agent-delegation-receipts`
  https://datatracker.ietf.org/doc/draft-nelson-agent-delegation-receipts/
  Explicitly: *"each [existing draft] addresses a different trust boundary; none addresses
  user-to-operator trust."* WIMSE = service↔service; AIP = downstream of operator,
  **assumes the operator correctly represented the user's authorization.** That faithful-
  representation assumption is exactly the seam your edge gate refuses to assume. Has a
  `trustedSources` list + a verification check that **MUST reject any action whose
  instructionSource isn't listed** — a drafted "the gated thing can't authorize itself."

### Identity / delegation (the "who" layer — #3)
- **AI Agent Authn/Authz** — `draft-klrc-aiagent-auth` (Kasselman et al., Mar 2026)
  https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/
  Composes existing standards (SPIFFE, WIMSE, OAuth, OpenID SSF) — "no new protocols."
  User/system context preserved + recorded in audit trails. Uses CIBA for out-of-band
  user confirmation on elevated privileges.
- **Agent Identity Protocol (AIP)** — `draft-prakash-aip` / `draft-singla-agent-identity-protocol`
  https://www.ietf.org/archive/id/draft-prakash-aip-00.html
  W3C DIDs + Invocation-Bound Capability Tokens binding identity+scope+provenance in one
  artifact. JWT/Ed25519 single-hop; **Biscuit tokens w/ append-only blocks + Datalog
  policy for multi-hop chains.** Explicit bindings for MCP, A2A, HTTP. (Notes a survey of
  ~2,000 MCP servers found *all* lacked auth.)
- **Delegated Agent Authorization Protocol (DAAP)** — `draft-mishra-oauth-agent-grants`
  https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/
  Persistent cryptographic agent identity; **sub-agent grants scoped to a subset of the
  parent's permissions; entire delegation tree revocable by the original principal.** This
  is the scoped-narrowing-token discipline, drafted.
- **OAuth On-Behalf-Of User for AI Agents** — `draft-oauth-ai-agents-on-behalf-of-user`
  https://www.ietf.org/id/draft-oauth-ai-agents-on-behalf-of-user-00.html
  Extends Authorization Code Grant; explicit user consent at the auth server; token claims
  documenting the user→agent delegation path.

### The open hard problem (no draft yet)
- **Delegation-chain splicing** — OAuth WG mailing-list thread, Mar 2026: attacker inserts
  itself between legitimate hops by manipulating the actor-claim chain. Proposed (not yet
  drafted) mitigation: **audience of step N must cryptographically match subject of step
  N+1**, + short token lifetimes + back-channel revocation on consent withdrawal.
- **NIST AI Agent Standards Initiative** (Feb 2026) + NCCoE concept paper on agent identity
  & authorization — the institutional weight gathering behind extending existing standards.
- Documented real attack (Rehberger, Sep 2025): **Cross-Agent Privilege Escalation** — a
  compromised Copilot agent wrote malicious instructions into Claude Code's config, executed
  on next startup. (This is why `trustedSources` / instruction-source gating exists.)

### Read for your purposes
The entire drafted stack solves **#3 (who + scoped authorization)** and is converging fast.
**None of it solves #4 (did the result match what was MEANT)** — Nelson's draft gets
closest by refusing to *assume* faithful operator representation, but even it verifies
*authorization provenance*, not *semantic intent fidelity*. The contract/gate you've been
designing lives in the gap these drafts explicitly bracket off as "downstream of the
operator" / "user-to-operator trust, not addressed." That gap is real, named by the
standards authors themselves, and still open.
