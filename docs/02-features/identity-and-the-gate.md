# Identity and the gate

> Where agent identity / auth sits relative to bareguard, and how to policy
> per-principal once it's settled. Short version: **identity is upstream of the
> gate. bareguard authorizes the *action*, not the *actor*.**

This exists because adopters keep asking some version of "should bareguard
verify the calling agent / do DID auth / check tokens" — usually after seeing a
networked agent framework (e.g. [bindu](https://github.com/GetBindu/bindu),
which layers mTLS + OAuth2/Hydra + DID/Ed25519 signatures). The answer is no, and
here's the reasoning so it doesn't get re-litigated.

## "Agent auth" is four different things

They get bundled, but only one is anywhere near bareguard's job:

| Question | Name | bareguard? |
|---|---|---|
| Is this caller who they claim to be? | **authentication** | No — upstream. |
| Is this caller allowed to do *this*? | **authorization** | **Half of it** — see below. |
| Was this request tampered with / can the sender deny it? | **integrity / non-repudiation** | Only its *own log* — a parked future-feature candidate (see below). |
| Can a third party read the traffic? | **confidentiality** | No — transport. |

All four are no-ops inside a single trust domain. If the agent is *yours*, in
*your* process, acting on *your* behalf, there's nobody to authenticate, nothing
in transit between strangers, no dispute to settle. They only start mattering at
a **trust boundary** — talking to an agent run by someone you don't control,
especially if money or irreversible actions ride on it. That's the world bindu
builds for (the "agent internet" + payments); it's not where an embedded gate lives.

## The reframe: bareguard is already half of authz

- Principal authz (Hydra, scopes, DIDs): "*DID X* may call `message/send`." Keyed on **who**.
- bareguard authz: "this command / path / domain is allowed." Keyed on **what**.

bareguard deliberately owns the half that **doesn't require knowing who you are**.
Its contract is: by the time an action reaches the gate, identity is already
settled upstream (the OS, the messaging platform, an A2A peer's signature,
whatever); the gate's only job is whether the action *itself* is permitted. That
is why the [NO-GO list](../04-process/non-roadmap.md) says "Identity / authn / authz — caller's
concern. bareguard sees actions, not principals."

## You can still policy per-principal — no auth code in the gate

When the runner *has* established identity, attach it to the action's `_ctx`.
bareguard preserves `_ctx` verbatim into the audit line and through to
`humanChannel`, so per-principal policy falls out of existing primitives:

```js
// Runner authenticated the caller upstream (platform, mTLS peer, signed A2A body).
// Attach the resulting principal — bareguard treats it as opaque routing context.
const action = { type: "fetch", url, _ctx: { agentDid: "did:key:z6Mk…", principal: "alice" } };

// 1) Per-principal Gate (README Recipe 2): different caps/scope per identity.
function gateForPrincipal(did, trusted) {
  return new Gate({
    runId: did,
    budget: { maxCostUsd: trusted ? 50 : 1 },
    bash:   { allow: trusted ? ["git", "ls", "npm"] : ["ls"] },
    humanChannel: async (e) => promptOwner(e.action?._ctx?.principal, e),
  });
}

// 2) Identity-aware deny via content patterns (matches the serialized action,
//    _ctx included). e.g. quarantine an untrusted DID prefix from writes:
const gate = new Gate({
  content: { denyPatterns: [/"agentDid":"did:key:zUntrusted/] },
});

// 3) The principal lands in the audit log automatically — grep it:
//    jq 'select(.action._ctx.agentDid=="did:key:z6Mk…")' audit.jsonl
```

No new primitive, no DID resolver, no token introspection in the gate. The gate
consumes an already-authenticated principal; it never establishes one.

## What about signing / verifying agents (the bindu `X-DID-Signature` layer)?

That's a real need *if and when* an agent makes calls across a trust boundary —
but it belongs to the **runner / comm layer**, not the gate. The lightweight,
bare-philosophy version (zero-infra Ed25519 sign/verify of a canonical request
body, no CA, no Hydra) is tracked as a future feature in **bareagent**'s PRD
(§17), not here. bareguard would only ever *policy* on the verified principal the
runner hands it — exactly the pattern above.

## The one integrity slice bareguard might own

Not agent auth — *audit* integrity: proving bareguard's own log wasn't edited
after the fact. A hash chain over audit entries would detect post-hoc
mutation / deletion / reorder, but it is **not** a signature (no authorship proof)
and a *global* chain is impossible without a per-emit lock — bareguard's audit is
multi-writer and lock-free. A per-`run_id` chain is feasible but only protects
within a run. This is a **parked future-feature candidate**, not shipped: see PRD
§19 "Future features" and [non-roadmap.md](../04-process/non-roadmap.md).
