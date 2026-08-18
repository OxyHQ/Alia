/**
 * Every Signal gateway read and write, on Postgres.
 *
 * Replaces `models.ts`. The sort, ordering and batch rules are the ones stated
 * in `../whatsapp/repository.ts`; what is specific to Signal is here.
 *
 * ## `dataDir` is host-local, and stays inside the process
 *
 * It names the directory holding signal-cli's own key material. The PATH is not
 * itself a secret, but nothing outside this process has any use for it and it
 * is meaningless on another host, so it is registered in
 * `db/protectedColumns.ts` and reached only by the daemon lifecycle below.
 * Before the port, `GET /sessions/:sessionId/status` returned the whole
 * Mongoose document and therefore returned it.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type { IntegrationsDatabase } from '../../db';
import { PROTECTED_COLUMNS } from '../../db/protectedColumns';
import {
  signalChats,
  signalMessages,
  signalSessions,
  type SignalChatType,
  type SignalSessionStatus,
} from '../../db/schema';
import { conflictKey } from '../conflictKey';

const PUBLIC_SESSION = publicColumns(signalSessions, PROTECTED_COLUMNS);

/** The subset the session-list endpoints returned under Mongoose's `.select()`. */
const SESSION_SUMMARY = {
  sessionId: signalSessions.sessionId,
  oxyUserId: signalSessions.oxyUserId,
  phoneNumber: signalSessions.phoneNumber,
  displayName: signalSessions.displayName,
  status: signalSessions.status,
  daemonPort: signalSessions.daemonPort,
  lastConnected: signalSessions.lastConnected,
  lastDisconnected: signalSessions.lastDisconnected,
  createdAt: signalSessions.createdAt,
  updatedAt: signalSessions.updatedAt,
} as const;

const RESTORABLE: readonly SignalSessionStatus[] = ['connected', 'disconnected'];

// ──────────────────────────────────────────────
// Sessions
// ──────────────────────────────────────────────

export async function createSignalSession(
  db: IntegrationsDatabase,
  input: { sessionId: string; oxyUserId: string; dataDir: string },
): Promise<void> {
  await db.insert(signalSessions).values({
    sessionId: input.sessionId,
    oxyUserId: input.oxyUserId,
    status: 'linking',
    dataDir: input.dataDir,
  });
}

/** Sessions a restart should restart a daemon for, oldest first. */
export async function findRestorableSignalSessions(
  db: IntegrationsDatabase,
): Promise<{ sessionId: string }[]> {
  return db
    .select({ sessionId: signalSessions.sessionId })
    .from(signalSessions)
    .where(inArray(signalSessions.status, [...RESTORABLE]))
    .orderBy(asc(signalSessions.createdAt), asc(signalSessions.sessionId));
}

/**
 * What the daemon lifecycle needs: the config directory to run signal-cli
 * against, the account to bind it to, and any port already assigned. `dataDir`
 * is named rather than read through `publicColumns` because this is the one
 * caller entitled to it.
 */
