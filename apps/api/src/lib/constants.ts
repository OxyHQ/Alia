/**
 * Shared Constants
 *
 * Centralized definitions for values used across multiple modules.
 * Import from here instead of redefining locally.
 */

// ── Error Detection Patterns ──

/** Matches billing/payment/quota errors from any provider */
export const BILLING_RE = /insufficient balance|payment required|insufficient credits|credit balance|plans & billing|billing.?hard.?limit|exceeded.*quota|quota.*exceeded/i;

/** Matches authentication/authorization errors from any provider */
export const AUTH_RE = /invalid.?api.?key|incorrect api key|api key.{0,10}not valid|invalid token|authentication|unauthorized|forbidden|access denied|expired|token has expired/i;

// ── Agent Configuration ──

/** Maximum depth for agent-to-agent delegation chains */
export const MAX_DELEGATION_DEPTH = 3;

/** Token budget for the agent event stream context window */
export const EVENT_STREAM_BUDGET = 60_000;

/** Threshold (in tokens) above which tool results are offloaded to workspace filesystem */
export const OFFLOAD_THRESHOLD_TOKENS = 4_000;

/** Maximum retry attempts for chat model resolution */
export const MAX_CHAT_RETRIES = 5;
