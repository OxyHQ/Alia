/**
 * Closed value sets and stored shapes for `conversation`.
 *
 * These live OUTSIDE `models/` because the drizzle schema renders its CHECK
 * constraints from these exact tuples — so the Postgres schema depends on them
 * at runtime.
 *
 * The stored shapes moved here when the Mongoose models were deleted. They were
 * co-located with the schema that enforced them; `db/schema/chat.ts` now holds
 * `content` and `tool_invocations` as `jsonb`, which enforces nothing, so the
 * only remaining statement of what those columns hold is this file plus the
 * whitelist in `routes/conversations.ts` that admits them.
 */

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export const MESSAGE_VOTES = ['up', 'down'] as const;
export type MessageVote = (typeof MESSAGE_VOTES)[number];
/**
 * Where a conversation came from.
 *
 * ## `signal` was missing, and the port is what made that MATTER
 *
 * `lib/channels/types.ts` declares five channels and `lib/channels/index.ts`
 * registers all five, so `routes/webhooks.ts` really does write
 * `source: 'signal'`. Mongoose declared this tuple as an `enum` and never
 * checked it: validators do not run on `findOneAndUpdate`, which is the only
 * statement that writes this column from a channel, so Signal threads were
 * stored with a value the schema said was impossible.
 *
 * `conversations_source_check` DOES check it. Left as it was, the first Signal
 * message after the cutover would fail its upsert, be swallowed by the
 * webhook's catch, and reply "Sorry, an error occurred" forever — with the
 * conversation never persisted and no other symptom. So the tuple is corrected
 * to the values that are actually written, and `0027_signal_conversation_source`
 * widens the constraint to match. This is a validator that never ran becoming a
 * constraint that does, resolved by making the constraint true.
 */
export const CONVERSATION_SOURCES = ['app', 'telegram', 'api', 'web', 'discord', 'whatsapp', 'slack', 'signal'] as const;
export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];

/**
 * The AI SDK's tool-call lifecycle.
 *
 * Mongoose enforced this with a sub-schema `enum`, and `insertMany` runs
 * validators — so unlike most of the validators this port met, it really did
 * fire. `tool_invocations` is `jsonb` and cannot carry the check, so the
 * enforcement moved to the one place a client can supply the value:
 * `routes/conversations.ts` normalises `POST /conversations` bodies against this
 * tuple. Every other writer produces it server-side in `lib/chat/stream-runner.ts`.
 */
export const TOOL_INVOCATION_STATES = ['partial-call', 'call', 'result'] as const;
export type ToolInvocationState = (typeof TOOL_INVOCATION_STATES)[number];

/**
 * One tool call attached to a message.
 *
 * `state` is `string` rather than {@link ToolInvocationState} because this is
 * also the READ type: the column is `jsonb` with no constraint, so what comes
 * back is whatever was written, including by a writer that predates the
 * normalisation. `args` and `result` were Mongoose `Mixed` — every tool has its
 * own shape and nothing queries inside them.
 */
export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: string;
  args?: unknown;
  result?: unknown;
}

/**
 * The agent that produced a message, when one did.
 *
 * A fixed sub-document this service composes itself, which is why
 * `db/schema/chat.ts` flattens it onto four columns rather than storing it as
 * `jsonb`.
 *
 * `color` stands where `avatar` did. An agent has no avatar: it is drawn as a
 * glyph tinted with its own Bloom colour preset, read from its Oxy account by
 * `lib/agent-identity.ts`. It is nullable for the reason that field is —
 * an account with no colour, an Oxy that does not serve one and an account that
 * failed to resolve are the same answer to a client.
 */
export interface AgentInfo {
  id: string;
  name: string;
  color: string | null;
  handle: string;
}

/** One element of a multi-part message body. The shape is the AI SDK's. */
export interface MessageContentPart {
  type: string;
  [key: string]: unknown;
}

/**
 * A message body: plain text, or the ordered parts array the AI SDK sends.
 *
 * Genuinely polymorphic, which is the `jsonb` test — the format belongs to
 * somebody else. `db/__tests__/chat.pgdb.test.ts` asserts both JSON types reach
 * the column.
 */
export type MessageContent = string | MessageContentPart[];
