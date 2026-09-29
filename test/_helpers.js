// Test helpers — shared across test files.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Scope roots must not be (or sit under) a symlink (0.19.2), and os.tmpdir()
// is one on macOS (/var -> /private/var) — so every tmp dir used as an fs scope
// root is created under the REAL tmpdir.
export const REAL_TMPDIR = realpathSync(tmpdir());

// Falls back to the input path when it does not exist (e.g. Windows has no /tmp).
function realOr(p) { try { return realpathSync(p); } catch { return p; } }

// A real (non-symlink) path for the system temp dir, for tests that scope to
// "/tmp" literally: /tmp itself is a symlink on macOS (-> /private/tmp).
export const REAL_SLASH_TMP = realOr("/tmp");

// Same for "/etc" (-> /private/etc on macOS) and "/home".
export const REAL_ETC = realOr("/etc");
export const REAL_HOME_ROOT = realOr("/home");

export async function makeTmpDir(prefix = "bareguard-test-") {
  return await mkdtemp(path.join(REAL_TMPDIR, prefix));
}

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}

export function uniquePaths(tmpDir) {
  const id = randomUUID();
  return {
    auditPath:  path.join(tmpDir, `audit-${id}.jsonl`),
    budgetPath: path.join(tmpDir, `budget-${id}.json`),
    runId: id,
  };
}

// A simple programmable humanChannel for tests.
export function makeHumanChannel(plan) {
  // plan is an array of decisions — one per ask/halt event
  const events = [];
  let i = 0;
  const channel = async (event) => {
    events.push(event);
    if (i >= plan.length) {
      throw new Error(`humanChannel ran out of plan after ${plan.length} events; event: ${JSON.stringify(event)}`);
    }
    const next = plan[i++];
    return typeof next === "function" ? next(event) : next;
  };
  channel.events = events;
  channel.reset = () => { i = 0; events.length = 0; };
  return channel;
}
