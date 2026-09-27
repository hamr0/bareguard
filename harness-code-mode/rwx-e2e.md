# rwx + gate.add() end-to-end bench (rwxmap + bareguard)

Throwaway bench (`harness-code-mode/rwx-e2e.mjs`), NOT shipped code. Drives
the real `Gate` from `../src/index.js` and the real rwxmap package from the
local checkout (`/home/hamr/PycharmProjects/rwxmap/src/index.js`, plus its
POC key builder at `/home/hamr/PycharmProjects/rwxmap/poc/match/key.mjs`,
both imported read-only by absolute path — nothing in `src/` imports either,
and this bench never edits the rwxmap repo). If either checkout path is
missing, the script prints `SKIP` and exits 0. Scenario, refs and reasoning:
PRD `docs/product/bareguard-prd.md` §23.12 (exporter contract), §23.20
(marker-carrying entries), §23.21 (runtime `gate.add()` for spec-less sites —
the flow this bench actually drives against real local HTTP servers on
127.0.0.1).

Run: `node harness-code-mode/rwx-e2e.mjs`. Ran twice both before and after
the extension described below (see "Scenario run output"); `npm test`
confirmed untouched at 530/530 both times.

**Extension (second pass, coordinator-approved):** replaced the bench's own
hand-rolled key stand-in with rwxmap's real (if not-yet-graduated) POC key
function; added a third, spec-less "flights-rpc" site to exercise a
Google-Flights-shaped RPC path plus a `/graphql` call where the operation
name lives only in the body; and closed the `rwx.askOn:"loose"` gap the
first pass had left (see "Known gaps" below) with real, live ask/allow/deny/
no-ask exercises. Steps renumbered 1-16; steps 1-10 are unchanged in
behavior from the first pass.

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
per-request through the key builder (see below for which one):

```
GET  /rooms         -> r  (step 1, method floor)
GET  /rooms/{id}     -> r  (step 1, method floor)   [via the id normalizer]
POST /reservations   -> x  (step 2's floor-post: no operationId, "reservations"
                             matched no READ_VERBS/CANT_UNDO/KEEP_W word)
```

These per-request classifications carry `marker: null` (bare letter, not an
object) — `normalizeEntry` treats that as a state distinct from `"loose"`,
confirmed live: the audit line for these `rwx.added` entries has no
`marker` field at all, and `gate.add()` accepted them as ordinary bare-letter
entries.

### Site C — "flights-rpc" (spec-less, Google-Flights-shaped), real
`classifyRow` output pasted verbatim

```json
{
  "vendor": "flights-rpc",
  "method": "POST",
  "path": "/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults",
  "verdict": {
    "class": "r",
    "step": 1,
    "rule": "read-verb",
    "source": "list",
    "matched": ["get"],
    "review": "settled"
  }
}
{
  "vendor": "flights-rpc",
  "method": "POST",
  "path": "/graphql",
  "verdict": {
    "class": "x",
    "step": 2,
    "rule": "floor-post",
    "source": "floor",
    "matched": [],
    "review": "tight"
  }
}
```

Traced through the real ladder, not guessed: with no `operationId`, rwxmap's
`tokensForRow` reads the lead string from the last non-`{param}` path
segment — `GetShoppingResults` for the RPC call, which `splitTokens`
camelCase-splits to `["get","shopping","results"]`; the lead token `get`
matches step 1's `READ_VERBS` exactly (not through the plural guard) → `r`,
`review: "settled"` (POST + `r` doesn't hit either of `reviewHint`'s special
cases). For `/graphql`, the lead segment is `graphql`, which matches nothing
in any word list, so it falls all the way to step 2's `floorPost()` → `x`;
`reviewHint('POST', 'x', 'floor')` → `"tight"` (the "review to loosen, safe
bucket" hint — *not* `"loose"`, since `reviewHint`'s `loose` case is
`w`+`PUT`/`PATCH`+`floor` only). searcher (`r--`) holds `r` so the RPC call
allows; searcher lacks `x` so `/graphql` denies — matching the coordinator's
stated expectation exactly, reached by reading the real ladder rather than
assuming it.

