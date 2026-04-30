// Test helpers — shared across test files.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function makeTmpDir(prefix = "bareguard-test-") {
  return await mkdtemp(path.join(tmpdir(), prefix));
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
