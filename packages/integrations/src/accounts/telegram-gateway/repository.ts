/**
 * Every Telegram gateway read and write, on Postgres.
 *
 * Replaces `models.ts`. The sort, ordering and batch rules are the ones stated
 * in `../whatsapp/repository.ts`; what is specific to Telegram is here.
 *
 * ## `sessionString` never leaves through an ordinary read
 *
 * A GramJS `StringSession` IS the account: whoever holds it acts as the user
 * with no second factor. It is registered in `db/protectedColumns.ts`, so
 * `publicColumns` removes it from the row type of every read below, and the one
 * caller that needs it — reconnecting a session inside this process — asks for
 * it by name. Before the port, `GET /sessions/:sessionId/status` returned the
 * whole Mongoose document and therefore returned this credential.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type { IntegrationsDatabase } from '../../db';
import { PROTECTED_COLUMNS } from '../../db/protectedColumns';
import {
  telegramChats,
  telegramMessages,
  telegramSessions,
  type TelegramChatType,
  type TelegramSessionStatus,
} from '../../db/schema';
import { conflictKey } from '../conflictKey';

const PUBLIC_SESSION = publicColumns(telegramSessions, PROTECTED_COLUMNS);

/** The subset the session-list endpoints returned under Mongoose's `.select()`. */
const SESSION_SUMMARY = {
  sessionId: telegramSessions.sessionId,
  oxyUserId: telegramSessions.oxyUserId,
  telegramUserId: telegramSessions.telegramUserId,
  phoneNumber: telegramSessions.phoneNumber,
  displayName: telegramSessions.displayName,
  status: telegramSessions.status,
  lastConnected: telegramSessions.lastConnected,
  lastDisconnected: telegramSessions.lastDisconnected,
  createdAt: telegramSessions.createdAt,
} as const;

const RESTORABLE: readonly TelegramSessionStatus[] = ['connected', 'disconnected'];

// ──────────────────────────────────────────────
// Sessions
// ──────────────────────────────────────────────

export async function createTelegramSession(
  db: IntegrationsDatabase,
  input: { sessionId: string; oxyUserId: string },
): Promise<void> {
  await db.insert(telegramSessions).values({
    sessionId: input.sessionId,
    oxyUserId: input.oxyUserId,
    status: 'qr-pending',
  });
}

/** Sessions a restart should reconnect, oldest first. */
export async function findRestorableTelegramSessions(
  db: IntegrationsDatabase,
): Promise<{ sessionId: string }[]> {
  return db
    .select({ sessionId: telegramSessions.sessionId })
    .from(telegramSessions)
    .where(inArray(telegramSessions.status, [...RESTORABLE]))
    .orderBy(asc(telegramSessions.createdAt), asc(telegramSessions.sessionId));
}

/**
 * What starting a session needs, INCLUDING the stored credential. Named rather
 * than reached through `publicColumns` on purpose — this is the one caller that
 * may see it, and it never leaves the process.
 */
