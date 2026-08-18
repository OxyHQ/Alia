/**
 * WhatsApp gateway tables.
 *
 * Ported from `src/accounts/whatsapp/models.ts`. See `CONVENTIONS.md` in this
 * directory for the decisions that apply to all three messaging domains — the
 * short version is that `session_id` is the real primary key (the code has
 * always addressed sessions by it), and chats and messages carry a genuine
 * foreign key to it, which Mongo could not express.
 */

import { bigint, boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';

/**
 * Baileys' connection lifecycle. Shared verbatim with Telegram (GramJS reports
 * the same five states) but deliberately NOT a shared tuple: they are two
 * protocols that happen to agree today, and merging them would make a change to
 * one silently widen the other.
 */
export const WHATSAPP_SESSION_STATUSES = [
  'qr-pending',
  'connected',
  'disconnected',
  'logged-out',
  'failed',
] as const;
export type WhatsAppSessionStatus = (typeof WHATSAPP_SESSION_STATUSES)[number];

export const whatsappSessions = pgTable(
  'whatsapp_sessions',
  {
    sessionId: text().primaryKey(),
    oxyUserId: text().notNull(),
    phoneNumber: text(),
    displayName: text(),
    status: text({ enum: WHATSAPP_SESSION_STATUSES }).notNull().default('qr-pending'),
    /**
     * Serialized Baileys auth credentials, and the pre-key/session/sender-key
     * map. Genuinely shape-less — Baileys owns the format and changes it across
     * versions — so `jsonb` is earned here rather than a projection that would
     * silently drop whatever a newer Baileys added. Both are CREDENTIALS: see
     * `protectedColumns.ts`.
     */
    authState: jsonb(),
    /** Mongoose `Map<string, unknown>`; a plain object in JSON either way. */
    authKeys: jsonb().notNull().default({}),
    lastConnected: timestamptz(),
    lastDisconnected: timestamptz(),
    /** The pairing QR payload. Short-lived, but a live credential while valid. */
    lastQr: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('whatsapp_sessions_oxy_user_id_idx').on(t.oxyUserId),
    checkOneOf('whatsapp_sessions_status_check', t.status, WHATSAPP_SESSION_STATUSES),
  ],
);

export const whatsappChats = pgTable(
  'whatsapp_chats',
  {
    id: generatedId(),
    sessionId: text()
      .notNull()
      .references(() => whatsappSessions.sessionId, { onDelete: 'cascade' }),
    oxyUserId: text().notNull(),
    jid: text().notNull(),
    name: text(),
    unreadCount: integer().notNull().default(0),
    /**
     * WhatsApp's own epoch-seconds value, kept as an integer rather than
     * converted to `timestamptz`. It is a foreign protocol's field that the
     * gateway echoes back verbatim; reinterpreting it as a date would change
     * what it means and is not reversible if the unit assumption is wrong.
     */
    conversationTimestamp: bigint({ mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('whatsapp_chats_session_jid_key').on(t.sessionId, t.jid),
    index('whatsapp_chats_session_recent_idx').on(t.sessionId, t.conversationTimestamp.desc()),
    index('whatsapp_chats_oxy_user_id_idx').on(t.oxyUserId),
  ],
);

export const whatsappMessages = pgTable(
  'whatsapp_messages',
  {
    id: generatedId(),
    sessionId: text()
      .notNull()
      .references(() => whatsappSessions.sessionId, { onDelete: 'cascade' }),
    oxyUserId: text().notNull(),
    jid: text().notNull(),
    /** WhatsApp's message id. Unique per session — never a Mercaria key. */
    messageId: text().notNull(),
    fromMe: boolean().notNull().default(false),
    /** Epoch value from WhatsApp; see `conversationTimestamp` above. */
    timestamp: bigint({ mode: 'number' }).notNull(),
    text: text().notNull().default(''),
    pushName: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('whatsapp_messages_session_message_key').on(t.sessionId, t.messageId),
    index('whatsapp_messages_session_jid_recent_idx').on(t.sessionId, t.jid, t.timestamp.desc()),
    index('whatsapp_messages_oxy_user_id_idx').on(t.oxyUserId),
  ],
);
