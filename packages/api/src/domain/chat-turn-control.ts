/** Transport disconnection is not cancellation. Only an authenticated Stop changes this state. */
export const CHAT_TURN_STATES = [
  'running',
  'cancelled',
  'finishing',
  'completed',
  'failed',
] as const;
export type ChatTurnState = (typeof CHAT_TURN_STATES)[number];
export const CHAT_TURN_RETENTION_MS = 24 * 60 * 60 * 1000;
export const CHAT_TURN_POLL_MS = 250;
export const CHAT_TURN_CHECK_TIMEOUT_MS = 2_000;
