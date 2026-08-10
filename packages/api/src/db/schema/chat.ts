/**
 * Chat: conversations, the messages in them, and the canvas attached to one.
 *
 * These three land together because they are keyed the same way. A conversation
 * is addressed by `(oxy_user_id, conversation_id)` — a client-supplied business
 * key, NOT the row's `_id` — and both `messages` and `canvas_sessions` reference
 * it by that pair rather than by an id. Deciding what constraint that pair earns
 * is one decision, and splitting it across two changes is how it ends up with
 * two different answers.
 *
 * None declared a TTL index, so none appears in `db/expiryTargets.ts`. This is
 * user content: a conversation is deleted when its owner deletes it
 * (`routes/conversations.ts:262`) and never on a timer.
 */

import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { CONVERSATION_SOURCES, MESSAGE_ROLES, MESSAGE_VOTES } from '../../models/conversation.js';
import { checkOneOf } from './columns';

/**
 * A chat thread.
 *
 * `conversation_id` is supplied by the client and unique only WITHIN a user, so
 * every lookup in the package carries both columns. Two users can hold the same
 * `conversation_id` and the schema must let them.
 *
 * **Neither `folder_id` nor `agent_id` gets a foreign key, for different
 * reasons.** `folder_id` is declared `ref: 'Folder'` and **no `Folder` model
 * exists in this service at all** — `models/__tests__/foreign-ref-populate.test.ts`
 * names it as a known dangling ref, so the column is a bare id pointing at
 * nothing this schema could target. `agent_id` names a real model whose table is
 * a later batch; it gets one when `agents` lands, if a deletion answer exists
 * then.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    conversationId: text().notNull(),
    title: text().notNull().default('New chat'),
    isManualTitle: boolean().notNull().default(false),
    lastMessage: text(),
    source: text({ enum: CONVERSATION_SOURCES as unknown as [string, ...string[]] })
      .notNull()
      .default('app'),
    /** Points at no table: this service registers no `Folder` model. */
    folderId: text(),
    icon: text(),
    iconColor: text(),
    isFavorite: boolean().notNull().default(false),
    isPublic: boolean().notNull().default(false),
    /** An `agents` row. No foreign key — that table is a later batch. */
    agentId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('conversations_oxy_user_conversation_id_key').on(t.oxyUserId, t.conversationId),
    // Serves `GET /conversations`: one user's threads, most recent first.
    index('conversations_oxy_user_updated_at_idx').on(t.oxyUserId, t.updatedAt.desc()),
    index('conversations_oxy_user_agent_id_idx').on(t.oxyUserId, t.agentId),
    checkOneOf('conversations_source_check', t.source, CONVERSATION_SOURCES),
  ],
);

/**
 * One message in a conversation.
 *
 * ## `conversation_id` gets NO foreign key, and that is a deliberate refusal
 *
 * The relation is real — every message names a conversation, on the business
 * key pair. A constraint is still wrong, because **two existing write paths
 * create the parent and the child concurrently**:
 * `routes/conversations.ts:187-188` puts the conversation upsert and the message
 * insert in ONE `Promise.all`, so whichever statement Postgres serves first
 * decides whether the parent exists yet. Under a foreign key that is a
 * race-dependent `23503` on a request that works today.
 *
 * The other three writers (`webhooks.ts:251/270` and `:404/419`,
 * `conversation-saver.ts:143`) do await the conversation first, so a reader
 * checking only those would conclude the constraint is safe. It is the parallel
 * one that governs. This is `api_usage.key_id`'s reasoning applied to an
 * ORDERING rather than to a deletion: every available answer is worse than
 * none, so the absence is written down rather than left to look like an
 * oversight.
 *
 * The consequence is that a conversation delete must keep removing messages by
 * hand, which is what `routes/conversations.ts:268-277` already does — and note
 * it deletes messages even when no conversation row matched, so orphans are
 * already reachable in Mongo today.
 *
 * ## `client_message_id` is the AI SDK's id, and it collides with `id`
 *
 * Mongoose stores BOTH `_id` and a separate `id` field carrying the id the AI
 * SDK assigned on the client. `id` here is the primary key holding Mongo's
 * `_id`, per this schema's rule, so the client's needs its own name.
 *
 * It is not decoration: `routes/v1/audio.ts:130` and `:302` look a message up by
 * `(conversation_id, oxy_user_id, client_message_id)` to attach a generated
 * audio URL. Mongo had no index covering it and neither does this — the
 * `(oxy_user_id, conversation_id, …)` unique below is a prefix of that
 * predicate, so the lookup is served and then filtered, exactly as before. A
 * dedicated index is a performance decision with numbers attached, and this port
 * is not the place to guess at one. It is nullable because only
 * `routes/conversations.ts:190` writes it; `conversation-saver.ts`'s
 * `buildStoredMessage` does not.
 *
 * ## No `updated_at`, on purpose
 *
 * `MessageSchema` has no `timestamps: true` — it declares `createdAt` alone. A
 * message is rewritten by delete-and-reinsert rather than edited, so there is no
 * modification time to record and adding one would invent a value.
 *
 * ## `content` and `tool_invocations` are `jsonb`; `agent_info` is COLUMNS
 *
 * `content` is Mongoose `Mixed` and genuinely polymorphic — a plain string or an
 * ordered parts array whose shape is the AI SDK's, not this service's. That is
 * the `jsonb` test exactly: the format belongs to somebody else.
 *
 * `tool_invocations` is an ordered list read whole, and the whole-package grep
 * finds no query addressing an element — every `toolCallId` and `state` access
 * is in-memory array work in `lib/chat/`. Its `args` and `result` are `Mixed`,
 * so a child table would have to hold two opaque values anyway.
 *
 * `agent_info` is the opposite and becomes four columns: a single sub-document
 * of fixed, known shape this service composes itself — the `routing_logs`
 * precedent. `agent_info_avatar` is nullable because the model defaults it to
 * `null` rather than leaving it absent.
 */
