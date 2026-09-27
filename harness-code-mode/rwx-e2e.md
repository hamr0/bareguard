# rwx + gate.add() end-to-end bench (rwxmap + bareguard)

Throwaway bench (`harness-code-mode/rwx-e2e.mjs`), NOT shipped code. Drives
the real `Gate` from `../src/index.js` and the real rwxmap package from the
local checkout (`/home/hamr/PycharmProjects/rwxmap/src/index.js`, imported
read-only by absolute path — nothing in `src/` imports it, and this bench
never edits the rwxmap repo). If that checkout is missing, the script prints
`SKIP` and exits 0. Scenario, refs and reasoning: PRD `docs/product/
bareguard-prd.md` §23.12 (exporter contract), §23.20 (marker-carrying
entries), §23.21 (runtime `gate.add()` for spec-less sites — the flow this
bench actually drives against real local HTTP servers on 127.0.0.1).

Run: `node harness-code-mode/rwx-e2e.mjs`. Ran twice (see below); `npm test`
confirmed untouched at 530/530.

## What rwxmap actually emitted

Real `exportGate(operationsFrom(spec), { vendor: "airline" })` output for the
bench's 4-endpoint OpenAPI spec (`GET /flights` → `searchFlights`, `GET
/flights/{id}` → `getFlight`, `POST /bookings` → `addBooking`, `DELETE
/bookings/{id}` → `cancelBooking`):

```json
{
  "tools": {
    "airline.searchFlights": { "letter": "r", "marker": "settled" },
    "airline.getFlight":      { "letter": "r", "marker": "settled" },
    "airline.addBooking":     { "letter": "w", "marker": "settled" },
    "airline.cancelBooking":  { "letter": "x", "marker": "settled" }
  },
  "collisions": []
}
```

Notes on how these letters were reached (read from rwxmap's own ladder, not
guessed): `searchFlights`/`getFlight` hit step 1's `READ_VERBS` (`search`,
`get`) → `r`. `DELETE /bookings/{id}` hits step 2's unconditional
method-delete floor → `x`, `destructive: true` (not surfaced in the gate
`tools` entry — correctly kept out per §23.12/§23.20). `addBooking`'s lead
verb `add` is in step 3's `KEEP_W` list → `w`. All four came out `marker:
"settled"` (source `list` or `floor` for DELETE, review hint
"neither tight nor loose" — see flow.js's `reviewHint`), so none went
through `rwx.askOn:"loose"` in this run; the scripted `humanChannel` was
never actually invoked by the exportGate-sourced keys. (A genuinely
`loose`-marked row, e.g. a hand-picked `PUT` with no word evidence, would
have; this bench's spec happened not to produce one — noted as a gap below.)

For the spec-less hotel site, `classifyRow({method, path})` was called
per-request through the bench's stand-in normalizer:

```
GET  /rooms         -> r  (step 1, method floor)
GET  /rooms/{id}     -> r  (step 1, method floor)   [via the id-normalizer]
POST /reservations   -> x  (step 2's floor-post: no operationId, "reservations"
                             matched no READ_VERBS/CANT_UNDO/KEEP_W word)
