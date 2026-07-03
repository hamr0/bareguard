// bareguard public API. See README.md for usage.

// Re-export the public type definitions so consumers can
// `import { Gate, type GateConfig } from "bareguard"` (or, more granularly,
// from "bareguard/types"). These are JSDoc typedefs — erased at runtime.
/**
 * @typedef {import("./types.js").Action} Action
 * @typedef {import("./types.js").Result} Result
 * @typedef {import("./types.js").Decision} Decision
 * @typedef {import("./types.js").HumanEvent} HumanEvent
 * @typedef {import("./types.js").HumanResponse} HumanResponse
 * @typedef {import("./types.js").HumanChannel} HumanChannel
 * @typedef {import("./types.js").HaltContext} HaltContext
 * @typedef {import("./types.js").BudgetDimension} BudgetDimension
 * @typedef {import("./types.js").GateConfig} GateConfig
 * @typedef {import("./types.js").ToolsConfig} ToolsConfig
 * @typedef {import("./types.js").BashConfig} BashConfig
 * @typedef {import("./types.js").FsConfig} FsConfig
 * @typedef {import("./types.js").NetConfig} NetConfig
 * @typedef {import("./types.js").BudgetConfig} BudgetConfig
 * @typedef {import("./types.js").LimitsConfig} LimitsConfig
 * @typedef {import("./types.js").ContentConfig} ContentConfig
 * @typedef {import("./types.js").FlagsConfig} FlagsConfig
 * @typedef {import("./types.js").AxisBConfig} AxisBConfig
 * @typedef {import("./types.js").Annotation} Annotation
 * @typedef {import("./types.js").SecretsConfig} SecretsConfig
 * @typedef {import("./types.js").RateConfig} RateConfig
 * @typedef {import("./types.js").AuditConfig} AuditConfig
 */

export { Gate, routeAnnotation } from "./gate.js";
export { redact } from "./primitives/secrets.js";
export {
  SAFE_DEFAULT_DENY_PATTERNS,
  SAFE_DEFAULT_ASK_PATTERNS,
  PAYLOAD_FIELDS,
} from "./primitives/content.js";
export {
  classifyCommand,
  DESTRUCTIVE_PATTERNS,
  SUPER_DESTRUCTIVE_PATTERNS,
} from "./primitives/classify.js";
export { BudgetUnavailableError } from "./primitives/budget.js";
export { defaultAuditPath } from "./primitives/audit.js";
export { globToRegex, matchAny } from "./glob.js";
