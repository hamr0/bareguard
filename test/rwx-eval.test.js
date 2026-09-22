// rwx core enforcement (PRD §23). Adapted from the throwaway POC's E-rwx-1/2
// evidence (harness-code-mode/rwx-poc.mjs), now exercised through the REAL
// shipped Gate + src/primitives/rwx.js rather than an outside wrapper.

import test from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/index.js";

const RWX = {
  agents: { researcher: "r--", fixer: "rw-", deployer: "rwx" },
  tools: {
    read: "r", fetch: "r", search: "r",
    write: "w", edit: "w", "github.create_pr": "w",
    deploy: "x", wireMoney: "x",
  },
  bash: {
    ls: "r", cat: "r", grep: "r",
    "git status": "r", "git log": "r", "git diff": "r",
    "git add": "w", "git commit": "w", "npm test": "w", "npm run build": "w",
    "npm publish": "x", "git push": "x", rm: "x",
  },
};

function gateFor(agent, overrides = {}) {
  return new Gate({
    audit: { path: null },
    rwx: { agent, ...RWX, ...overrides },
    humanChannel: async () => ({ decision: "deny" }),
  });
}

// ─── E-rwx-1: adversarial bash under r-- (researcher) ────────────────────────

test("rwx bash: adversarial joined/chained commands all deny under r--", async () => {
  const gate = gateFor("researcher");
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
    ["xargs wrapper", "xargs rm -rf /"],
    ["find -exec", "find / -name '*.key' -exec cat {} \\;"],
    ["find -delete", "find / -name '*.key' -delete"],
    ["prefix-confusable command", "lsblk /dev/sda"],
    ["redirect write (overwrite)", "ls > /home/hamr/.bashrc"],
    ["redirect write (ssh key exfil)", "cat ~/.ssh/id_rsa > /tmp/leak"],
    ["redirect append", "cat a >> b"],
    ["redirect read (input)", "grep x < /etc/shadow"],
  ];
  for (const [label, cmd] of cases) {
    const d = await gate.check({ type: "bash", args: { command: cmd } });
    assert.equal(d.outcome, "deny", `${label}: "${cmd}" should deny (got rule=${d.rule})`);
  }
});

test("rwx bash: leading-word matching is word-boundary aware (ls never matches lsblk)", async () => {
  const gate = gateFor("researcher");
  await gate.init();
  // "lsblk" is unlisted (not "ls"), so it denies as unlisted, not as allowed via ls.
  const d = await gate.check({ type: "bash", args: { command: "lsblk /dev/sda" } });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.unlisted");
});

test("rwx bash: legitimate longest-prefix match allows (git status over a hypothetical bare git)", async () => {
  const gate = gateFor("researcher");
  await gate.init();
  const d = await gate.check({ type: "bash", args: { command: "git status" } });
  assert.equal(d.outcome, "allow");
  assert.equal(d.rule, "rwx.allow");
});

// ─── E-rwx-2: hidden tool called by name anyway denies at check (deny backstop) ─

test("rwx tools: catalog (gate.allows) hides tools whose letter the agent lacks", async () => {
  const gate = gateFor("researcher"); // r--
  await gate.init();
  const catalog = Object.keys(RWX.tools);
  const visible = [];
  for (const name of catalog) {
    if (await gate.allows({ type: name })) visible.push(name);
  }
  assert.deepEqual(visible.sort(), ["fetch", "read", "search"].sort());
});

test("rwx tools: a hidden tool called by name anyway is denied at check (model-cannot-widen backstop)", async () => {
  const gate = gateFor("researcher"); // r--
  await gate.init();
  for (const tool of ["deploy", "write", "edit", "github.create_pr", "wireMoney"]) {
    const d = await gate.check({ type: tool, args: {} });
    assert.equal(d.outcome, "deny", `${tool} should deny`);
    assert.equal(d.rule, "rwx.denied", `${tool} should deny via rwx.denied (tagged, letter lacking)`);
  }
});

test("rwx tools: an unlisted tool (not in the map at all) denies with rwx.unlisted", async () => {
  const gate = gateFor("deployer"); // rwx — holds every letter, but the tool isn't tagged
  await gate.init();
  const d = await gate.check({ type: "totally_unknown_tool", args: {} });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "rwx.unlisted");
});

test("rwx: an unlisted agent gets \"---\" — it starts, but every action denies", async () => {
  const gate = gateFor("ghost-agent");
  await gate.init();
  const d1 = await gate.check({ type: "read", args: {} });
  assert.equal(d1.outcome, "deny");
  assert.equal(d1.rule, "rwx.unlisted");
  const d2 = await gate.check({ type: "bash", args: { command: "git status" } });
  assert.equal(d2.outcome, "deny");
  assert.equal(d2.rule, "rwx.unlisted");
});

// ─── rw- realistic session: irreversible ('x') actions never reachable ───────

test("rwx: under rw- (fixer), irreversible/x actions always deny", async () => {
  const gate = gateFor("fixer");
  await gate.init();
  const irreversible = [
    { type: "bash", args: { command: "git push" } },
    { type: "bash", args: { command: "npm publish" } },
    { type: "deploy", args: {} },
    { type: "bash", args: { command: "rm -rf node_modules" } },
  ];
  for (const action of irreversible) {
    const d = await gate.check(action);
    assert.equal(d.outcome, "deny", JSON.stringify(action));
  }
});

test("rwx: under rw- (fixer), r/w actions with real arguments allow", async () => {
  const gate = gateFor("fixer");
  await gate.init();
  const allowed = [
    { type: "read", args: { path: "src/gate.js" } },
    { type: "bash", args: { command: "git status" } },
    { type: "bash", args: { command: "git diff --stat" } },
    { type: "bash", args: { command: "git log --oneline -5" } },
    { type: "edit", args: { path: "src/gate.js", patch: "..." } },
    { type: "bash", args: { command: "git add src/x.js test/x.test.js" } },
    { type: "bash", args: { command: "npm test" } },
    { type: "bash", args: { command: "npm test -- --grep auth" } },
    { type: "bash", args: { command: "npm run build" } },
    { type: "github.create_pr", args: {} },
  ];
  for (const action of allowed) {
    const d = await gate.check(action);
    assert.equal(d.outcome, "allow", `${JSON.stringify(action)} should allow (rule=${d.rule}, reason=${d.reason})`);
  }
});

// ─── shape edge cases ─────────────────────────────────────────────────────────

test("rwx: a non-string bash command denies (never throws) even under a full-letter agent", async () => {
  // The pre-existing step-3 `bashCheck` type-guard (bash.invalidCmd) runs before
  // rwx's own step-5 check and already denies a non-string command — a bash
  // action's command type is validated regardless of mode. rwx's own
  // rwx.invalid guard for the same shape is defense-in-depth for this eval
  // order, exercised directly against rwxCheck in rwx-config-shape.test.js.
  const gate = gateFor("deployer");
  await gate.init();
  const d = await gate.check({ type: "bash", args: { command: 12345 } });
  assert.equal(d.outcome, "deny");
  assert.equal(d.rule, "bash.invalidCmd");
});

test("rwx: flat action.cmd / nested action.args.cmd / action.args.command all read (bareagent seam parity)", async () => {
  const gate = gateFor("deployer");
  await gate.init();
  const a1 = await gate.check({ type: "bash", cmd: "git status" });
  const a2 = await gate.check({ type: "bash", args: { cmd: "git status" } });
  const a3 = await gate.check({ type: "bash", args: { command: "git status" } });
  for (const d of [a1, a2, a3]) assert.equal(d.outcome, "allow");
});