```

These per-request classifications carry `marker: null` (bare letter, not an
object) — `normalizeEntry` treats that as a state distinct from `"loose"`,
confirmed live: the audit line for these `rwx.added` entries has no
`marker` field at all, and `gate.add()` accepted them as ordinary bare-letter
entries.

## API-shape friction (bareguard <-> rwxmap), from a harness author's seat

1. **`exportGate`'s `tools` output drops straight into `gate.add()`
   unmodified.** No reshaping needed — `{ key: { letter, marker } }` is
   exactly `add()`'s accepted shape. This is the one piece that "just
   worked."

2. **No path→operationId matcher going the other way.** `operationsFrom`
   flattens a spec into a list; `exportGate` keys the result by
   `<vendor>.<operationId>`. But when the harness later wants to make one
   specific live call (e.g. "GET /flights/42"), rwxmap gives it no function
   to answer "which gate key does this method+path match against the
   spec?" — the harness has to already know the operationId it's invoking
   (it authored the request), or maintain its own OpenAPI path-template
   matcher. This bench sidesteps it by having the harness pass
   `operationId` alongside every spec'd call (see `Harness.call`'s
   signature) — realistic for a harness that generated the call from the
   spec in the first place, but a harness that receives an agent's raw
   `{method, url}` for a spec'd site has no rwxmap-provided way to resolve
   it back to `<vendor>.<operationId>`. Worth a finding for whoever owns
   that harness-side lookup (not bareguard's job either way).

3. **rwxmap's per-request key normalizer genuinely isn't shipped.** Had to
   write `normalizeKeyStandIn()` by hand per §23.21's spec (drop query
   string; digit/UUID/long-hex path segments → `{id}`). Confirmed this is
   not an oversight in reading — `rwxmap`'s `src/index.js` only exports
   `classifyRow`/`reviewHint`, the Jev tier functions, and the exporter
   trio; there is no per-request key builder anywhere in `src/`. Once it
   ships, this bench's stand-in should be deleted and the real one dropped
   in — the classify+key steps are already cleanly separated in
   `Harness.call`'s no-spec branch for exactly that swap.

4. **`classifyRow` doesn't want a `key` on its input** — it takes
   `{method, path, operationId?, summary?, description?}` and returns the
   verdict; the CALLER (this bench) is responsible for building the gate
   key separately via the stand-in normalizer. That's a clean separation,
   not friction — noted only because it means the harness owns two
   independent decisions (classify, then key) rather than one call.

5. **Collision reporting (`exportGate`'s `collisions` array) never fired in
   this bench** (`[]` — every operationId was unique) so it went
   unexercised here; the shape (`{key, existing, incoming, keptLetter}`)
   reads as sane from the source but this bench does not add independent
   evidence for it.

## Things that felt wrong or missing in bareguard's own API, from this seat

1. **`gate.cfg.rwx.tools` is read directly by this bench's step 9 check and
   by the replay's tools-map reconstruction** — there is no public
   accessor for "what does the gate currently believe this key's letter
   is," only the private `cfg` object. A harness that wants to log its own
   view of the live tools map (for a dashboard, say) has to reach into
   `gate.cfg.rwx.tools` today, which isn't documented as public surface.
   Minor, but real: `add()` is the only *write* path; there's no
   corresponding *read* path.

2. **`gate.audit.readAll()` (used for this bench's replay) is likewise not
   part of the exported public API** (`src/index.js` doesn't re-export
   `Audit`) — reachable only via `gate.audit`, an instance property that
   happens to be public but isn't documented as a stable surface. The
   replay contract in §23.21 ("every allow line traces to the tools map at
   that log position") *implies* a caller needs to read the audit log back
   programmatically, but there's no blessed way to do it outside importing
   `defaultAuditPath` and reading the file directly (which loses the
   fileless-mode case entirely).

3. **One `rwx.agent` per `Gate` means one `Gate` per agent identity.** For
   a 2-agent fleet visiting 2 sites, this bench had to construct two full
   `Gate` instances up front and manually fan every `gate.add()` call out
   to both of them so their tools maps stay in sync. That's a real
   harness-author burden the PRD doesn't flag: `add()`'s tighten-only
   contract is per-gate-instance, so N agents sharing "what we've learned
   about this site" means N independent adds per learned key, with no
   built-in way to add to "every gate for this operator's fleet" in one
   call. Worked fine here (2 agents, fan-out is 2 lines), but would not
   scale cleanly to a fleet of dozens.

4. **The audit line's field name for the terminal outcome is `decision`,
   not `outcome`** (`Result.outcome` on the object `check()` returns, but
   `entry.decision` on the persisted audit line) — cost one real debugging
   cycle writing the replay (see below). Nothing wrong per se (the audit
   schema is its own documented shape, distinct from `Decision`), but the
   name mismatch between the two closely-related shapes was a genuine
   surprise from this seat and worth flagging as a possible naming
   inconsistency.

## Real friction hit while building this (fixed in the bench, not in src/)

- First replay pass reported "0 distinct aids seen" against 28 real
  `check()` calls. Root cause (via evidence, not guessing): the audit
  line's terminal field is `decision` (`"allow"`/`"deny"`), while this
  bench's first draft filtered on `entry.outcome` — a field that exists on
  the object `check()` *returns* but not on the *persisted audit line*.
  Fixed by reading the real JSONL file (`cat` on the audit path) before
  writing the second attempt, rather than assuming the two shapes matched.
  Left as finding #4 above rather than silently patched over.

## Scenario run output (run 1 of 2; run 2 is byte-identical in shape, fresh
ports/aids)

```
step | agent    | action type                          | expected                 | got                                                                 | result
1    | searcher | airline.searchFlights                | allow + 200              | allow/rwx.allow + 200                                                | PASS
2    | searcher | airline.addBooking                   | deny/rwx.denied          | deny/rwx.denied                                                      | PASS
3    | booker   | airline.addBooking                   | allow                    | allow/rwx.allow marker=settled                                       | PASS
4    | searcher | <host>.GET /rooms                    | allow, key has no '?'    | allow/rwx.allow type="<host>.GET /rooms" fetched=200                 | PASS
5    | searcher | <host>.POST /reservations             | deny                     | deny/rwx.denied                                                      | PASS
6    | searcher | airline.searchFlights (metadata URL) | deny/net.*               | deny/net.allowDomains                                                | PASS
7    | searcher | airline.searchFlights (example.com)  | deny/net.allowDomains    | deny/net.allowDomains                                                | PASS
8    | searcher | airline.neverAdded                   | deny/rwx.unlisted        | deny/rwx.unlisted                                                    | PASS
9    | searcher | airline.testDeprecatedRead            | throw + stays "w"        | threw: gate.add: rwx.tools.airline.testDeprecatedRead would LOOSEN…  | PASS
10   | searcher | (20 concurrent hotel GETs)            | all 20 allow, none throw | allAllowed=true anyThrew=false (20 settled)                          | PASS

