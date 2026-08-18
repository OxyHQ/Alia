/**
 * Telegram gateway tables (GramJS user accounts, not the bot API).
 *
 * Ported from `src/accounts/telegram-gateway/models.ts`. Decisions common to the
 * three messaging domains are in `CONVENTIONS.md`.
 */

import { bigint, boolean, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';

/**
 * The same five values WhatsApp uses, declared separately on purpose: two
 * protocols agreeing today is not a shared contract, and one tuple would let a
 * change to either silently widen the other.
 */
export const TELEGRAM_SESSION_STATUSES = [
  'qr-pending',
  'connected',
  'disconnected',
  'logged-out',
  'failed',
] as const;
export type TelegramSessionStatus = (typeof TELEGRAM_SESSION_STATUSES)[number];

export const TELEGRAM_CHAT_TYPES = ['user', 'group', 'channel'] as const;
export type TelegramChatType = (typeof TELEGRAM_CHAT_TYPES)[number];

export const telegramSessions = pgTable(
  'telegram_sessions',
  {
    sessionId: text().primaryKey(),
    oxyUserId: text().notNull(),
    telegramUserId: text(),
    phoneNumber: text(),
    displayName: text(),
    status: text({ enum: TELEGRAM_SESSION_STATUSES }).notNull().default('qr-pending'),
    /**
     * GramJS `StringSession`. This is a FULL ACCOUNT CREDENTIAL — anyone holding
     * it can act as the user on Telegram without re-authenticating. Protected;
     * see `protectedColumns.ts`.
     */
    sessionString: text(),
    lastConnected: timestamptz(),
    lastDisconnected: timestamptz(),
    /** `tg://login?token=…`. A live credential for as long as it is valid. */
    lastQr: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Non-unique: a user may hold several Telegram sessions at once.
    index('telegram_sessions_oxy_user_id_idx').on(t.oxyUserId),
    checkOneOf('telegram_sessions_status_check', t.status, TELEGRAM_SESSION_STATUSES),
  ],
);

export const telegramChats = pgTable(
  'telegram_chats',
  {
    id: generatedId(),
    sessionId: text()
      .notNull()
      .references(() => telegramSessions.sessionId, { onDelete: 'cascade' }),
    chatId: text().notNull(),
    name: text(),
    unreadCount: integer().notNull().default(0),
    /** Telegram's own epoch value, echoed verbatim — see `CONVENTIONS.md`. */
    lastMessageTimestamp: bigint({ mode: 'number' }),
    chatType: text({ enum: TELEGRAM_CHAT_TYPES }).notNull().default('user'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('telegram_chats_session_chat_key').on(t.sessionId, t.chatId),
    index('telegram_chats_session_recent_idx').on(t.sessionId, t.lastMessageTimestamp.desc()),
    checkOneOf('telegram_chats_chat_type_check', t.chatType, TELEGRAM_CHAT_TYPES),
  ],
);

export const telegramMessages = pgTable(
  'telegram_messages',
  {
    id: generatedId(),
    sessionId: text()
      .notNull()
      .references(() => telegramSessions.sessionId, { onDelete: 'cascade' }),
    chatId: text().notNull(),
    /** Telegram's message id. Unique per session — never a Mercaria key. */
    messageId: text().notNull(),
    fromMe: boolean().notNull().default(false),
    timestamp: bigint({ mode: 'number' }).notNull(),
    text: text().notNull().default(''),
    senderName: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('telegram_messages_session_message_key').on(t.sessionId, t.messageId),
    index('telegram_messages_session_chat_recent_idx').on(t.sessionId, t.chatId, t.timestamp.desc()),
  ],
);
