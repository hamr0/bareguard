// bareguard public API. See README.md for usage.

export { Gate } from "./gate.js";
export { redact } from "./primitives/secrets.js";
export {
  SAFE_DEFAULT_DENY_PATTERNS,
  SAFE_DEFAULT_ASK_PATTERNS,
} from "./primitives/content.js";
export { BudgetUnavailableError } from "./primitives/budget.js";
export { defaultAuditPath } from "./primitives/audit.js";
export { globToRegex, matchAny } from "./glob.js";