This is also more evidence for the friction finding above (#2/#4): the
harness never told rwxmap that `GetShoppingResults` is "the same shopping
call" as the `/graphql` query naming it in its body — rwxmap classifies
purely from the path it's given, and has no way to know two different
requests are "the same operation" when one only names it in a header/path
and the other only in a body payload it never inspects (by design — see
finding #4 above and §23.12's `serializeForMatch` payload boundary on the
bareguard side, same principle applied on rwxmap's side of the fence).

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

3. **rwxmap's per-request key normalizer genuinely isn't shipped in `src/`.**
   Confirmed by reading `src/index.js`'s own exports (`classifyRow`/
   `reviewHint`, the Jev tier functions, the exporter trio) — no per-request
   key builder there. It DOES exist as a POC, `requestKey(method, url,
   {mixedIds?})` in `poc/match/key.mjs`, pinned by 19 of rwxmap's own tests
   (`poc/match/key.test.mjs`) and, per that file's own header, slated to
   graduate into `src/` later. This bench's first pass (before this
   extension) hand-wrote a stand-in from reading §23.21's prose spec alone;
   this second pass replaced it with the real POC import (`POC path —
   switch to rwxmap's src export when it ships`, one-line comment at the
   import site in `rwx-e2e.mjs`), and it is a strict superset of the
   hand-written stand-in: percent-escape normalization (uppercase the hex
   of any escape that isn't itself unreserved), IDN/punycode via the WHATWG
   `URL` parser's own hostname handling, and an explicit, tested default-port
   drop the hand-written version never had to get right (it never handled
   ports at all — the bench's first-pass sites were both bare `127.0.0.1`).
   The bench's own `keyFormatSelfCheck()` exercises 12 cases against the
   real POC function (all 12 pass — see run output below): default
   https/http port drop, non-default port kept, host lowercasing, query+
   fragment drop, repeated-slash collapse, trailing-slash drop (and the
   `"/"` special case), all three id forms, and method uppercasing.
   Confirms the hand-written stand-in's UNDERSTANDING of the spec was
   correct on every case it covered — it just didn't cover percent-escapes
   or ports.

4. **`classifyRow` doesn't want a `key` on its input** — it takes
   `{method, path, operationId?, summary?, description?}` and returns the
   verdict; the CALLER (this bench) is responsible for building the gate
   key separately via `requestKey`. That's a clean separation, not
   friction — noted only because it means the harness owns two independent
   decisions (classify, then key) rather than one call, and (per the new
   site-C finding above) that the two calls can be given DIFFERENT
   representations of "the same operation" (path-named vs body-named) with
   no way for either function to notice.

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

5. **An `askOn:"loose"` decision writes THREE audit lines sharing one
   `aid`, two of which independently satisfy "phase is `gate`-shaped with a
   decision field"** — the ask-emit (`phase:"gate"`, `decision:"askHuman"`),
   the human's raw reply (`phase:"approval"`, `decision:"allow"`/`"deny"`),
   and the true terminal commit (`phase:"gate"`, `decision:"allow"`/
   `"deny"`). A caller trying to answer "what did this aid finally decide"
   by scanning for a `decision` field alone (as this bench's replay first
   did) double-counts. `phase === "gate"` is the actual disambiguator, but
   that's undocumented outside reading `gate.js`'s own source — there's no
   published enum of audit `phase` values a consumer can check against.
   This cost a second real debugging cycle in this bench (see below); a
   documented, closed list of `phase` values (or a boolean like
   `terminal: true` on the one line that's authoritative) would have made
   this a non-issue for any downstream audit-log consumer, not just this
   bench.

## Real friction hit while building this (fixed in the bench, not in src/)

- First replay pass (first bench pass) reported "0 distinct aids seen"
  against 28 real `check()` calls. Root cause (via evidence, not guessing):
  the audit line's terminal field is `decision` (`"allow"`/`"deny"`), while
  this bench's first draft filtered on `entry.outcome` — a field that exists
  on the object `check()` *returns* but not on the *persisted audit line*.
  Fixed by reading the real JSONL file (`cat` on the audit path) before
  writing the second attempt, rather than assuming the two shapes matched.
  Left as finding #4 above rather than silently patched over.

- Second bug, hit while adding the `rwx.askOn:"loose"` steps in this
  extension: the replay's "exactly one final gate line per aid" check
  reported 2 lines for the two loose-marker aids. Root cause, found by
  reading the actual JSONL for one of those aids rather than guessing: an
  `askOn:"loose"` decision writes THREE lines for one `aid` — a `phase:
  "gate"`/`decision:"askHuman"` line (the ask-emit, outside the lock), a
  `phase:"approval"`/`decision:"allow"` line (the human's own raw reply,
  logged separately), and the real terminal `phase:"gate"`/
  `decision:"allow"` line. The replay's `isFinalCheckLine` filtered only on
  `decision === "allow"||"deny"`, which the `"approval"` line also
  satisfies — a second false-positive "final" line per ask. Fixed by also
  requiring `phase === "gate"`, which is the one phase name shared by both
  the ask-emit and the true terminal line, disambiguated only by
  `decision`. This is a second real "the audit schema has more structure
  than the object `check()` returns" surprise from this seat — see finding
  #5 above.

## Scenario run output (post-extension; run 1 of 2, both runs PASS=78 FAIL=0)

Key-format self-check (12/12 PASS, real `requestKey` from
`poc/match/key.mjs`):

```
default https port dropped:   requestKey("GET","https://API.Example.com:443/x") = "api.example.com.GET /x"   PASS
default http port dropped:    requestKey("GET","http://API.Example.com:80/x")   = "api.example.com.GET /x"   PASS
non-default port kept:        requestKey("GET","http://127.0.0.1:8080/x")       = "127.0.0.1:8080.GET /x"     PASS
host lowercased:               requestKey("GET","https://API.EXAMPLE.COM/x")     = "api.example.com.GET /x"   PASS
query + fragment dropped:      requestKey("GET","https://api.example.com/x?y=1&z=2#frag") = "api.example.com.GET /x" PASS
repeated slashes collapsed:    requestKey("GET","https://api.example.com/x//y") = "api.example.com.GET /x/y"  PASS
trailing slash dropped:        requestKey("GET","https://api.example.com/x/")   = "api.example.com.GET /x"    PASS
root path stays '/':           requestKey("GET","https://api.example.com/")     = "api.example.com.GET /"     PASS
all-digit id -> {id}:          requestKey("GET",".../orders/98765")             = ".../orders/{id}"            PASS
UUID id -> {id}:                requestKey("GET",".../users/3fa85f64-...")      = ".../users/{id}"             PASS
16+ hex id -> {id}:             requestKey("GET",".../objects/1234567890abcdef1234") = ".../objects/{id}"     PASS
method uppercased:              requestKey("get","https://api.example.com/x")   = "api.example.com.GET /x"    PASS
```

Scenario steps (16, real ports/aids per run — one representative run shown):

```
step | agent    | action type                          | expected                     | got                                                                | result
1    | searcher | airline.searchFlights                | allow + 200                  | allow/rwx.allow + 200                                              | PASS
2    | searcher | airline.addBooking                   | deny/rwx.denied              | deny/rwx.denied                                                    | PASS
3    | booker   | airline.addBooking                   | allow                        | allow/rwx.allow marker=settled                                     | PASS
4    | searcher | <host>.GET /rooms                    | allow, key has no '?'        | allow/rwx.allow type="<host>.GET /rooms" fetched=200               | PASS
5    | searcher | <host>.POST /reservations             | deny                          | deny/rwx.denied                                                    | PASS
6    | searcher | airline.searchFlights (metadata URL) | deny/net.*                   | deny/net.allowDomains                                              | PASS
7    | searcher | airline.searchFlights (example.com)  | deny/net.allowDomains        | deny/net.allowDomains                                              | PASS
8    | searcher | airline.neverAdded                   | deny/rwx.unlisted            | deny/rwx.unlisted                                                  | PASS
9    | searcher | airline.testDeprecatedRead            | throw + stays "w"             | threw: gate.add: ...testDeprecatedRead would LOOSEN "w" -> "r"…    | PASS
11   | searcher | <host>.POST /_/FlightsFrontendUi/...  | allow + 200                   | allow/rwx.allow + 200                                              | PASS
12   | searcher | <host>.POST /graphql                  | deny                           | deny/rwx.denied                                                    | PASS
13   | searcher | airline.legacyFareLookupAllow         | ask -> human allow -> allow   | allow/humanChannel.allow asked=true fetched=200                   | PASS
14   | searcher | airline.legacyFareLookupDeny          | ask -> human deny -> deny     | deny/rwx.ask asked=true                                            | PASS
15   | searcher | airline.legacyFareBooking             | deny, never asked             | deny/rwx.denied asked=false                                        | PASS
16   | searcher | (20 concurrent hotel GETs)             | all 20 allow, none throw      | allAllowed=true anyThrew=false (20 settled)                        | PASS

=== run1 totals: PASS=78 FAIL=0 ===
```

(Step numbering has a deliberate gap at 10 — steps 1-9 are unchanged from the
first pass, 11-15 are this extension's new site-C and loose-marker steps,
and the concurrency test was moved to the end as step 16. 78 = 12 key-format
checks + 14 scenario rows (steps 1-9, 11-16) + the audit replay's own
per-aid re-checks, key-trace checks, and the one-line-per-aid invariant
check, all folded into the same PASS/FAIL counter per the task's "print
PASS/FAIL totals" instruction.)

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

Both full runs of the extended bench (`node harness-code-mode/rwx-e2e.mjs`
invoked twice, independently) produced `PASS=78 FAIL=0`, exit code 0. `npm
test` confirmed 530/530 after the extension too, tree otherwise clean
(`git status --porcelain` shows only `rwx-e2e.mjs` modified and `rwx-e2e.md`
modified — no `src/`/`types/`/`test/`/`package*.json` changes).

## The `rwx.askOn:"loose"` gap (closed this pass)

The first bench pass found that no row rwxmap actually emitted — across
either the airline spec (4 ops) or the two spec-less sites (hotel: 2 ops,
flights-rpc: 2 ops, 8 real classifications total across both passes) — ever
came out `marker: "loose"`. That's not a coincidence to paper over: `loose`
is specifically the PUT/PATCH-method-floor bucket (`reviewHint`'s one
`"loose"` case), and this bench's endpoints are GET/POST/DELETE only, by
design (real API shapes, not hand-picked to force a marker). So real
rwxmap-loose rows would need a PUT/PATCH endpoint in the spec or the
spec-less classifier — a legitimate scope gap in the SITES chosen, not a bug.

Per the coordinator's explicit instruction, this pass hand-writes THREE
labeled synthetic entries directly into `COMMITTED_TOOLS` (each commented
`HAND-WRITTEN`, clearly marked as not-an-rwxmap-export) to exercise
`rwx.askOn:"loose"` for real:

- `airline.legacyFareLookupAllow: {letter:"r", marker:"loose"}` — searcher
  holds `r`; step 13 asserts `humanCallCounts` shows the scripted
  `humanChannel` was ACTUALLY invoked (not just that the final decision was
  allow), then the scripted reply is `allow`, and the resulting `allow`
  decision's `rule` is literally `humanChannel.allow`, then a real fetch
  confirms 200.
- `airline.legacyFareLookupDeny: {letter:"r", marker:"loose"}` — same
  letter, but the scripted `humanChannel` special-cases this exact action
  type to reply `deny`; step 14 asserts the channel was called AND the
  final decision is `deny`.
- `airline.legacyFareBooking: {letter:"w", marker:"loose"}` — searcher
  LACKS `w`; step 15 asserts the decision denies with `rwx.denied` (the
  ordinary insufficient-letter deny, not `rwx.ask`) and that
  `humanCallCounts` has NO entry at all for this type — i.e. `check()`
  never even reached the ask step, confirming rwxCheck's documented order
  (letter check before `askOn`) holds under a real `check()` call, not just
  by reading the source.

All three passed in both runs. `exportGate`'s collision-reporting path
remains unexercised (no two operationIds collided in the airline spec).
