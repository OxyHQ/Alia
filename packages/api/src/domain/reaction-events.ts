/** Durable delivery states for conversational feedback, without execution authority. */
export const REACTION_EVENT_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;
export const REACTION_EVENT_PHASES = ['select', 'speak'] as const;
