// Single-file JSONL audit (PRD v0.5 §14). All processes append to one file
// using O_APPEND atomicity (POSIX guarantees atomic writes < PIPE_BUF).
// No lock on emit. Each line carries run_id / parent_run_id / spawn_depth.

import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

const MAX_LINE_BYTES = 3500; // safety margin under PIPE_BUF (4096 on Linux/macOS)

function defaultAuditPath(rootRunId) {
  const xdgState = process.env.XDG_STATE_HOME;
  const home = os.homedir();
  if (xdgState) return path.join(xdgState, "bareguard", `${rootRunId}.jsonl`);
  if (home)     return path.join(home, ".local", "state", "bareguard", `${rootRunId}.jsonl`);
  return path.join(process.cwd(), `bareguard-${rootRunId}.jsonl`);
}

export class Audit {
  constructor({ filePath, runId, parentRunId, spawnDepth, rootRunId }) {
    this.runId = runId;
    this.parentRunId = parentRunId ?? null;
    this.spawnDepth = spawnDepth ?? 0;
    this.rootRunId = rootRunId ?? runId;
    this.filePath = filePath ?? defaultAuditPath(this.rootRunId);
    this.seq = 0;
  }

  async init() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    // touch the file so subsequent appends always have a target
    const fh = await fsp.open(this.filePath, "a");
    await fh.close();
  }

  async emit(fields) {
    const line = {
      ts: new Date().toISOString(),
      seq: ++this.seq,
      run_id: this.runId,
      parent_run_id: this.parentRunId,
      spawn_depth: this.spawnDepth,
      ...fields,
    };
    let serialized = JSON.stringify(line) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) {
      // Truncate action.args / result to keep the line atomic on POSIX FS.
      const truncated = { ...line };
      if (truncated.action && truncated.action.args) {
        truncated.action = { ...truncated.action, args: `[TRUNCATED:${Buffer.byteLength(JSON.stringify(truncated.action.args), "utf8")} bytes]` };
      }
      if (truncated.result) {
        truncated.result = { ...truncated.result, _truncated: true };
        for (const k of Object.keys(truncated.result)) {
          if (typeof truncated.result[k] === "string" && truncated.result[k].length > 200) {
            truncated.result[k] = truncated.result[k].slice(0, 200) + `[TRUNCATED]`;
          }
        }
      }
      serialized = JSON.stringify(truncated) + "\n";
    }
    await fsp.appendFile(this.filePath, serialized);
  }

  async readAll() {
    try {
      const buf = await fsp.readFile(this.filePath, "utf8");
      return buf.split("\n").filter(Boolean).map(l => JSON.parse(l));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }
}

export { defaultAuditPath };