=== run1 totals: PASS=57 FAIL=0 ===
```

(57 = 10 scenario rows + the audit replay's own per-aid re-checks, key-trace
checks, and the one-line-per-aid invariant check, all folded into the same
PASS/FAIL counter per the task's "print PASS/FAIL totals" instruction.)

Step 6's metadata-IP deny landed as `net.allowDomains` rather than a
`net.denyPrivateIps` deny — expected and correct given this bench's config:
`denyPrivateIps` is OFF (see below), so `169.254.169.254` is caught by the
allowlist (`allowDomains: ["127.0.0.1"]`) instead, which still denies it. No
finding here — just noting which rule actually fired, since the task
description only said "net deny," not which rule.

**Why `denyPrivateIps: false` here:** `127.0.0.1` — this bench's own two test
servers — IS itself a loopback/private address, so turning `denyPrivateIps`
on would deny every single call in the scenario, including the ones meant to
succeed. The `allowDomains: ["127.0.0.1"]` allowlist alone bounds egress to
exactly the two local test servers, which is what a real deployment's
`allowDomains` is for; a real deployment fetching real internet hosts would
leave `denyPrivateIps` on. This is a bench-only relaxation, not a claim about
production config.

Both full runs (`node harness-code-mode/rwx-e2e.mjs` invoked twice,
independently) produced `PASS=57 FAIL=0`, exit code 0. `npm test` confirmed
530/530, tree otherwise clean (`git status --porcelain` shows only this file
and `rwx-e2e.mjs` as untracked).

## Known gaps in this bench (stated, not hidden)

- No row in the bench's own OpenAPI spec came out `marker: "loose"`, so
  `rwx.askOn:"loose"`'s human-ask path was never exercised via the
  spec-sourced keys (only the always-allow scripted `humanChannel` function
  exists, unexercised). A `PUT`/`PATCH` op with no word evidence would have
  triggered it; the bench's 4 endpoints (2 GET, 1 POST, 1 DELETE) don't
  include one. Left as-is rather than hand-picking an operation just to
  force the marker, per the instruction to read real shapes rather than
  engineer the scenario backward from a desired marker.
- `exportGate`'s collision-reporting path was not exercised (no two
  operationIds collided in this bench's spec).