export async function findTelegramSessionCredential(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<{ sessionString: string | null } | null> {
  const [row] = await db
    .select({ sessionString: telegramSessions.sessionString })
    .from(telegramSessions)
    .where(eq(telegramSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

export async function findTelegramSessionOwner(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ oxyUserId: telegramSessions.oxyUserId })
    .from(telegramSessions)
    .where(eq(telegramSessions.sessionId, sessionId))
    .limit(1);
  return row?.oxyUserId ?? null;
}

/** A session with neither its `sessionString` nor its QR — the HTTP shape. */
export async function findTelegramSession(db: IntegrationsDatabase, sessionId: string) {
  const [row] = await db
    .select(PUBLIC_SESSION)
    .from(telegramSessions)
    .where(eq(telegramSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/** The login QR, named explicitly — see the WhatsApp repository for why. */
export async function findTelegramSessionQr(db: IntegrationsDatabase, sessionId: string) {
  const [row] = await db
    .select({ status: telegramSessions.status, lastQr: telegramSessions.lastQr })
    .from(telegramSessions)
    .where(eq(telegramSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

export async function listTelegramSessions(db: IntegrationsDatabase) {
  return db
    .select(SESSION_SUMMARY)
    .from(telegramSessions)
    .orderBy(asc(telegramSessions.createdAt), asc(telegramSessions.sessionId));
}

export async function listTelegramSessionsForUser(db: IntegrationsDatabase, oxyUserId: string) {
  return db
    .select(SESSION_SUMMARY)
    .from(telegramSessions)
    .where(eq(telegramSessions.oxyUserId, oxyUserId))
    .orderBy(asc(telegramSessions.createdAt), asc(telegramSessions.sessionId));
}

export async function markTelegramQrPending(
  db: IntegrationsDatabase,
  sessionId: string,
  qr: string,
): Promise<void> {
  await db
    .update(telegramSessions)
    .set({ status: 'qr-pending', lastQr: qr })
    .where(eq(telegramSessions.sessionId, sessionId));
}

export async function markTelegramConnected(
  db: IntegrationsDatabase,
  sessionId: string,
  identity: {
    phoneNumber: string;
    displayName: string;
    telegramUserId: string | undefined;
    sessionString: string;
  },
): Promise<void> {
  await db
    .update(telegramSessions)
    .set({
      status: 'connected',
      lastConnected: new Date(),
      phoneNumber: identity.phoneNumber,
      displayName: identity.displayName,
      telegramUserId: identity.telegramUserId ?? null,
      sessionString: identity.sessionString,
      lastQr: null,
    })
    .where(eq(telegramSessions.sessionId, sessionId));
}

export async function markTelegramDisconnected(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<void> {
  await db
    .update(telegramSessions)
    .set({ status: 'disconnected', lastDisconnected: new Date() })
    .where(eq(telegramSessions.sessionId, sessionId));
}

/**
 * A QR login that failed outright. Deliberately does NOT touch
 * `lastDisconnected`: the session was never connected, so there is no
 * disconnection instant to record, and the Mongo original wrote only a status.
 */
export async function markTelegramLoginFailed(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<void> {
  await db
    .update(telegramSessions)
    .set({ status: 'failed' })
    .where(eq(telegramSessions.sessionId, sessionId));
}

/** Reconnect budget spent. This one HAD a connection, so it stamps the loss. */
export async function markTelegramReconnectExhausted(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<void> {
  await db
    .update(telegramSessions)
    .set({ status: 'failed', lastDisconnected: new Date() })
    .where(eq(telegramSessions.sessionId, sessionId));
}

/** Log out: the credential is destroyed in the same statement as the status. */
export async function markTelegramLoggedOut(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<void> {
  await db
    .update(telegramSessions)
    .set({ status: 'logged-out', sessionString: null, lastQr: null })
    .where(eq(telegramSessions.sessionId, sessionId));
}

// ──────────────────────────────────────────────
// Chats
// ──────────────────────────────────────────────

export interface TelegramChatUpsert {
  readonly sessionId: string;
  readonly chatId: string;
  readonly name: string;
  readonly lastMessageTimestamp: number;
  readonly chatType: TelegramChatType;
}

/**
 * Record a chat and count one more unread message against it.
 *
 * The Mongo original combined `$set`, `$inc: { unreadCount: 1 }` and
 * `$setOnInsert`, which on INSERT left `unreadCount` at 1. The two halves are
 * spelled separately here: `1` in the inserted row, and the EXISTING value plus
 * one in the conflict branch. `excluded.unread_count` would be wrong — it is
 * the rejected row's `1`, so every update would reset the counter to one
 * instead of advancing it.
 */
export async function upsertTelegramChat(
  db: IntegrationsDatabase,
  input: TelegramChatUpsert,
): Promise<void> {
  await db
    .insert(telegramChats)
    .values({
      sessionId: input.sessionId,
      chatId: input.chatId,
      name: input.name,
      lastMessageTimestamp: input.lastMessageTimestamp,
      chatType: input.chatType,
      unreadCount: 1,
    })
    .onConflictDoUpdate({
      target: [telegramChats.sessionId, telegramChats.chatId],
      set: {
        name: input.name,
        lastMessageTimestamp: input.lastMessageTimestamp,
        chatType: input.chatType,
        unreadCount: sql`${telegramChats.unreadCount} + 1`,
      },
    });
}

/** A session's chats, most recently active first, never-used chats last. */
export async function listTelegramChats(
  db: IntegrationsDatabase,
  sessionId: string,
  limit: number,
) {
  return db
    .select({
      chatId: telegramChats.chatId,
      name: telegramChats.name,
      unreadCount: telegramChats.unreadCount,
      lastMessageTimestamp: telegramChats.lastMessageTimestamp,
    })
    .from(telegramChats)
    .where(eq(telegramChats.sessionId, sessionId))
    .orderBy(sql`${telegramChats.lastMessageTimestamp} desc nulls last`, asc(telegramChats.chatId))
    .limit(limit);
}

// ──────────────────────────────────────────────
// Messages
// ──────────────────────────────────────────────

export interface TelegramMessageInsert {
  readonly sessionId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly fromMe: boolean;
  readonly timestamp: number;
  readonly text: string;
  readonly senderName: string;
}

/** Store messages unless this session already holds that protocol id. */
export async function insertTelegramMessages(
  db: IntegrationsDatabase,
  inputs: readonly TelegramMessageInsert[],
): Promise<void> {
  const byMessageId = new Map<string, TelegramMessageInsert>();
  for (const input of inputs) {
    const key = conflictKey(input.sessionId, input.messageId);
    if (!byMessageId.has(key)) byMessageId.set(key, input);
  }
  const values = [...byMessageId.values()];
  if (values.length === 0) return;

  await db
    .insert(telegramMessages)
    .values(values.map((value) => ({ ...value })))
    .onConflictDoNothing({
      target: [telegramMessages.sessionId, telegramMessages.messageId],
    });
}

/** A chat's messages, newest first. */
export async function listTelegramMessages(
  db: IntegrationsDatabase,
  sessionId: string,
  chatId: string,
  limit: number,
) {
  return db
    .select({
      messageId: telegramMessages.messageId,
      fromMe: telegramMessages.fromMe,
      timestamp: telegramMessages.timestamp,
      text: telegramMessages.text,
      senderName: telegramMessages.senderName,
    })
    .from(telegramMessages)
    .where(and(eq(telegramMessages.sessionId, sessionId), eq(telegramMessages.chatId, chatId)))
    .orderBy(desc(telegramMessages.timestamp), asc(telegramMessages.messageId))
    .limit(limit);
}

/** The newest message text in a chat, for the chat-list preview. */
export async function findLatestTelegramMessageText(
  db: IntegrationsDatabase,
  sessionId: string,
  chatId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ text: telegramMessages.text })
    .from(telegramMessages)
    .where(and(eq(telegramMessages.sessionId, sessionId), eq(telegramMessages.chatId, chatId)))
    .orderBy(desc(telegramMessages.timestamp), asc(telegramMessages.messageId))
    .limit(1);
  return row?.text ?? null;
}
