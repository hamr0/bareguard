// rwx-poc.mjs — THROWAWAY proof-of-concept for the "rwx: operator-tagged
// capability letters for agent fleets" design (PROPOSED 2026-09-21, not built).
// Design doc: docs/wiki/releases-roadmap.md lines 353-500 (bareguard-prd.md:1286-1420).
//
// Wraps today's real `Gate` FROM OUTSIDE via its public config surface only
// (`tools.allowlist`, `bash.allow`) — no import from src/primitives/*, no
// library change. This file is not shipped; per the design's own POC plan
// (bareguard-prd.md:1402-1412) it lives only in harness-code-mode/ and is
// never promoted verbatim into src/.
//
// What it implements (letters a-e per the task brief):
//   (a) loads a sample bareguard.rwx.json (agents / tools / bash maps)
//   (b) filters a tool catalog per agent via gate.allows
//   (c) denies unlisted tools/commands/agents loudly (rwx.unlisted)
//   (d) matches bash leading words; denies joined commands unless listed exactly
//   (e) clamps a child's letters on spawn (child = intersection with parent;
//       clamp runs in the PARENT)
//
// Falsification: set RWX_DISABLE to a comma-separated subset of
// {unlisted, joined, leadingword, clamp} to turn off that one guard and watch
// the corresponding E-case go red (see runE5 below).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Gate } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config loading (OQ5 evidence: the POC LOADS the file itself with plain
// fs+JSON.parse — bareguard the library never sees a file path, only the
// parsed allowlist arrays this wrapper derives from it. See rwx-poc.md OQ5.)
// ---------------------------------------------------------------------------

export function loadRwxConfig(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`rwx config at ${filePath} must be a JSON object`);
  }
  const agents = parsed.agents ?? {};
  const tools = parsed.tools ?? {};
  const bash = parsed.bash ?? {};
  for (const [k, v] of [...Object.entries(agents), ...Object.entries(tools), ...Object.entries(bash)]) {
    if (typeof v !== "string" || !/^[r-][w-][x-]$|^[rwx-]$/.test(v)) {
      throw new Error(`rwx config: "${k}" has an invalid letter value ${JSON.stringify(v)}`);
    }
  }
  return { agents, tools, bash };
}

// ---------------------------------------------------------------------------
// Falsification switch. RWX_DISABLE=unlisted,joined,leadingword,clamp
// ---------------------------------------------------------------------------