export async function findSignalDaemonState(db: IntegrationsDatabase, sessionId: string) {
  const [row] = await db
    .select({
      status: signalSessions.status,
      dataDir: signalSessions.dataDir,
      phoneNumber: signalSessions.phoneNumber,
      daemonPort: signalSessions.daemonPort,
    })
    .from(signalSessions)
    .where(eq(signalSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

export async function findSignalSessionOwner(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ oxyUserId: signalSessions.oxyUserId })
    .from(signalSessions)
    .where(eq(signalSessions.sessionId, sessionId))
    .limit(1);
  return row?.oxyUserId ?? null;
}

/** A session without its `dataDir` or QR — the HTTP shape. */
export async function findSignalSession(db: IntegrationsDatabase, sessionId: string) {
  const [row] = await db
    .select(PUBLIC_SESSION)
    .from(signalSessions)
    .where(eq(signalSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/** The linking QR, named explicitly — see the WhatsApp repository for why. */
export async function findSignalSessionQr(db: IntegrationsDatabase, sessionId: string) {
  const [row] = await db
    .select({ status: signalSessions.status, lastQr: signalSessions.lastQr })
    .from(signalSessions)
    .where(eq(signalSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

export async function listSignalSessions(db: IntegrationsDatabase) {
  return db
    .select(SESSION_SUMMARY)
    .from(signalSessions)
    .orderBy(asc(signalSessions.createdAt), asc(signalSessions.sessionId));
}

export async function listSignalSessionsForUser(db: IntegrationsDatabase, oxyUserId: string) {
  return db
    .select(SESSION_SUMMARY)
    .from(signalSessions)
    .where(eq(signalSessions.oxyUserId, oxyUserId))
    .orderBy(asc(signalSessions.createdAt), asc(signalSessions.sessionId));
}

export async function saveSignalLinkQr(
  db: IntegrationsDatabase,
  sessionId: string,
  qr: string,
): Promise<void> {
  await db
    .update(signalSessions)
    .set({ lastQr: qr })
    .where(eq(signalSessions.sessionId, sessionId));
}

/** Linking finished: the device is bound to a number and the QR is spent. */
export async function markSignalLinked(
  db: IntegrationsDatabase,
  sessionId: string,
  phoneNumber: string,
): Promise<void> {
  await db
    .update(signalSessions)
    .set({ status: 'connected', phoneNumber, lastConnected: new Date(), lastQr: null })
    .where(eq(signalSessions.sessionId, sessionId));
}

export async function markSignalDaemonStarted(
  db: IntegrationsDatabase,
  sessionId: string,
  daemon: { port: number; pid: number | undefined },
): Promise<void> {
  await db
    .update(signalSessions)
    .set({ daemonPort: daemon.port, daemonPid: daemon.pid ?? null })
    .where(eq(signalSessions.sessionId, sessionId));
}

export async function markSignalConnected(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<void> {
  await db
    .update(signalSessions)
    .set({ status: 'connected', lastConnected: new Date() })
    .where(eq(signalSessions.sessionId, sessionId));
}

export async function markSignalDisconnected(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<void> {
  await db
    .update(signalSessions)
    .set({ status: 'disconnected', lastDisconnected: new Date() })
    .where(eq(signalSessions.sessionId, sessionId));
}

/**
 * Every Signal failure path wrote a status and nothing else — a failed link has
 * no disconnection instant, and the reconnect-exhausted branch never recorded
 * one either. Kept as one function because the source had one behaviour.
 */
export async function markSignalFailed(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<void> {
  await db
    .update(signalSessions)
    .set({ status: 'failed' })
    .where(eq(signalSessions.sessionId, sessionId));
}

/** Unlinked: the daemon coordinates and the QR go with the status. */
export async function markSignalUnlinked(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<void> {
  await db
    .update(signalSessions)
    .set({ status: 'unlinked', lastQr: null, daemonPort: null, daemonPid: null })
    .where(eq(signalSessions.sessionId, sessionId));
}

// ──────────────────────────────────────────────
// Chats
// ──────────────────────────────────────────────

export interface SignalChatUpsert {
  readonly sessionId: string;
  readonly contactId: string;
  readonly name: string;
  readonly lastMessageTimestamp: number;
  readonly chatType: SignalChatType;
}

/**
 * Record a chat and count one more unread message against it. The `unreadCount`
 * split is the one explained in the Telegram repository: `1` on insert, the
 * EXISTING value plus one on conflict, never `excluded`.
 */
export async function upsertSignalChat(
  db: IntegrationsDatabase,
  input: SignalChatUpsert,
): Promise<void> {
  await db
    .insert(signalChats)
    .values({
      sessionId: input.sessionId,
      contactId: input.contactId,
      name: input.name,
      lastMessageTimestamp: input.lastMessageTimestamp,
      chatType: input.chatType,
      unreadCount: 1,
    })
    .onConflictDoUpdate({
      target: [signalChats.sessionId, signalChats.contactId],
      set: {
        name: input.name,
        lastMessageTimestamp: input.lastMessageTimestamp,
        chatType: input.chatType,
        unreadCount: sql`${signalChats.unreadCount} + 1`,
      },
    });
}

/** A session's chats, most recently active first, never-used chats last. */
export async function listSignalChats(db: IntegrationsDatabase, sessionId: string, limit: number) {
  return db
    .select({
      contactId: signalChats.contactId,
      name: signalChats.name,
      unreadCount: signalChats.unreadCount,
      lastMessageTimestamp: signalChats.lastMessageTimestamp,
    })
    .from(signalChats)
    .where(eq(signalChats.sessionId, sessionId))
    .orderBy(sql`${signalChats.lastMessageTimestamp} desc nulls last`, asc(signalChats.contactId))
    .limit(limit);
}

// ──────────────────────────────────────────────
// Messages
// ──────────────────────────────────────────────

export interface SignalMessageInsert {
  readonly sessionId: string;
  readonly contactId: string;
  /** signal-cli's send-timestamp used AS an id, hence `string` and not sortable. */
  readonly messageTimestamp: string;
  readonly fromMe: boolean;
  readonly timestamp: number;
  readonly text: string;
  readonly senderName: string;
}

/** Store messages unless this session already holds that send-timestamp. */
export async function insertSignalMessages(
  db: IntegrationsDatabase,
  inputs: readonly SignalMessageInsert[],
): Promise<void> {
  const byMessageTimestamp = new Map<string, SignalMessageInsert>();
  for (const input of inputs) {
    const key = conflictKey(input.sessionId, input.messageTimestamp);
    if (!byMessageTimestamp.has(key)) byMessageTimestamp.set(key, input);
  }
  const values = [...byMessageTimestamp.values()];
  if (values.length === 0) return;

  await db
    .insert(signalMessages)
    .values(values.map((value) => ({ ...value })))
    .onConflictDoNothing({
      target: [signalMessages.sessionId, signalMessages.messageTimestamp],
    });
}

/** A chat's messages, newest first. */
export async function listSignalMessages(
  db: IntegrationsDatabase,
  sessionId: string,
  contactId: string,
  limit: number,
) {
  return db
    .select({
      messageTimestamp: signalMessages.messageTimestamp,
      fromMe: signalMessages.fromMe,
      timestamp: signalMessages.timestamp,
      text: signalMessages.text,
      senderName: signalMessages.senderName,
    })
    .from(signalMessages)
    .where(and(eq(signalMessages.sessionId, sessionId), eq(signalMessages.contactId, contactId)))
    .orderBy(desc(signalMessages.timestamp), asc(signalMessages.messageTimestamp))
    .limit(limit);
}

/** The newest message text in a chat, for the chat-list preview. */
export async function findLatestSignalMessageText(
  db: IntegrationsDatabase,
  sessionId: string,
  contactId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ text: signalMessages.text })
    .from(signalMessages)
    .where(and(eq(signalMessages.sessionId, sessionId), eq(signalMessages.contactId, contactId)))
    .orderBy(desc(signalMessages.timestamp), asc(signalMessages.messageTimestamp))
    .limit(1);
  return row?.text ?? null;
}
