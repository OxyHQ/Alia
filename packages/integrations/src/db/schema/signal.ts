/**
 * Signal gateway tables (signal-cli daemon per session).
 *
 * Ported from `src/accounts/signal/models.ts`. Decisions common to the three
 * messaging domains are in `CONVENTIONS.md`.
 */

import { bigint, boolean, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';

/**
 * Signal's lifecycle is genuinely different from WhatsApp's and Telegram's —
 * it links a device rather than scanning into a web session, so `linking` and
 * `unlinked` replace `qr-pending` and `logged-out`. This is the case that shows
 * why the three status tuples are not one shared union.
 */
export const SIGNAL_SESSION_STATUSES = [
  'linking',
  'connected',
  'disconnected',
  'unlinked',
  'failed',
] as const;
export type SignalSessionStatus = (typeof SIGNAL_SESSION_STATUSES)[number];

export const SIGNAL_CHAT_TYPES = ['direct', 'group'] as const;
export type SignalChatType = (typeof SIGNAL_CHAT_TYPES)[number];

export const signalSessions = pgTable(
  'signal_sessions',
  {
    sessionId: text().primaryKey(),
    oxyUserId: text().notNull(),
    phoneNumber: text(),
    displayName: text(),
    status: text({ enum: SIGNAL_SESSION_STATUSES }).notNull().default('linking'),
    /**
     * Filesystem path holding signal-cli's own key material. The PATH is not a
     * secret and what it points at never enters Postgres, but it is host-local
     * state: a row is only meaningful on the machine that wrote it.
     */
    dataDir: text().notNull(),
    /** Live daemon coordinates. Host-local and meaningless after a restart. */
    daemonPort: integer(),
    daemonPid: integer(),
    lastConnected: timestamptz(),
    lastDisconnected: timestamptz(),
    lastQr: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('signal_sessions_oxy_user_id_idx').on(t.oxyUserId),
    checkOneOf('signal_sessions_status_check', t.status, SIGNAL_SESSION_STATUSES),
  ],
);

export const signalChats = pgTable(
  'signal_chats',
  {
    id: generatedId(),
    sessionId: text()
      .notNull()
      .references(() => signalSessions.sessionId, { onDelete: 'cascade' }),
    contactId: text().notNull(),
    name: text(),
    unreadCount: integer().notNull().default(0),
    lastMessageTimestamp: bigint({ mode: 'number' }),
    chatType: text({ enum: SIGNAL_CHAT_TYPES }).notNull().default('direct'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('signal_chats_session_contact_key').on(t.sessionId, t.contactId),
    index('signal_chats_session_recent_idx').on(t.sessionId, t.lastMessageTimestamp.desc()),
    checkOneOf('signal_chats_chat_type_check', t.chatType, SIGNAL_CHAT_TYPES),
  ],
);

export const signalMessages = pgTable(
  'signal_messages',
  {
    id: generatedId(),
    sessionId: text()
      .notNull()
      .references(() => signalSessions.sessionId, { onDelete: 'cascade' }),
    contactId: text().notNull(),
    /**
     * signal-cli's identifier for the message. Named `messageTimestamp` in the
     * Mongoose model and typed `String` there — it is Signal's send-timestamp
     * used AS an id, so it stays `text` and is NOT the sortable `timestamp`
     * column below. Renaming it would break the adapter's own vocabulary.
     */
    messageTimestamp: text().notNull(),
    fromMe: boolean().notNull().default(false),
    timestamp: bigint({ mode: 'number' }).notNull(),
    text: text().notNull().default(''),
    senderName: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('signal_messages_session_message_key').on(t.sessionId, t.messageTimestamp),
    index('signal_messages_session_contact_recent_idx').on(t.sessionId, t.contactId, t.timestamp.desc()),
  ],
);
