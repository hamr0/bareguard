// limits primitive (PRD §8 row 5).
//   - maxTurns: halt severity (run-level) — every gate.record ticks
//   - maxToolRounds: halt severity — only ticks on non-"llm" records (v0.4.2)
//   - maxChildren: action severity (per-spawn)
//   - maxDepth: action severity (per-spawn)
//   - timeoutSeconds: halt severity (deferred to v0.2 per amendment §12)

const LLM_TYPE = "llm";

/**
 * Tracks turn/tool-round/spawn counts and enforces per-run limits.
 */
export class Limits {
  /**
   * @param {object} [cfg] limits config
   * @param {number} [cfg.maxTurns] max gate.record ticks before halt (default Infinity)
   * @param {number} [cfg.maxToolRounds] max non-"llm" records before halt (default Infinity)
   * @param {number} [cfg.maxChildren] max lifetime spawns (default Infinity)
   * @param {number} [cfg.maxDepth] max spawn depth (default Infinity)
   * @param {number} [cfg.startingDepth] this run's spawn depth (default 0)
   */
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

  /**
   * Pre-eval halt check for maxTurns / maxToolRounds.
   * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} halt decision, or null if under limits
   */
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

  /**
   * Step-3 per-spawn action deny for maxChildren / maxDepth.
   * @param {object} action action being evaluated
   * @param {string} action.type action type (no-op unless "spawn")
   * @returns {{outcome:string,severity:string,rule:string,reason:string}|null} deny decision, or null if within limits/not a spawn
   */
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

  /**
   * Increment the lifetime spawn (children) counter.
   * @returns {void}
   */
  noteSpawn() { this.children += 1; }
  /**
   * Tick counters once per gate.record: always turns, and toolRounds for non-"llm" actions.
   * @param {object} [action] the recorded action
   * @param {string} [action.type] action type ("llm" does not tick toolRounds)
   * @returns {void}
   */
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
