# rwx POC — findings (throwaway, not shipped)

> **Orchestrator re-check (2026-09-21) — two findings override the verdicts below.**
> 1. **Redirect hole (real).** Through the full `RwxGate` + real `Gate`, an `r--`
>    agent is ALLOWED `ls > /home/hamr/.bashrc`, `cat ~/.ssh/id_rsa > /tmp/leak`
>    and `git diff --output=/home/hamr/.bashrc` (rule=`tools.allowlist`).
>    `JOIN_META` omits `>` `>>` `<`, and E-rwx-1's case set (and the design doc's
>    list) has no redirect case. Option-driven writes (`--output=`) are Known
>    Limit #5 but must be stated as "can WRITE", not only "reads any path".
> 2. **E-rwx-4's "5/15 denies" is not a usability number.** 4 of the 5 denies
>    were planted as should-deny steps, and every command ran without args.
>    Realistic commands false-deny as `rwx.joined` because `JOIN_META` matches
>    inside quotes: `git commit -m "fix (typo)"`, `git commit -m "a; b"`,
>    `grep 'a|b' src`, `cat $HOME/x`. The "tolerable" verdict below is unproven.
>
> Not yet fixed: add redirects to the joiner set + E-rwx-1, and redo E-rwx-4
> with realistic argumented commands before any graduation claim.

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

- **E-rwx-1** (19 adversarial bash commands under `r--`): all 19 denied.
  Every joiner (`;` `&&` `||` `|` `$(...)` backtick, newline, `\`
  continuation), env prefix (`FOO=1 cmd`), wrapper (`command`/`exec`/`sudo`/
  `env`/`xargs`), `find -exec`/`-delete`, and `less` all deny — most via
  `rwx.unlisted` (no leading-word match at all, since none of these forms are
  in the starter bash map) or `rwx.joined` (shell-meta present, whole string
  not listed verbatim). A prefix-confusable command (`lsblk` vs an allowed
  `ls`) also correctly denies (`rwx.unlisted`) because the wrapper's
  leading-word match is word-boundary-aware (`cmd === key || cmd.startsWith(key + " ")`),
  not a bare `startsWith`.
- **E-rwx-2**: researcher (`r--`)'s catalog hides `write`/`edit`/
  `github.create_pr`/`deploy`/`wireMoney`; calling each by name anyway denies
  at `check()` with `rwx.denied` (tagged, but the agent lacks the letter) —
  the model never sees the tool, and calling it blind doesn't help it either.
- **E-rwx-3**: an `r-x` "manager" spawning a child that explicitly requests
  `rwx`, five levels deep (each depth's child becomes the next depth's
  parent), never produces a `w`-holding descendant — every depth clamps to
  `r-x`.
- **E-rwx-4**: a realistic fixer (`rw-`) run — read, search, `git status`/
  `diff`, edit, `npm test`, `npm run build`, `git add`/`commit` all complete
  (9/9 core steps). Then it plausibly reaches for `git push`, `npm publish`,
  `deploy` (all tagged `x`, fixer lacks `x`), and `github.create_pr` (tagged
  `w`, fixer holds it → allowed). Two more attempts — `npm install left-pad`
  (untagged) and `rm -rf node_modules` (tagged `x`) — also deny.
  **Usability number: 5 loud denies out of 15 attempted actions**, all of them
  are either genuinely-irreversible actions the agent shouldn't have (push,
  publish, deploy, rm) or an untagged command an operator would add on the
  first real denial. None of the 5 blocked the core edit→test→commit loop.
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

E-rwx-4's deny count (5/15, all either irreversible-by-design or an
easy first-run addition to the file) is tolerable. Per the doc's own
graduation rule ("graduate only if E-rwx-4's deny count is tolerable AND a
real adopter wants the fleet view") — the second half of that condition is
unchanged by this POC: still no adopter ask (per MEMORY.md, idle-by-design).
This POC is evidence toward the first half only.

## Design decisions NOT re-litigated

Followed as settled, no deviation: letter meanings (r=observe, w=reversible
change, x=irreversible change), deny-by-absence (unlisted tool/command/agent
→ deny, unlisted agent → `---`), attenuate-only spawn (child ⊆ parent, no
letter for `spawn` itself), letters never inside a tool, ask stays a separate
`flags` knob (not wired into this POC at all — no asks were exercised),
rwx vs allowlist as two mutually exclusive modes (this POC only ever
constructs rwx-shaped Gates, never mixes in an operator-supplied
`tools.allowlist`/`bash.allow` of its own).

## Nothing escalated

No design decision outside the doc's settled/POC-plan scope was needed to
build or run this. The two POC-level implementation choices worth flagging
(not policy decisions, just this file's own construction):
- The underlying Gate's `bash.allow` is intentionally left unset (wrapper owns
  all bash gating) so E-rwx-5's ablation of `joined`/`leadingword` is clean
  rather than silently backstopped by the library's own SHELL_META check.
- `RWX_DISABLE=unlisted` disables the "tool is unlisted OR letter-insufficient"
  check as one unit (both read as "I cannot get this tool" from the model's
  side) — the doc's guard list only names four guards for E-rwx-5, not five,
  so this POC folds "letter-insufficient" into "unlisted" rather than
  inventing a fifth flag.
