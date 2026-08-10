/**
 * Closed value sets for `conversation`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime, and deleting the Mongoose model would break the schema itself.
 * The model imports them from here like any other consumer.
 */

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export const MESSAGE_VOTES = ['up', 'down'] as const;
export type MessageVote = (typeof MESSAGE_VOTES)[number];
export const CONVERSATION_SOURCES = ['app', 'telegram', 'api', 'web', 'discord', 'whatsapp', 'slack'] as const;
export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];
