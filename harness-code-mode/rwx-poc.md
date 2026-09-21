# rwx POC — findings (throwaway, not shipped)

> **Status (2026-09-21, second pass).** Both findings from the first
> orchestrator re-check are now addressed in code:
> 1. **Redirect hole — fixed at the wrapper.** `JOIN_META` now includes `>`
>    `<` (covers `>>` and fd forms like `2>`/`&>` too, the latter via the
>    already-present `&`). E-rwx-1 gained four cases run through `gate.check`
>    (not just `matchBash`): `ls > /home/hamr/.bashrc`, `cat ~/.ssh/id_rsa >
>    /tmp/leak`, `cat a >> b`, `grep x < /etc/shadow` — all four now deny
>    (`rwx.joined`). The option-driven write, `git diff --output=/home/hamr/.bashrc`,
>    is NOT fixable by leading-word matching (Known Limit #5, doc line ~465) —
>    no flag parser was built. It is now its own E-rwx-1 case, run and reported
>    as an **expected ALLOW / documented gap**, not a safety PASS. No design
>    decision was made about tagging write-capable-option commands as `r`; see
>    Escalated questions below.
> 2. **E-rwx-4 rebuilt as a 27-item realistic `rw-` session** with real
>    argumented commands (git with messages/paths/flags, npm with flags, sed/
>    head/wc/grep, piping). Deliberately-irreversible actions (`git push`,
>    `npm publish`, `deploy`, `rm -rf node_modules`) were moved OUT of the
>    count into a separate E-rwx-4b, never mixed into the usability number.
>    Result: **15/27 allow, 12/27 deny**, denies split (a) 4 false-deny from
>    `JOIN_META` matching inside quotes or on `$` for env-var expansion
>    (`cat $HOME/.npmrc`, `grep -rn 'foo|bar' src`, two `git commit -m "..."`
>    cases with `(` `)` or `;` inside the message), (b) 7 unlisted-command
>    starter-file gaps (`node`, `npx`, `sed`, `head`, `wc`, `git checkout`,
>    `git stash` — none in the starter `bareguard.rwx.json`), (c) 1 correct
>    deny (`git log | head`, a genuine pipe). See the "Usability verdict"
>    section below for what this number means for graduation.
>
> Also fixed: the runner's exit code. A normal full run used to exit 0 even
> when a baseline E1-E4 check failed, because `!only` made `e5Ran` true and
> skipped the exit-code check entirely. Now `report()` routes calls made
> during E-rwx-5's guard-disabled falsification sub-runs into a separate
> `SUPPRESSED_*` tally (via `withSuppressedCounting`) that never reaches the
> exit code; E5's baseline sub-calls and its own "goes RED" meta-asserts still
> count as real signal. Proven by reverting the redirect fix in a scratch copy
> outside this repo and confirming the full run now exits 1 (11 FAIL) — see
> the handback message for the transcript.

Design doc: `docs/wiki/releases-roadmap.md` lines 353-500 ("rwx: operator-tagged
capability letters for agent fleets", PROPOSED 2026-09-21, not built).
Code: `rwx-poc.mjs` + sample `bareguard.rwx.json`. `src/`, `types/`, `test/`,
`package.json` untouched — this wraps the real `Gate` from outside, through its
public config surface (`tools.allowlist`) only.

## Architecture actually built

- `RwxGate` wraps one real `Gate` per agent (or spawned child). Every action is
  checked at the wrapper level FIRST (`_rwxDecision`): unlisted agent → `---`;
  untagged/under-permissioned tool or bash command → structured `rwx.*` deny.
  If the wrapper allows it, the call is **also** run through the real `Gate`,
  whose `tools.allowlist` is built from the same letters — the "two places,
  both required" enforcement the doc calls for (hide + backstop).
- **Bash gating is entirely wrapper-owned.** The underlying Gate's own
  `bash.allow`/shell-metacharacter protection was deliberately left
  unconfigured (the "bash" action type is always in the underlying
  `tools.allowlist`), so falsifying the wrapper's own joined/leading-word
  guards (E-rwx-5) is a clean ablation and not silently backstopped by a
  second, independent bareguard mechanism. Non-bash tools use the underlying
  `tools.allowlist` as the real backstop.
- Spawn clamp (e) is pure wrapper arithmetic — `min` per letter of
  (requested, parent's own letters) — run in the parent, no Gate involvement.

## Evidence produced

Run `node harness-code-mode/rwx-poc.mjs` for the full suite, or
`node harness-code-mode/rwx-poc.mjs e1` (…`e2`…`e5`) for one case.
`RWX_DISABLE=<guard[,guard]>` (guards: `unlisted`, `joined`, `leadingword`,
`clamp`) disables one guard for a standalone run.

- **E-rwx-1** (23 adversarial bash commands under `r--`): all 23 denied, plus
  one documented known limit. Every joiner (`;` `&&` `||` `|` `$(...)`
  backtick, newline, `\` continuation), the four redirect forms (`>` overwrite,
  `>` exfil, `>>` append, `<` input), env prefix (`FOO=1 cmd`), wrapper
  (`command`/`exec`/`sudo`/`env`/`xargs`), `find -exec`/`-delete`, and `less`
  all deny — most via `rwx.unlisted` (no leading-word match at all, since none
  of these forms are in the starter bash map) or `rwx.joined` (shell-meta
  present, whole string not listed verbatim — `JOIN_META` now includes `>`/`<`).
  A prefix-confusable command (`lsblk` vs an allowed `ls`) also correctly
  denies (`rwx.unlisted`) because the wrapper's leading-word match is
  word-boundary-aware (`cmd === key || cmd.startsWith(key + " ")`), not a bare
  `startsWith`. Separately, `git diff --output=/home/hamr/.bashrc` is run as a
  **known-limit case**: it ALLOWS (leading-word matching tags `git diff` as
  `r`; the `--output=` flag turns it into a write) — reported loudly as a
  confirmed, documented gap (Known Limit #5), not folded into the "all denied"
  count.
- **E-rwx-2**: researcher (`r--`)'s catalog hides `write`/`edit`/
  `github.create_pr`/`deploy`/`wireMoney`; calling each by name anyway denies
  at `check()` with `rwx.denied` (tagged, but the agent lacks the letter) —
  the model never sees the tool, and calling it blind doesn't help it either.
- **E-rwx-3**: an `r-x` "manager" spawning a child that explicitly requests
  `rwx`, five levels deep (each depth's child becomes the next depth's
  parent), never produces a `w`-holding descendant — every depth clamps to
  `r-x`.
- **E-rwx-4**: a realistic fixer (`rw-`) coding session — 27 items with real
  arguments (`git commit -m "..."`, `git diff HEAD~1 -- src/`, `npm test --
  --grep auth`, `grep -rn 'foo|bar' src`, `sed -n 1,40p src/a.js`, `git log |
  head`, etc.), deliberately excluding irreversible actions from the count
  (see E-rwx-4b). **Result: 15/27 allow, 12/27 deny.** The 12 denies split:
  - **(a) 4 false denies** from `JOIN_META` matching a character that is safe
    in context — inside quotes (`git commit -m "fix (typo) in parser"`,
    `git commit -m "a; b"`, `grep -rn 'foo|bar' src`) or a `$` used for
    env-var expansion, not command substitution (`cat $HOME/.npmrc`).
  - **(b) 7 unlisted-command starter-file gaps** — `node`, `npx`, `sed`,
    `head`, `wc`, `git checkout`, `git stash` are simply absent from the
    sample `bareguard.rwx.json`'s bash map, so they deny `rwx.unlisted`; an
    operator would add each on first real hit.
  - **(c) 1 correct deny** — `git log | head` is a genuine pipe (chains to a
    second program) and denies per the doc's own settled joined-command rule.

  Every classification above was predicted before running and asserted to
  match the actual outcome (`report()` in `runE4`), so this is not a hand-wave
  count. Separately, **E-rwx-4b** (not part of the 27): `git push`, `npm
  publish`, `deploy`, `rm -rf node_modules` all correctly deny under `rw-` —
  reported, but never mixed into the usability number.

  **Opinion (not a decision):** the 4 false denies in (a) are all one root
  cause — `JOIN_META` scans the raw string, so any of its characters inside a
  quoted argument trips it. A quote-aware scanner (strip single/double-quoted
  spans before testing for shell metacharacters) would remove all 4 without
  weakening the joined-command deny itself. This POC does not build one — it
  would need its own adversarial testing (nested quotes, escaped quotes) and
  is a real scope increase, not a one-line fix.
- **E-rwx-5** (falsify each guard, confirm the paired case goes red — full
  transcript below):
  - `RWX_DISABLE=unlisted` → E-rwx-2 goes red: all 5 previously-hidden tools
    (`deploy`, `write`, `edit`, `github.create_pr`, `wireMoney`) are now
    **allowed** (`rule=tools.allowlist`), and the catalog stops hiding
    anything.
  - `RWX_DISABLE=joined` → E-rwx-1 goes red: cases whose leading word still
    matches a listed prefix before the joiner (`git status && …`, `cat file |
    sh`, `ls $(…)`, `` ls `…` ``, the `\` continuation) are now **allowed**
    once the wrapper stops treating shell-meta as disqualifying — several of
    those are then independently caught anyway by the real Gate's own
    always-on content safe-defaults (`content.denyPatterns` catches the
    literal `rm -rf /` bytes), which is a genuine second layer, not a
    wrapper artifact; the pipe case (`cat file | sh`) has no such literal and
    goes fully through (`rule=tools.allowlist`, i.e. ALLOWED).
  - `RWX_DISABLE=leadingword` → E-rwx-1 goes red harder: with no leading-word
    restriction at all, most cases pass straight to the real Gate; some are
    still caught by its content safe-defaults (`rm -rf /` literal), but
    `cat file | sh`, `find … -exec …`, `less /etc/passwd`, and `lsblk` all
    fully allow (`rule=tools.allowlist`).
  - `RWX_DISABLE=clamp` → E-rwx-3 goes red: every depth 1-5 child ends up
    holding the full `rwx` it requested, confirming the clamp (not some
    incidental default) is what produced the `r-x` ceiling in the normal run.
  - Baseline (no guard disabled): all of E-rwx-1/2/3 stay green.

Full output of the normal run and each disabled run is pasted in the handback
message (not duplicated here) — this file is the interpretive summary.

## Open questions (doc lines ~470-480) — what the POC tells us

1. **Trusted channel for a child's letters.** EVIDENCE: not answered by this
   POC — no real transport was built. The POC's clamp is in-process JS
   (`RwxGate#spawnChild` returns a new in-memory instance); it says nothing
   about how letters would cross a process/RPC boundary the way
   `BAREGUARD_SPAWN_DEPTH` does today. OPINION: whatever channel carries depth
   today (env var / config field, parent-authored) is the natural place to
   also carry letters, but this POC doesn't validate an env-var-based version
   — flagging as unresolved, not deciding it.
2. **Bash edge forms — deny all as joined?** EVIDENCE: in this POC, env
   prefixes / wrappers (`sudo`, `exec`, `command`, `env`, `xargs`) / `find
   -exec`/`-delete` / pagers all deny WITHOUT needing to be classified as
   "joined" — they simply never match any leading-word entry in the starter
   file (`rwx.unlisted`), because "deny by absence" (settled) already covers
   them. Only the literal shell-meta joiners (`;` `&&` `||` `|` `$(...)`
   backtick/newline/`\`) needed the separate `rwx.joined` rule. So: composing
   the two ALREADY-SETTLED rules (leading-word match + deny-by-absence)
   answers this open question for a STARTER file that (per the doc) leaves
   wrapper programs out — no third rule needed. OPINION: this is fragile
   evidence, not a proof — it holds only because the starter file's bash map
   is narrow; an operator who tags `find` as `r` (a very plausible real
   choice) reopens `find -exec` as a live gap, which is exactly the doc's
   "Known limit" #5 ("bash leading-word matching is not a parser").
3. **Starter file contents.** EVIDENCE: this POC's `bareguard.rwx.json` is
   original for the POC (extends the doc's own sketch with `search`, `git
   diff`, `npm run build`, `npm publish` for a realistic E-rwx-4 run) — not
   evidence about what bareguard's real shipped starter file should contain,
   just a demonstration sample.
4. **`fetch` GET vs POST.** EVIDENCE: not exercised — this POC has no `fetch`
   tool in its catalog at all. No evidence either way.
5. **Does bareguard load the file itself?** EVIDENCE: this POC's wrapper
   (`loadRwxConfig`) does the file I/O and JSON.parse itself, outside
   bareguard; the real `Gate` never sees a file path, only derived
   `tools.allowlist` arrays. Consistent with "all config is a JS object
   today" (doc's own framing) — this POC took the "caller loads it" branch,
   not the "bareguard loads it" branch, and offers no evidence for which one
   a real implementation should pick.

## Usability verdict (graduation gate from the doc)

The first, unrevised pass called E-rwx-4's 5/15 denies "tolerable" — that
number was wrong (4 of the 5 were planted irreversible-action attempts, and
every command ran without arguments, so it never exercised quoting at all).
The rebuilt 27-item realistic session gives an honest number: **12/27 (44%)
deny**, but only 1 of those 12 is a correct deny of a genuinely unsafe-shaped
construct (a pipe). The other 11 are not "the agent tried something it
shouldn't" — they are either a first-run starter-file gap (7, trivially fixed
by an operator adding the command once) or a false positive from the joiner
regex matching inside quotes/env-vars (4, would need the quote-aware scan
described above as an opinion, not built here).

Read plainly: **read, search, status, diff, edit, add, test, build and
github.create_pr all completed — but the commit step did not: BOTH `git commit`
attempts in the run were false-denied** (`-m "fix (typo) in parser"`,
`-m "a; b"`), so under this starter file the edit→test→commit loop does NOT
finish whenever the message carries `( ) ; | $`. The other blocks are
peripheral (log paging, npm/node tooling beyond test/build).
(Correction by the orchestrator re-check: an earlier draft of this paragraph
said the core loop "never gets blocked".) Whether an 11/27 rate of
false-deny-or-gap on a *starter* file is "tolerable" is a judgment call this
POC doesn't make for the operator — it's evidence, not a verdict. Per the
doc's own graduation rule ("graduate only if E-rwx-4's deny count is tolerable
AND a real adopter wants the fleet view") — the second half is unchanged by
this POC: still no adopter ask (per MEMORY.md, idle-by-design). This POC
supplies real (not hand-waved) evidence toward the first half only, and that
evidence is more mixed than the original pass claimed.

## Design decisions NOT re-litigated

Followed as settled, no deviation: letter meanings (r=observe, w=reversible
change, x=irreversible change), deny-by-absence (unlisted tool/command/agent
→ deny, unlisted agent → `---`), attenuate-only spawn (child ⊆ parent, no
letter for `spawn` itself), letters never inside a tool, ask stays a separate
`flags` knob (not wired into this POC at all — no asks were exercised),
rwx vs allowlist as two mutually exclusive modes (this POC only ever
constructs rwx-shaped Gates, never mixes in an operator-supplied
`tools.allowlist`/`bash.allow` of its own).

## Escalated questions

1. **Should a command with a write-capable OPTION (e.g. `git diff --output=`)
   ever be tagged something other than its normal read letter?** This POC
   does NOT propose "never tag a command with write-capable options as `r`" —
   that would need either a per-flag allow/deny list (a flag parser, out of
   POC scope and rejected by the task brief) or blanket-denying an entire
   command family (`git diff` outright) that is overwhelmingly used safely.
   Known Limit #5 already names this as a stated, permanent limit of
   leading-word matching, not a bug to fix. Flagging it as a question rather
   than deciding it, since it is a real, live gap and any of the fixes has a
   design cost (config surface, false-deny rate, or scope of what "tagging by
   leading word" even means).
2. Is an 11/27 false-deny-or-gap rate against a **starter** file (see
   Usability verdict) tolerable enough to graduate, given that commits with
   punctuated messages are false-denied? Left to the operator/adopter side of the doc's own
   graduation rule — not decided here.

## Nothing else escalated

No other design decision outside the doc's settled/POC-plan scope was needed
to build or run this. The two POC-level implementation choices worth flagging
(not policy decisions, just this file's own construction):
- The underlying Gate's `bash.allow` is intentionally left unset (wrapper owns
  all bash gating) so E-rwx-5's ablation of `joined`/`leadingword` is clean
  rather than silently backstopped by the library's own SHELL_META check.
- `RWX_DISABLE=unlisted` disables the "tool is unlisted OR letter-insufficient"
  check as one unit (both read as "I cannot get this tool" from the model's
  side) — the doc's guard list only names four guards for E-rwx-5, not five,
  so this POC folds "letter-insufficient" into "unlisted" rather than
  inventing a fifth flag.