export const messages = pgTable(
  'messages',
  {
    id: generatedId(),
    conversationId: text().notNull(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    /** Mongoose calls this `id`. See the table comment. */
    clientMessageId: text(),
    role: text({ enum: MESSAGE_ROLES as unknown as [string, ...string[]] }).notNull(),
    content: jsonb().notNull(),
    vote: text({ enum: MESSAGE_VOTES as unknown as [string, ...string[]] }),
    toolInvocations: jsonb(),
    agentInfoId: text(),
    agentInfoName: text(),
    agentInfoAvatar: text(),
    agentInfoHandle: text(),
    audioUrl: text(),
    /** The append index within a conversation. Absent on legacy messages. */
    seq: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_conversation_created_at_idx').on(t.conversationId, t.createdAt),
    /**
     * The append-ordering unique, and it is load-bearing:
     * `conversation-saver.ts:177-185` inserts optimistically and treats a
     * duplicate-key error as "a concurrent append claimed this seq", falling
     * back to a full rewrite. Without this index that race silently produces two
     * messages at one position.
     *
     * **The `WHERE seq IS NOT NULL` predicate does NO correctness work here, and
     * is kept anyway.** Mongo needed it: `partialFilterExpression` existed
     * because legacy seq-less messages would otherwise all collide on
     * `(user, conversation, null)`. Postgres already treats NULLs as distinct,
     * so a plain unique admits them just as well. The predicate stays because it
     * documents that legacy rows are expected and keeps the index off them —
     * **no size measurement was taken**, so read that as intent rather than as a
     * figure.
     *
     * One honest difference from the source, in the permissive direction: Mongo's
     * `$exists: true` includes a present-but-NULL `seq`, so Mongo enforced
     * uniqueness across explicit nulls where BOTH Postgres spellings permit
     * them. The field has no default, so absent rather than null is the shape
     * that actually occurs.
     */
    uniqueIndex('messages_oxy_user_conversation_seq_key')
      .on(t.oxyUserId, t.conversationId, t.seq)
      .where(sql`${t.seq} is not null`),
    checkOneOf('messages_role_check', t.role, MESSAGE_ROLES),
    checkOneOf('messages_vote_check', t.vote, MESSAGE_VOTES),
  ],
);

/**
 * The canvas components attached to one conversation.
 *
 * **This table has no writer.** All three call sites are reads or a delete —
 * `socket.ts:84` and `routes/canvas/sessions.ts:14` load it,
 * `routes/canvas/sessions.ts:34` deletes it — and nothing in the package
 * creates or updates one. Recorded because a table with only readers looks
 * active from any single call site, and because it decides the column below: the
 * question "should `components` be a child table" cannot turn on how elements
 * are written when nothing writes them.
 *
 * `components` is therefore `jsonb`: `routes/canvas/sessions.ts:23` returns the
 * array verbatim as the response body and nothing addresses an element. Its
 * `data` is `Mixed` per component, so a child table would hold an opaque value
 * anyway — the `fallback_events.attempts` precedent.
 *
 * `conversation_id` gets no foreign key, for the same reason as `messages`, and
 * the unique pair below is Mongo's own.
 */
export const canvasSessions = pgTable(
  'canvas_sessions',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    conversationId: text().notNull(),
    components: jsonb().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('canvas_sessions_oxy_user_conversation_id_key').on(t.oxyUserId, t.conversationId),
    index('canvas_sessions_conversation_id_idx').on(t.conversationId),
  ],
);
