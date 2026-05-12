// limits primitive (PRD §8 row 5).
//   - maxTurns: halt severity (run-level) — every gate.record ticks
//   - maxToolRounds: halt severity — only ticks on non-"llm" records (v0.4.2)
//   - maxChildren: action severity (per-spawn)
//   - maxDepth: action severity (per-spawn)
//   - timeoutSeconds: halt severity (deferred to v0.2 per amendment §12)

const LLM_TYPE = "llm";

export class Limits {
  constructor(cfg = {}) {
    this.maxTurns = cfg.maxTurns ?? Infinity;
    this.maxToolRounds = cfg.maxToolRounds ?? Infinity;
    this.maxChildren = cfg.maxChildren ?? Infinity; // lifetime total spawns, not concurrent active
    this.maxDepth = cfg.maxDepth ?? Infinity;
    this.startingDepth = cfg.startingDepth ?? 0;
    this.turns = 0;
    this.toolRounds = 0;
    this.children = 0;
  }

  // Pre-eval halt: maxTurns + maxToolRounds
  preCheck() {
    if (this.turns >= this.maxTurns) {
      return {
        outcome: "askHuman", severity: "halt", rule: "limits.maxTurns",
        reason: `turns ${this.turns} >= max ${this.maxTurns}`,
      };
    }
    if (this.toolRounds >= this.maxToolRounds) {
      return {
        outcome: "askHuman", severity: "halt", rule: "limits.maxToolRounds",
        reason: `toolRounds ${this.toolRounds} >= max ${this.maxToolRounds}`,
      };
    }
    return null;
  }

  // Step 3: per-spawn action denies
  spawnCheck(action) {
    if (action.type !== "spawn") return null;
    if (this.children + 1 > this.maxChildren) {
      return {
        outcome: "deny", severity: "action", rule: "limits.maxChildren",
        reason: `would-be children ${this.children + 1} > max ${this.maxChildren}`,
      };
    }
    if (this.startingDepth + 1 > this.maxDepth) {
      return {
        outcome: "deny", severity: "action", rule: "limits.maxDepth",
        reason: `would-be depth ${this.startingDepth + 1} > max ${this.maxDepth}`,
      };
    }
    return null;
  }

  noteSpawn() { this.children += 1; }
  // tick is called once per gate.record. Pass `action` so non-"llm" records
  // tick maxToolRounds — adopters using bareagent's onLlmResult/onToolResult
  // split can budget by "rounds" directly instead of multiplying by 2.
  tick(action) {
    this.turns += 1;
    if (action && action.type !== LLM_TYPE) {
      this.toolRounds += 1;
    }
  }
}