function disabledGuards() {
  return new Set(
    (process.env.RWX_DISABLE ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function hasLetter(letters, ch) {
  return typeof letters === "string" && letters.includes(ch);
}

// Shell-control metacharacters that chain, substitute, redirect, or continue a
// command onto more than one program. Mirrors the doc's settled joined-command
// list: `;` `&&` `||` `|` `$(...)` backticks, newline, `\` continuation, AND
// redirects (`>` `>>` `<`, including fd forms like `2>` `&>` — the doc's own
// bash list names "redirects" explicitly, bareguard-prd.md:1340-1345). Found
// missing in the orchestrator re-check (2026-09-21): without `>`/`<` here, an
// `r--` agent could run `cat ~/.ssh/id_rsa > /tmp/leak` and have it treated as
// a plain leading-word `cat` read.
// (own copy — deliberately NOT importing src/primitives/bash.js's SHELL_META,
// since this wrapper only reaches Gate through its public config surface).
const JOIN_META = /[;&|$`()\n\r\\<>]/;

/**
 * Rule (d): match a bash command's LEADING WORD(S) against the rwx bash map,
 * longest listed prefix wins; a joined/chained command denies unless the
 * WHOLE string is listed exactly.
 * @returns {{ok:boolean, letter:?string, matchedKey:?string, joined:boolean}}
 */
export function matchBash(cmd, bashMap, disabled) {
  const exactLetter = bashMap[cmd];
  const hasJoiner = JOIN_META.test(cmd);
  if (hasJoiner && !disabled.has("joined")) {
    // Joined/chained — denied unless the FULL string is listed verbatim.
    if (exactLetter) return { ok: true, letter: exactLetter, matchedKey: cmd, joined: false };
    return { ok: false, letter: null, matchedKey: null, joined: true };
  }
  // Longest-prefix leading-word match, word-boundary aware (prefix must be
  // followed by end-of-string or a space) so "ls" cannot match "lsblk".
  let best = null;
  for (const key of Object.keys(bashMap)) {
    if (cmd === key || cmd.startsWith(key + " ")) {
      if (!best || key.length > best.length) best = key;
    }
  }
  if (best) return { ok: true, letter: bashMap[best], matchedKey: best, joined: false };
  return { ok: false, letter: null, matchedKey: null, joined: false };
}

function rwxDeny(rule, reason) {
  return {
    outcome: "deny",
    error: { type: "policy_denied", rule, severity: "action", reason },
  };
}

/**
 * RwxGate — wraps a real `Gate` from outside. One instance per agent (or per
 * spawned child). The rwx letter check ALWAYS runs before the underlying Gate
 * is consulted (deny-by-absence at the wrapper), but the underlying Gate's
 * `tools.allowlist` / `bash.allow` are ALSO built from the same letters, so
 * the real enforcement backstop (structural — a model can call a hidden tool
 * by name) is the real library, not just wrapper bookkeeping. Design ref:
 * "Enforcement — two places, both required" (bareguard-prd.md:1333-1339).
 */
export class RwxGate {
  constructor({ rwxConfig, agentName, letters, spawnDepth = 0, parentRunId = null, disabled }) {
    this.rwxConfig = rwxConfig;
    this.agentName = agentName;
    this.disabled = disabled ?? disabledGuards();
    // Deny by absence (settled): an unlisted agent gets "---" — it starts,
    // every action denies.
    if (letters != null) {
      this.letters = letters;
      this.agentListed = true; // spawned child; its identity is the clamp, not the map
    } else {
      this.agentListed = Object.prototype.hasOwnProperty.call(rwxConfig.agents, agentName);
      this.letters = this.agentListed ? rwxConfig.agents[agentName] : "---";
    }
    this.spawnDepth = spawnDepth;

    // Bash gating is entirely wrapper-owned (rule d, "two rules only,
    // settled") — the underlying Gate's own `bash.allow`/SHELL_META
    // protection is deliberately NOT layered on top of it, so that disabling
    // the wrapper's "joined"/"leadingword" guards (E-rwx-5) is a clean
    // ablation rather than being masked by a second, independent mechanism.
    // "bash" is therefore always in the underlying tools.allowlist; every
    // bash decision is made by `_rwxDecision` before the underlying Gate is
    // ever consulted for a bash action.
    //
    // Non-bash tools are the "unlisted" guard's (c) domain: when disabled,
    // this wrapper fully opens the underlying allowlist too, so the
    // falsification isn't masked by the tools.allowlist backstop either.
    const allowedTools = this.disabled.has("unlisted")
      ? [...Object.keys(rwxConfig.tools), "bash"]
      : [...Object.entries(rwxConfig.tools)
          .filter(([, letter]) => hasLetter(this.letters, letter))
          .map(([name]) => name), "bash"];

    this._gate = new Gate({
      audit: { path: null }, // fileless — throwaway POC, no artifacts on disk
      runId: `rwx-${agentName}-${spawnDepth}-${Math.random().toString(36).slice(2, 8)}`,
      parentRunId,
      spawnDepth,
      tools: { allowlist: allowedTools },
      humanChannel: async (event) => ({ decision: "deny", reason: "rwx-poc: no human channel wired" }),
    });
  }

  async init() {
    await this._gate.init();
  }

  /** Rule (b): filter a tool catalog down to what this agent's letters cover. */
  catalog(toolNames) {
    if (this.disabled.has("unlisted")) return [...toolNames]; // falsification: nothing hidden
    return toolNames.filter((name) => {
      const letter = this.rwxConfig.tools[name];
      return letter != null && hasLetter(this.letters, letter);
    });
  }

  /** Rule-level decision WITHOUT touching the underlying Gate (pure query). */
  _rwxDecision(action) {
    if (!this.agentListed) {
      return rwxDeny("rwx.unlisted", `agent "${this.agentName}" is not in bareguard.rwx.json — it holds "---"`);
    }
    if (action.type === "bash") {
      const cmd = action.args?.command ?? action.cmd ?? "";
      if (this.disabled.has("leadingword")) return null; // falsification: no matching at all, defer straight to Gate (which now allows any "bash")
      const m = matchBash(cmd, this.rwxConfig.bash, this.disabled);
      if (m.joined) {
        return rwxDeny(
          "rwx.joined",
          `"${cmd}" contains a joined/chained shell construct and is not listed verbatim in bareguard.rwx.json`,
        );
      }
      if (!m.ok) {
        return rwxDeny("rwx.unlisted", `"${cmd}" is not in bareguard.rwx.json — add it as r, w or x`);
      }
      if (!hasLetter(this.letters, m.letter)) {
        return rwxDeny(
          "rwx.denied",
          `"${cmd}" is tagged "${m.letter}" but agent "${this.agentName}" only holds "${this.letters}"`,
        );
      }
      return null; // defer to the underlying Gate (bash unconditionally in its tools.allowlist)
    }
    // Non-bash tool: the "unlisted" guard (c) governs BOTH "not in the file at
    // all" and "tagged but this agent lacks the letter" — from the model's
    // point of view both are simply "I cannot get this tool," so disabling
    // guard (c) removes the wrapper-level check for both, matching how
    // `allowedTools` above is also fully opened when this guard is disabled.
    if (this.disabled.has("unlisted")) return null;
    const letter = this.rwxConfig.tools[action.type];
    if (letter == null) {
      return rwxDeny("rwx.unlisted", `"${action.type}" is not in bareguard.rwx.json — add it as r, w or x`);
    }
    if (!hasLetter(this.letters, letter)) {
      return rwxDeny("rwx.denied", `"${action.type}" is tagged "${letter}" but agent "${this.agentName}" only holds "${this.letters}"`);
    }
    return null;
  }

  /** Pure query mirror of Gate#allows. */
  async allows(actionOrName) {
    const action = typeof actionOrName === "string" ? { type: actionOrName } : actionOrName;
    const rwx = this._rwxDecision(action);
    if (rwx) return false;
    return this._gate.allows(action);
  }

  /** Main entry — mirrors Gate#check's shape ({outcome, rule, reason, ...}). */
  async check(action) {
    const rwx = this._rwxDecision(action);
    if (rwx) return { outcome: "deny", severity: "action", rule: rwx.error.rule, reason: rwx.error.reason };
    return this._gate.check(action);
  }

  /**
   * Rule (e) — spawn clamp. Runs IN THE PARENT (this instance), per the design
   * ("the clamp must run in the parent's gate at spawn time (a child cannot
   * verify its parent)", bareguard-prd.md:1392-1401). Attenuate-only:
   * child = min(requested, parent's own letters), never wider.
   */
  spawnChild(childAgentName, requestedLetters = "rwx") {
    const clamp = this.disabled.has("clamp")
      ? requestedLetters // falsification: no attenuation at all
      : "rwx"
          .split("")
          .map((ch) => (hasLetter(this.letters, ch) && hasLetter(requestedLetters, ch) ? ch : "-"))
          .join("");
    return new RwxGate({
      rwxConfig: this.rwxConfig,
      agentName: childAgentName,
      letters: clamp,
      spawnDepth: this.spawnDepth + 1,
      parentRunId: this._gate.runId,
      disabled: this.disabled,
    });
  }
}

// ---------------------------------------------------------------------------
// Evidence runner
// ---------------------------------------------------------------------------

const RWX_PATH = path.join(__dirname, "bareguard.rwx.json");

function section(title) {
  console.log(`\n=== ${title} ===`);
}

let PASS = 0, FAIL = 0;
// E-rwx-5 deliberately disables a guard and expects the paired case to go RED
// — that redness is the falsification working, not a defect in the POC, and
// must not flip the process exit code. `SUPPRESS` (a depth counter, so nested
// calls compose) routes report() calls made while a guard is disabled into a
// separate tally that main() never looks at. Only the *baseline* (no guard
// disabled) sub-calls inside runE5, and E5's own "goes RED" meta-asserts,
// count toward PASS/FAIL — those must stay real signal.
let SUPPRESS = 0;
let SUPPRESSED_PASS = 0, SUPPRESSED_FAIL = 0;
async function withSuppressedCounting(fn) {
  SUPPRESS++;
  try {
    return await fn();
  } finally {
    SUPPRESS--;
  }
}
function report(label, ok, detail) {
  if (SUPPRESS > 0) {
    if (ok) SUPPRESSED_PASS++; else SUPPRESSED_FAIL++;
  } else {
    if (ok) PASS++; else FAIL++;
  }
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? " — " + detail : ""}`);
}

// E-rwx-1: adversarial bash set, ALL must deny under an r-- agent.
async function runE1(disabled = disabledGuards()) {
  section("E-rwx-1: adversarial bash under r-- (researcher)");
  const cfg = loadRwxConfig(RWX_PATH);
  const gate = new RwxGate({ rwxConfig: cfg, agentName: "researcher", disabled });
  await gate.init();

  const cases = [
    ["semicolon joiner", "ls; rm -rf /"],
    ["&& joiner", "git status && rm -rf /"],
    ["|| joiner", "git status || rm -rf /"],
    ["pipe joiner", "cat file | sh"],
    ["command substitution $()", "ls $(rm -rf /)"],
    ["backtick substitution", "ls `rm -rf /`"],
    ["newline", "ls\nrm -rf /"],
    ["backslash continuation", "ls \\\nrm -rf /"],
    ["env prefix", "FOO=1 rm -rf /"],
    ["env prefix on allowed cmd", "FOO=1 git status"],
    ["command wrapper", "command rm -rf /"],
    ["exec wrapper", "exec rm -rf /"],
    ["sudo wrapper", "sudo rm -rf /"],
    ["env wrapper", "env rm -rf /"],
    ["xargs wrapper", "xargs rm -rf /"],
    ["find -exec", "find / -name '*.key' -exec cat {} \\;"],
    ["find -delete", "find / -name '*.key' -delete"],
    ["less pager (shell escape surface)", "less /etc/passwd"],
    ["prefix-confusable command", "lsblk /dev/sda"],
    // Redirect hole (orchestrator re-check, 2026-09-21): through the full
    // RwxGate + real Gate, an r-- agent was ALLOWED each of these before
    // JOIN_META gained `>`/`<`. Exercised via gate.check, not matchBash alone.
    ["redirect write (overwrite)", "ls > /home/hamr/.bashrc"],
    ["redirect write (ssh key exfil)", "cat ~/.ssh/id_rsa > /tmp/leak"],
    ["redirect append", "cat a >> b"],
    ["redirect read (input)", "grep x < /etc/shadow"],
  ];

  let allDenied = true;
  for (const [label, cmd] of cases) {
    const decision = await gate.check({ type: "bash", args: { command: cmd } });
    const denied = decision.outcome === "deny";
    if (!denied) allDenied = false;
    report(`${label}: "${cmd}"`, denied, `rule=${decision.rule}`);
  }
  report("ALL adversarial bash denied under r--", allDenied);

  // Known Limit #5 (doc line ~465-466): "bash leading-word matching is not a
  // parser." An option-driven write (`--output=`) cannot be fixed by leading-
  // word matching without inventing a flag parser (out of scope — escalated,
  // not decided, in rwx-poc.md). This case is EXPECTED TO ALLOW: it documents
  // a real, stated gap, not a safety PASS. It is reported separately and does
  // NOT feed into `allDenied` above.
  const knownLimitCmd = "git diff --output=/home/hamr/.bashrc";
  const kl = await gate.check({ type: "bash", args: { command: knownLimitCmd } });
  const klAllowed = kl.outcome === "allow";
  console.log(
    `  [KNOWN LIMIT #5] "${knownLimitCmd}" — leading-word matching tags "git diff" as r, ` +
      `but --output= makes this a WRITE. Outcome: ${klAllowed ? "ALLOWED (gap confirmed, as documented)" : `DENIED — rule=${kl.rule}`}`,
  );
  report("Known Limit #5 (option-driven write) reproduces as documented (expected ALLOW, not a safety claim)", klAllowed);

  return allDenied;
}

// E-rwx-2: a tool hidden from the catalog, called by name anyway, denies at check.
async function runE2(disabled = disabledGuards()) {
  section("E-rwx-2: hidden tool called anyway denies at check");
  const cfg = loadRwxConfig(RWX_PATH);
  const gate = new RwxGate({ rwxConfig: cfg, agentName: "researcher", disabled });
  await gate.init();

  const fullCatalog = Object.keys(cfg.tools);
  const visible = gate.catalog(fullCatalog);
  const hidden = fullCatalog.filter((t) => !visible.includes(t));
  report("catalog hides deploy/write/edit/github.create_pr/wireMoney from researcher (r--)",
    hidden.includes("deploy") && hidden.includes("write") && hidden.includes("wireMoney"),
    `visible=[${visible}] hidden=[${hidden}]`);

  // Fixed expected set (not derived from `hidden`, which is trivially empty
  // once the "unlisted" guard is disabled and the catalog stops hiding
  // anything) — under an UNMODIFIED config, researcher (r--) does not hold
  // any of these; the check-time backstop must deny each one regardless of
  // whether the catalog step ever ran.
  const sensitiveTools = ["deploy", "write", "edit", "github.create_pr", "wireMoney"];
  let ok = true;
  for (const tool of sensitiveTools) {
    const decision = await gate.check({ type: tool, args: {} });
    const denied = decision.outcome === "deny";
    if (!denied) ok = false;
    report(`hidden tool "${tool}" called by name anyway`, denied, `rule=${decision.rule}`);
  }
  report("ALL hidden tools deny when called by name", ok);
  return ok;
}

// E-rwx-3: an r-x parent cannot produce a child holding w, at any depth.
async function runE3(disabled = disabledGuards()) {
  section("E-rwx-3: r-x parent cannot produce a w child (depths 1..5)");
  const cfg = loadRwxConfig(RWX_PATH);
  let parent = new RwxGate({ rwxConfig: cfg, agentName: "manager-rx", letters: "r-x", disabled });
  await parent.init();

  let ok = true;
  for (let depth = 1; depth <= 5; depth++) {
    const child = parent.spawnChild(`helper-d${depth}`, "rwx"); // child ASKS for everything
    await child.init();
    const hasW = hasLetter(child.letters, "w");
    if (hasW) ok = false;
    report(`depth ${depth}: child requesting "rwx" from parent "r-x" ends up "${child.letters}"`, !hasW);
    parent = child; // chain: each depth's parent is the previous depth's child
  }
  report("no depth ever produces a w-holding child", ok);
  return ok;
}

// E-rwx-4: realistic coding-agent session under rw- (fixer). The usability
// number is how a STARTER file performs against commands a real agent
// actually emits with real arguments — NOT a count that includes deliberately
// planted irreversible actions (those are exercised separately below, in
// E-rwx-4b, and do not feed the usability split).
//
// Each script item is pre-classified by static read of matchBash/JOIN_META
// against the actual starter file, into exactly one of:
//   allow         — should and does complete
//   correct-deny  — a genuine chaining/joining construct (e.g. a pipe),
//                   correctly denied under the doc's settled joined-command rule
//   false-deny    — denied only because JOIN_META fires on a character that
//                   is safe here (inside quotes, or `$` for env-var expansion,
//                   not command substitution) — a real false positive
//   gap           — denied because the leading word isn't in the starter file
//                   at all — a first-run addition an operator would make
// report() below asserts the ACTUAL outcome matches this prediction, so a
// PASS here means "the POC's classification is correct," not "nothing denies."
async function runE4(disabled = disabledGuards()) {
  section("E-rwx-4: realistic rw- coding session (usability count)");
  const cfg = loadRwxConfig(RWX_PATH);
  const gate = new RwxGate({ rwxConfig: cfg, agentName: "fixer", disabled });
  await gate.init();

  const script = [
    ["allow", { type: "read", args: { path: "src/gate.js" } }, "read src/gate.js"],
    ["allow", { type: "search", args: { q: "TODO" } }, "search TODO"],
    ["allow", { type: "bash", args: { command: "git status" } }, "git status"],
    ["allow", { type: "bash", args: { command: "git diff" } }, "git diff"],
    ["allow", { type: "bash", args: { command: "git diff HEAD~1 -- src/" } }, "git diff HEAD~1 -- src/"],
    ["allow", { type: "bash", args: { command: "git diff --stat" } }, "git diff --stat"],
    ["allow", { type: "bash", args: { command: "git log --oneline -5" } }, "git log --oneline -5"],
    ["correct-deny", { type: "bash", args: { command: "git log | head" } }, "git log | head"],
    ["allow", { type: "bash", args: { command: "ls -la src" } }, "ls -la src"],
    ["false-deny", { type: "bash", args: { command: "cat $HOME/.npmrc" } }, "cat $HOME/.npmrc"],
    ["false-deny", { type: "bash", args: { command: "grep -rn 'foo|bar' src" } }, "grep -rn 'foo|bar' src"],
    ["allow", { type: "edit", args: { path: "src/gate.js", patch: "..." } }, "edit src/gate.js"],
    ["allow", { type: "bash", args: { command: "git add src/x.js test/x.test.js" } }, "git add src/x.js test/x.test.js"],
    ["false-deny", { type: "bash", args: { command: 'git commit -m "fix (typo) in parser"' } }, 'git commit -m "fix (typo) in parser"'],
    ["false-deny", { type: "bash", args: { command: 'git commit -m "a; b"' } }, 'git commit -m "a; b"'],
    ["allow", { type: "bash", args: { command: "npm test" } }, "npm test"],
    ["allow", { type: "bash", args: { command: "npm test -- --grep auth" } }, "npm test -- --grep auth"],
    ["allow", { type: "bash", args: { command: "npm run build" } }, "npm run build"],
    ["gap", { type: "bash", args: { command: "node scripts/x.mjs" } }, "node scripts/x.mjs"],
    ["gap", { type: "bash", args: { command: "npx tsc --noEmit" } }, "npx tsc --noEmit"],
    ["gap", { type: "bash", args: { command: "sed -n 1,40p src/a.js" } }, "sed -n 1,40p src/a.js"],
    ["gap", { type: "bash", args: { command: "head -50 README.md" } }, "head -50 README.md"],
    ["gap", { type: "bash", args: { command: "wc -l src/*.js" } }, "wc -l src/*.js"],
    ["gap", { type: "bash", args: { command: "git checkout -b fix/x" } }, "git checkout -b fix/x"],
    ["gap", { type: "bash", args: { command: "git stash" } }, "git stash"],
    ["allow", { type: "bash", args: { command: "cat README.md" } }, "cat README.md"],
    ["allow", { type: "github.create_pr", args: {} }, "github.create_pr"],
  ];

  const buckets = { allow: [], "correct-deny": [], "false-deny": [], gap: [] };
  let classificationOk = true;
  for (const [expected, action, desc] of script) {
    const decision = await gate.check(action);
    const actualAllow = decision.outcome === "allow";
    const expectAllow = expected === "allow";
    const matches = actualAllow === expectAllow;
    if (!matches) classificationOk = false;
    buckets[expected].push({ desc, decision });
    console.log(
      `  [${actualAllow ? "ALLOW" : "DENY "}] (${expected}) ${desc}` +
        (actualAllow ? "" : ` — rule=${decision.rule}`),
    );
  }
  report("every E-rwx-4 step's outcome matches its predicted classification", classificationOk);

  const total = script.length;
  const allowed = buckets.allow.length;
  const deniedTotal = total - allowed;
  const falseDeny = buckets["false-deny"].length;
  const gapDeny = buckets.gap.length;
  const correctDeny = buckets["correct-deny"].length;

  console.log(`\n  usability split — total=${total} allowed=${allowed} denied=${deniedTotal}`);
  console.log(`    (a) false deny from quoting/metachar matching: ${falseDeny}`);
  console.log(`    (b) unlisted command (starter-file gap): ${gapDeny}`);
  console.log(`    (c) correct deny (genuine chaining construct): ${correctDeny}`);

  // E-rwx-4b: irreversible actions this rw- agent correctly can never reach.
  // Reported SEPARATELY and NOT counted in the usability split above — per
  // the task, planted should-deny steps do not belong in a usability number.
  section("E-rwx-4b: irreversible actions correctly denied (separate from the usability count)");
  const irreversible = [
    { type: "bash", args: { command: "git push" } },
    { type: "bash", args: { command: "npm publish" } },
    { type: "deploy", args: {} },
    { type: "bash", args: { command: "rm -rf node_modules" } },
  ];
  let irrOk = true;
  for (const action of irreversible) {
    const decision = await gate.check(action);
    const desc = action.type === "bash" ? `bash "${action.args.command}"` : action.type;
    const denied = decision.outcome === "deny";
    if (!denied) irrOk = false;
    console.log(`  [${denied ? "DENY " : "ALLOW"}] ${desc}${denied ? ` — rule=${decision.rule}` : ""}`);
  }
  report("all irreversible/x actions correctly denied under rw- (not counted in the usability number)", irrOk);

  return { total, allowed, falseDeny, gapDeny, correctDeny, classificationOk, irrOk };
}

// E-rwx-5: falsify each guard, show the corresponding case goes RED.
async function runE5() {
  section("E-rwx-5: falsify each guard, confirm the case goes RED");

  console.log("\n-- baseline (no guards disabled) --");
  const baselineE1 = await runE1(new Set());
  const baselineE2 = await runE2(new Set());
  const baselineE3 = await runE3(new Set());
  report("baseline E-rwx-1 is green", baselineE1);
  report("baseline E-rwx-2 is green", baselineE2);
  report("baseline E-rwx-3 is green", baselineE3);

  console.log("\n-- RWX_DISABLE=unlisted (guard c: unlisted deny) --");
  // Suppressed: falsification runs are EXPECTED to go red (that's the proof),
  // so their internal report() calls must not affect the process exit code.
  const e2Disabled = await withSuppressedCounting(() => runE2(new Set(["unlisted"])));
  report("with 'unlisted' disabled, E-rwx-2 goes RED (hidden tool now allowed)", !e2Disabled);

  console.log("\n-- RWX_DISABLE=joined (guard d: joined-command deny) --");
  const e1JoinedDisabled = await withSuppressedCounting(() => runE1(new Set(["joined"])));
  report("with 'joined' disabled, E-rwx-1 goes RED (a joiner case now allowed)", !e1JoinedDisabled);

  console.log("\n-- RWX_DISABLE=leadingword (guard d: leading-word match) --");
  const e1WordDisabled = await withSuppressedCounting(() => runE1(new Set(["leadingword"])));
  report("with 'leadingword' disabled, E-rwx-1 goes RED (every bash command now allowed)", !e1WordDisabled);

  console.log("\n-- RWX_DISABLE=clamp (guard e: spawn clamp) --");
  const e3ClampDisabled = await withSuppressedCounting(() => runE3(new Set(["clamp"])));
  report("with 'clamp' disabled, E-rwx-3 goes RED (child inherits requested 'rwx')", !e3ClampDisabled);
}

async function main() {
  const only = process.argv[2];
  const disabled = disabledGuards();
  if (disabled.size) console.log(`RWX_DISABLE active: [${[...disabled]}]`);

  if (!only || only === "e1") await runE1(disabled);
  if (!only || only === "e2") await runE2(disabled);
  if (!only || only === "e3") await runE3(disabled);
  if (!only || only === "e4") await runE4(disabled);
  if (!only || only === "e5") await runE5();

  console.log(`\n=== TOTAL: ${PASS} PASS, ${FAIL} FAIL ===`);
  if (SUPPRESSED_PASS || SUPPRESSED_FAIL) {
    console.log(
      `    (E-rwx-5 falsification sub-cases, excluded from the totals above: ` +
        `${SUPPRESSED_PASS} pass, ${SUPPRESSED_FAIL} expected-red — that redness is the falsification working)`,
    );
  }
  // PASS/FAIL above already excludes E-rwx-5's intentionally-red falsification
  // sub-cases (routed into SUPPRESSED_* via withSuppressedCounting) — only
  // real signal remains: every non-E5 check, plus E5's own "goes RED"
  // meta-asserts. A standalone `RWX_DISABLE=... node rwx-poc.mjs <case>` demo
  // run is expected to show FAIL without failing the process.
  if (FAIL > 0 && !process.env.RWX_DISABLE) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
