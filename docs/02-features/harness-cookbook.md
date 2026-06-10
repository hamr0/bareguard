# Harness cookbook — operator-vetted capability bundles

> The recipe library promised by [`harness-prd.md`](../01-product/harness-prd.md) §5.2.
> A **harness bundle** is a named preset of `{ tool menu + extra restrictions }` for a
> situation. It is **ergonomics, not a guard** (D2): a bundle can only **tighten** the
> floor — smaller menu, more asks — never loosen it. If the agent picks the wrong
> bundle, nothing unsafe happens; the floor catches the irreversible action regardless
> (proven by POC gate E5: a too-narrow bundle on a booking task did not let the booking
> slip — the floor stopped it).

## The pattern

One **floor** (user-authored, constant) + a **catalog** of vetted bundles (each a
subset of the floor's tools) + a **resolver** that fails closed on anything off-catalog.
Validated in `harness-code-mode/harness-catalog.mjs` (E5); generalized here:

```js
import { Gate } from "bareguard";

// THE FLOOR — user-authored, identical under every bundle. Bundles never touch it.
const FLOOR = {
  tools:   { allowlist: FLOOR_TOOLS, denylist: ["wireMoney"] },  // universal hard deny
  content: {},                       // safe-default askPatterns stay active (destructive verbs → ask)
  budget:  { maxCostUsd: 5.00 },     // cumulative wall — bounds decomposition (E3)
  humanChannel: yourChannel,
};
const FLOOR_TOOLS = ["search", "read", "fetch", "bookFlight", "sendEmail"];

// THE CATALOG — operator-vetted bundles. The agent may PROPOSE one BY NAME; it may
// never author its own (M1: a fence no operator vetted is not a fence).
const CATALOG = {
  "read-only-research": { tools: ["search", "read", "fetch"] },
  "book-with-approval": { tools: ["search", "read", "bookFlight"],
                          askPatterns: [/bookFlight/i] },        // every booking asks
  "send-comms-HITL":    { tools: ["read", "sendEmail"],
                          askPatterns: [/sendEmail/i] },         // every send asks
};

// THE RESOLVER — tighten-only by intersection; fail CLOSED on off-catalog.
function gateFor(bundleName) {
  const b = CATALOG[bundleName];
  if (!b) return null;                                   // off-catalog → REFUSE to run
  const allowlist = b.tools.filter((t) => FLOOR_TOOLS.includes(t));
  if (allowlist.length === 0) return null;               // see foot-gun below
  return new Gate({
    ...FLOOR,
    tools:   { ...FLOOR.tools, allowlist },              // narrowed menu (⊆ floor)
    content: { askPatterns: [
      ...(b.askPatterns ?? []),
      // floor asks stay in force: pass your floor patterns explicitly if you
      // override the safe defaults; never REPLACE floor asks with bundle asks.
    ] },
  });
}
```

### ⚠️ The one foot-gun: an empty allowlist fails OPEN

`tools.allowlist: []` is treated as *not configured* — step 5 is skipped and the
action falls through to default **allow** (verified against `src/primitives/tools.js`).
So a bundle must never resolve to an empty allowlist, and an off-catalog or
self-authored proposal must be refused **at resolve time** (return `null` → don't run),
not "enforced" by handing the gate an empty scope. This is why `gateFor` has two
`return null` paths. Selection is gated by the resolver; safety is gated by the floor.

## The bundles

### 1. `read-only-research`
Reversible-only scope: search/read/fetch, nothing that writes or sends.
```js
{ tools: ["search", "read", "fetch"] }
// Pair with net.allowDomains to bound egress, fs.readScope to bound reads:
// net: { allowDomains: ["api.example.com"] }, fs: { readScope: ["/data"] }
```

### 2. `book-with-approval`
Adds one irreversible capability; every use of it escalates to the human.
```js
{ tools: ["search", "read", "bookFlight"], askPatterns: [/bookFlight/i] }
```
The ask is the HITL *trigger* (tier 2); the spend wall is the floor's cumulative
`budget` (tier 1) — a per-action pattern alone is decomposable (E3: €200+€200 walks
past a `>€300` regex; `maxCostUsd: 300` halts it).

### 3. `send-comms-HITL`
Outbound comms with a human on every send.
```js
{ tools: ["read", "sendEmail"], askPatterns: [/sendEmail/i] }
```

### 4. `memory-adopter` (litectx-shaped; contract-tested)
For a memory engine emitting `memory.write` / `memory.inject` actions. This exact
shape is pinned by `test/seam-contract.test.js` (gate-zero):
```js
{
  tools: ["memory.write", "memory.inject", "recall"],
  // bareguard gates the write SHAPE. Secret/injection CONTENT in the write text is
  // NOT caught by default (§6: content judgment is the adopter's provenance tier).
  // If you want the gate to hold that line too, wire it EXPLICITLY:
  denyPatterns: [/sk-live-[a-z0-9]+/i],          // deny secret-bearing writes
  askPatterns:  [/ignore all prior instructions/i], // escalate injection-looking writes
}
// `secrets: { patterns: [...] }` redacts the AUDIT TRAIL but does NOT deny the
// action — redact ≠ gate. Use content.denyPatterns to actually block.
```

### 5. `code-mode-sandbox` — agent writes the body, gate stays in the parent
The harness PRD's north star as a bundle (validated by POC gates E1 + E4): instead of
one-by-one tool calls, the agent **writes a code body** over a typed tool menu. The
body runs in a **separate process** under Node 22 `--permission`; the gate and the
real tools live in the **parent**, reachable only via RPC — so even a sandbox escape
(`constructor.constructor` reaches `require`) buys nothing: `fs`/`child_process`
throw `ERR_ACCESS_DENIED`, and there is no network tool to steal.
```js
// parent (trusted): gate + tools + RPC server
const gate = new Gate({ ...FLOOR, tools: { ...FLOOR.tools, allowlist: bundleTools } });
// child (untrusted body):  node --permission --allow-fs-read=/sandbox body.mjs
// every tools.call(name, args) in the body → RPC → parent → gate.run() → real tool
```
Full working pattern: `harness-code-mode/hardened-sandbox.mjs` + `run-e4.mjs`.
Honest gap: `--permission` does not gate network egress (OS concern — netns/seccomp);
the RPC design compensates by giving the body no legitimate network tool at all.

### 6. `repo-maintainer` — git ops free, shipping asks
The Software-Factory ship-gate (SF-6) as a recipe, usable today without the Factory:
read/diff/test freely; anything that *publishes* (push, merge, deploy) asks a human.
```js
{
  tools: ["bash", "read", "write"],
  // bash.allow bounds the binaries; shell metacharacters are auto-denied with allow set
  bash: { allow: ["git", "npm", "node"], denyPatterns: [/push\s+--force/, /reset\s+--hard/] },
  askPatterns: [/git\s+push/i, /\bmerge\b/i, /\bdeploy\b/i, /gh\s+pr\s+merge/i],
  // fs.writeScope: keep edits inside the repo worktree
}
```
The safe defaults already ask on `force-push` and deny `--force` — these patterns
*add* the publish verbs. When the Software Factory arrives, its Ship gate (SF-9)
starts life as exactly this bundle.

### 7. `delegation` — sub-agents without fork bombs
The only shipped primitives no other recipe covers: spawn/defer containment.
```js
{
  tools: ["spawn", "defer", "read", "search"],
  // floor-side (these are run-level walls, so they belong in the FLOOR config):
  // limits: { maxChildren: 5, maxDepth: 2 },   — lifetime spawns / tree depth
  // spawn:  { ratePerMinute: 10 },             — trailing-60s cap, per family
  // defer:  { ratePerMinute: 15 },
}
```
Rate caps count the **family's** audit log (root `run_id`), so children don't reset
to `0/cap` — a fork-bomb-shaped agent hits the wall no matter how it nests. A
confused agent emitting thousands of deferred jobs is the incident this bundle exists
for.

### 8. `detect-and-feed-A` — Axis B as a recipe (no bareguard change)
The E2 pattern (`harness-code-mode/run-e2.mjs`), generalized. Your constraint stays
**your code** (~10 lines) — no DSL, no new primitive; this recipe is also the demand
sensor for the deferred public format (harness-prd OQ1, §6.5).
```js
const constraint = { maxPrice: 300 };          // per-request, USER-authored (never the agent)
const returns = [];                             // record authoritative tool returns

function reconcile(record, c) {                 // YOUR check — the variable part
  const notes = [];
  if (c.maxPrice != null && record?.price > c.maxPrice)
    notes.push(`€${record.price}, exceeds your stated max of €${c.maxPrice}`);
  return notes;
}

const gate = new Gate({ ...FLOOR,
  humanChannel: async (event) => {
    // A already decided to stop. B only enriches what the human sees.
    const record = findReturnFor(event.action, returns);   // the world's record, not the agent's claim
    const notes = reconcile(record, constraint);
    return yourRealChannel({ ...event,
      reason: notes.length ? `Axis B: ${notes.join("; ")}` : event.reason });
  },
});
```
Rules (D7, locked): facts only — B never blocks, never modifies; on a path with no
A-stop, send the notes to agent context + audit instead of interrupting. Ceiling:
catches honest violations of *stated* constraints — not lies (F8), not omissions (§11).

### 9. Roll-your-own skeleton
1. Start from the floor — never from scratch (a bundle is a *subset*, not a config).
2. Subset the allowlist to the task's tools. Never add a tool the floor doesn't have.
3. Add `askPatterns` for anything irreversible the bundle keeps in scope.
4. Anything quantitative goes in the floor's cumulative `budget`/`limits`, not a regex.
5. Resolve by name through a `gateFor`-style resolver; off-catalog → refuse to run.
6. Pin it with a seam-style contract test (copy `test/seam-contract.test.js`):
   on-list action allows with rule `tools.allowlist`; off-list denies with
   `tools.allowlist.exclusive`; your deny/ask levers fire with their exact rules.

## Rules of the cookbook (the parts that are not optional)

- **Operator vets, agent proposes.** The agent picks a bundle *by name* at runtime
  (D8). An agent-authored bundle promoted to the catalog without a vetting step is
  M1 with extra steps — never.
- **Tighten-only, enforced by intersection** — not by trust in the catalog's contents
  (`filter` against `FLOOR_TOOLS` holds even if a catalog entry is mis-edited).
- **The bundle is not load-bearing for safety.** The floor's deny/ask/budget fire
  identically under every bundle (E5: floor is selection-independent). If your design
  needs the *bundle* to stop something dangerous, move that rule into the floor.
- **No ungoverned path.** Default bundle = most-permissive *reversible* set, so there
  is never an unwrapped run; off-catalog proposals refuse to run.
