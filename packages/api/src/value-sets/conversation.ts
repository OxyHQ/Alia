/**
 * A chat message's role and vote, and where a conversation came from.
 *
 * A CLOSED VALUE SET, declared here rather than in the Mongoose model that used
 * to own it. Both stores read this one tuple: the model's `enum` validator and
 * the Postgres CHECK `db/schema` renders. A second copy can disagree with the
 * first, and the disagreement is invisible until a write hits one and not the
 * other.
 *
 * It lives outside `models/` because `db/schema` imports it as a RUNTIME value,
 * so the schema — and every migration's CHECK — would otherwise depend on a
 * Mongoose model the port is retiring. See `db/schema/CONVENTIONS.md`
 * ("Closed value sets").
 */

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;

export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MESSAGE_VOTES = ['up', 'down'] as const;

export type MessageVote = (typeof MESSAGE_VOTES)[number];

// Source apps for conversations - extensible for future integrations
export const CONVERSATION_SOURCES = ['app', 'telegram', 'api', 'web', 'discord', 'whatsapp', 'slack'] as const;

export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];
