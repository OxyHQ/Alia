/**
 * Every WhatsApp gateway read and write, on Postgres.
 *
 * Replaces `models.ts`. The session manager and the adapter call these; neither
 * builds a query itself, so the decisions below are made once.
 *
 * ## Four things a naive rewrite of the Mongo original loses
 *
 * 1. **Descending sorts put a missing value LAST.** In BSON ordering `null` is
 *    below every number, so `sort({ conversationTimestamp: -1 })` pushed a chat
 *    that has never carried a message to the BOTTOM. Postgres orders `DESC`
 *    `NULLS FIRST`, which would float exactly those chats to the TOP of a
 *    50-row page and evict real ones, so the sort is spelled `desc nulls last`.
 * 2. **`find()` with no sort returned natural (insertion) order.** Postgres
 *    guarantees nothing without an `ORDER BY`, so the list queries state
 *    `created_at` ascending — the order those endpoints de-facto returned.
 * 3. **`updated_at` is NOT named in any conflict clause, on purpose.** drizzle's
 *    `buildUpdateSet` includes every column carrying an `$onUpdate` whether or
 *    not the caller's `set` mentions it, and an explicit value would WIN over
 *    it (`set[col] ?? onUpdateFn()`) — so writing one by hand is at best
 *    redundant and at worst a way to freeze the column. Verified by mutation:
 *    pinning it to the stored value turns the "advances on conflict" test red.
 * 4. **`updateOne(…, { upsert: true })` cannot fail on a duplicate key**, and
 *    `bulkWrite` with `ordered: false` tolerated one row colliding with another
 *    in the same batch. `ON CONFLICT DO UPDATE` does NOT: two rows conflicting
 *    inside one statement raise `21000`, "cannot affect row a second time". The
 *    batch helpers collapse duplicates by their conflict key first.
 *
 * ## Reads go through `publicColumns`
 *
 * `db.select()` returns every column, including the Baileys credentials.
 * `publicColumns(table, PROTECTED_COLUMNS)` removes them from the row TYPE, so
 * a serializer that reaches for one fails `tsc`. The two paths that genuinely
 * need a protected column — the QR endpoint and the Baileys auth store — name
 * it explicitly, which is what keeps them greppable.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type { IntegrationsDatabase } from '../../db';
import { PROTECTED_COLUMNS } from '../../db/protectedColumns';
import {
  whatsappChats,
  whatsappMessages,
  whatsappSessions,
  type WhatsAppSessionStatus,
} from '../../db/schema';
import { conflictKey } from '../conflictKey';

/** Every session column a caller outside this process may see. */
const PUBLIC_SESSION = publicColumns(whatsappSessions, PROTECTED_COLUMNS);

/**
 * The subset the session-list endpoints returned under Mongoose's `.select()`.
 * Its own projection rather than a reuse of `PUBLIC_SESSION`: the two answer
 * different questions, and this one is the shape of the list response.
 */
const SESSION_SUMMARY = {
  sessionId: whatsappSessions.sessionId,
  oxyUserId: whatsappSessions.oxyUserId,
  phoneNumber: whatsappSessions.phoneNumber,
  displayName: whatsappSessions.displayName,
  status: whatsappSessions.status,
  lastConnected: whatsappSessions.lastConnected,
  lastDisconnected: whatsappSessions.lastDisconnected,
  createdAt: whatsappSessions.createdAt,
} as const;

/** Statuses `initialize()` brings back up after a restart. */
const RESTORABLE: readonly WhatsAppSessionStatus[] = ['connected', 'disconnected'];

// ──────────────────────────────────────────────
// Sessions
// ──────────────────────────────────────────────

export async function createWhatsAppSession(
  db: IntegrationsDatabase,
  input: { sessionId: string; oxyUserId: string },
): Promise<void> {
  await db.insert(whatsappSessions).values({
    sessionId: input.sessionId,
    oxyUserId: input.oxyUserId,
    status: 'qr-pending',
  });
}

/** Sessions a restart should reconnect, oldest first. */
export async function findRestorableWhatsAppSessions(
  db: IntegrationsDatabase,
): Promise<{ sessionId: string; oxyUserId: string }[]> {
  return db
    .select({ sessionId: whatsappSessions.sessionId, oxyUserId: whatsappSessions.oxyUserId })
    .from(whatsappSessions)
    .where(inArray(whatsappSessions.status, [...RESTORABLE]))
    .orderBy(asc(whatsappSessions.createdAt), asc(whatsappSessions.sessionId));
}

/** The owner of a session, or `null` when there is no such session. */
export async function findWhatsAppSessionOwner(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ oxyUserId: whatsappSessions.oxyUserId })
    .from(whatsappSessions)
    .where(eq(whatsappSessions.sessionId, sessionId))
    .limit(1);
  return row?.oxyUserId ?? null;
}

/** A session without its credentials — the shape every HTTP response uses. */
export async function findWhatsAppSession(db: IntegrationsDatabase, sessionId: string) {
  const [row] = await db
    .select(PUBLIC_SESSION)
    .from(whatsappSessions)
    .where(eq(whatsappSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

/**
 * The pairing QR, named explicitly because `lastQr` is protected: it is a live
 * credential while it is valid, and this is the ONE path whose whole purpose is
 * to hand it to the user who is about to scan it.
 */
export async function findWhatsAppSessionQr(db: IntegrationsDatabase, sessionId: string) {
  const [row] = await db
    .select({
      status: whatsappSessions.status,
      phoneNumber: whatsappSessions.phoneNumber,
      displayName: whatsappSessions.displayName,
      lastQr: whatsappSessions.lastQr,
    })
    .from(whatsappSessions)
    .where(eq(whatsappSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

export async function listWhatsAppSessions(db: IntegrationsDatabase) {
  return db
    .select(SESSION_SUMMARY)
    .from(whatsappSessions)
    .orderBy(asc(whatsappSessions.createdAt), asc(whatsappSessions.sessionId));
}

export async function listWhatsAppSessionsForUser(db: IntegrationsDatabase, oxyUserId: string) {
  return db
    .select(SESSION_SUMMARY)
    .from(whatsappSessions)
    .where(eq(whatsappSessions.oxyUserId, oxyUserId))
    .orderBy(asc(whatsappSessions.createdAt), asc(whatsappSessions.sessionId));
}

export async function markWhatsAppQrPending(
  db: IntegrationsDatabase,
  sessionId: string,
  qr: string,
): Promise<void> {
  await db
    .update(whatsappSessions)
    .set({ status: 'qr-pending', lastQr: qr })
    .where(eq(whatsappSessions.sessionId, sessionId));
}

export async function markWhatsAppConnected(
  db: IntegrationsDatabase,
  sessionId: string,
  identity: { phoneNumber: string; displayName: string },
): Promise<void> {
  await db
    .update(whatsappSessions)
    .set({
      status: 'connected',
      lastConnected: new Date(),
      phoneNumber: identity.phoneNumber,
      displayName: identity.displayName,
      lastQr: null,
    })
    .where(eq(whatsappSessions.sessionId, sessionId));
}

export async function markWhatsAppDisconnected(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<void> {
  await db
    .update(whatsappSessions)
    .set({ status: 'disconnected', lastDisconnected: new Date() })
    .where(eq(whatsappSessions.sessionId, sessionId));
}

export async function markWhatsAppFailed(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<void> {
  await db
    .update(whatsappSessions)
    .set({ status: 'failed', lastDisconnected: new Date() })
    .where(eq(whatsappSessions.sessionId, sessionId));
}

/**
 * Log out: the status changes AND every credential is destroyed in the same
 * statement, so no window exists in which a logged-out session still holds
 * usable Baileys key material.
 */
export async function markWhatsAppLoggedOut(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<void> {
  await db
    .update(whatsappSessions)
    .set({ status: 'logged-out', authState: null, authKeys: {}, lastQr: null })
    .where(eq(whatsappSessions.sessionId, sessionId));
}

// ──────────────────────────────────────────────
// Baileys auth state — protected columns, named on purpose
// ──────────────────────────────────────────────

/** The serialized Baileys credentials, or `null` for a session yet to pair. */
export async function readWhatsAppAuthState(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<unknown> {
  const [row] = await db
    .select({ authState: whatsappSessions.authState })
    .from(whatsappSessions)
    .where(eq(whatsappSessions.sessionId, sessionId))
    .limit(1);
  return row?.authState ?? null;
}

/**
 * The signal key map, keyed by Baileys' own type-and-id string. Read fresh on
 * every `get`, exactly as the Mongo store did — Baileys' cache sits in front.
 */
export async function readWhatsAppAuthKeys(
  db: IntegrationsDatabase,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ authKeys: whatsappSessions.authKeys })
    .from(whatsappSessions)
    .where(eq(whatsappSessions.sessionId, sessionId))
    .limit(1);
  const keys = row?.authKeys;
  return keys !== null && typeof keys === 'object' ? (keys as Record<string, unknown>) : {};
}

export async function saveWhatsAppAuthState(
  db: IntegrationsDatabase,
  sessionId: string,
  authState: unknown,
): Promise<void> {
  await db
    .update(whatsappSessions)
    .set({ authState })
    .where(eq(whatsappSessions.sessionId, sessionId));
}

/**
 * Merge some signal keys in and drop others, in ONE statement.
 *
 * The Mongo original wrote dotted paths under `authKeys` in `$set` and
 * `$unset`, so a key containing a `.` would silently have created a nested
 * object. `||` and `- text[]` take the key as an opaque string, so no key name
 * can be reinterpreted as a path.
 *
 * `||` is a SHALLOW merge, which is what the single-level dotted `$set` was.
 */
export async function writeWhatsAppAuthKeys(
  db: IntegrationsDatabase,
  sessionId: string,
  change: { set: Record<string, unknown>; remove: readonly string[] },
): Promise<void> {
  if (Object.keys(change.set).length === 0 && change.remove.length === 0) return;

  const merged = sql`${whatsappSessions.authKeys} || ${JSON.stringify(change.set)}::jsonb`;
  await db
    .update(whatsappSessions)
    .set({ authKeys: sql`(${merged}) - ${sql.param([...change.remove])}::text[]` })
    .where(eq(whatsappSessions.sessionId, sessionId));
}

// ──────────────────────────────────────────────
// Chats
// ──────────────────────────────────────────────

/**
 * The fields a chat sync may carry. `undefined` means "this event said nothing
 * about it" — Baileys' `chats.update` reports only what changed, and the Mongo
 * original built its `$set` from exactly the present keys, leaving the rest
 * untouched on an existing row and at the column default on a new one.
 */
export interface WhatsAppChatUpsert {
  readonly sessionId: string;
  readonly oxyUserId: string;
  readonly jid: string;
  readonly name?: string;
  readonly unreadCount?: number;
  readonly conversationTimestamp?: number;
}

export async function upsertWhatsAppChat(
  db: IntegrationsDatabase,
  input: WhatsAppChatUpsert,
): Promise<void> {
  const changes: Record<string, unknown> = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.unreadCount !== undefined) changes.unreadCount = input.unreadCount;
  if (input.conversationTimestamp !== undefined) {
    changes.conversationTimestamp = input.conversationTimestamp;
  }

  await db
    .insert(whatsappChats)
    .values({
      sessionId: input.sessionId,
      oxyUserId: input.oxyUserId,
      jid: input.jid,
      ...changes,
    })
    .onConflictDoUpdate({
      target: [whatsappChats.sessionId, whatsappChats.jid],
      set: changes,
    });
}

/**
 * A history-sync chat, where every field is present — which is what lets a
 * whole batch be ONE statement under a single `excluded` clause.
 */
export interface WhatsAppChatSync {
  readonly sessionId: string;
  readonly oxyUserId: string;
  readonly jid: string;
  readonly name: string;
  readonly unreadCount: number;
  readonly conversationTimestamp: number;
}

/**
 * A history-sync batch of chats. Duplicates inside the batch are collapsed
 * LAST-WINS, matching the order an unordered `bulkWrite` applied them in.
 */
export async function upsertWhatsAppChats(
  db: IntegrationsDatabase,
  inputs: readonly WhatsAppChatSync[],
): Promise<void> {
  const byJid = new Map<string, WhatsAppChatSync>();
  for (const input of inputs) byJid.set(conflictKey(input.sessionId, input.jid), input);
  const values = [...byJid.values()];
  if (values.length === 0) return;

  await db
    .insert(whatsappChats)
    .values(values.map((value) => ({ ...value })))
    .onConflictDoUpdate({
      target: [whatsappChats.sessionId, whatsappChats.jid],
      set: {
        name: sql`excluded.name`,
        unreadCount: sql`excluded.unread_count`,
        conversationTimestamp: sql`excluded.conversation_timestamp`,
      },
    });
}

export async function deleteWhatsAppChat(
  db: IntegrationsDatabase,
  sessionId: string,
  jid: string,
): Promise<void> {
  await db
    .delete(whatsappChats)
    .where(and(eq(whatsappChats.sessionId, sessionId), eq(whatsappChats.jid, jid)));
}

/** A session's chats, most recently active first, never-used chats last. */
export async function listWhatsAppChats(
  db: IntegrationsDatabase,
  sessionId: string,
  limit: number,
) {
  return db
    .select({
      jid: whatsappChats.jid,
      name: whatsappChats.name,
      unreadCount: whatsappChats.unreadCount,
      conversationTimestamp: whatsappChats.conversationTimestamp,
    })
    .from(whatsappChats)
    .where(eq(whatsappChats.sessionId, sessionId))
    .orderBy(sql`${whatsappChats.conversationTimestamp} desc nulls last`, asc(whatsappChats.jid))
    .limit(limit);
}

// ──────────────────────────────────────────────
// Messages
// ──────────────────────────────────────────────

export interface WhatsAppMessageInsert {
  readonly sessionId: string;
  readonly oxyUserId: string;
  readonly jid: string;
  readonly messageId: string;
  readonly fromMe: boolean;
  readonly timestamp: number;
  readonly text: string;
  readonly pushName?: string;
}

/**
 * Store messages unless this session already has one with that protocol id —
 * the `$setOnInsert` upsert, which never overwrote an existing row.
 */
export async function insertWhatsAppMessages(
  db: IntegrationsDatabase,
  inputs: readonly WhatsAppMessageInsert[],
): Promise<void> {
  const byMessageId = new Map<string, WhatsAppMessageInsert>();
  for (const input of inputs) {
    const key = conflictKey(input.sessionId, input.messageId);
    // FIRST wins, matching `$setOnInsert`: the earliest row is the one kept.
    if (!byMessageId.has(key)) byMessageId.set(key, input);
  }
  const values = [...byMessageId.values()];
  if (values.length === 0) return;

  await db
    .insert(whatsappMessages)
    .values(values.map((value) => ({ ...value })))
    .onConflictDoNothing({
      target: [whatsappMessages.sessionId, whatsappMessages.messageId],
    });
}

/** Apply an edit. An absent row is left alone, as `updateOne` without upsert was. */
export async function updateWhatsAppMessageText(
  db: IntegrationsDatabase,
  sessionId: string,
  messageId: string,
  text: string,
): Promise<void> {
  await db
    .update(whatsappMessages)
    .set({ text })
    .where(
      and(eq(whatsappMessages.sessionId, sessionId), eq(whatsappMessages.messageId, messageId)),
    );
}

export async function deleteWhatsAppMessage(
  db: IntegrationsDatabase,
  sessionId: string,
  messageId: string,
): Promise<void> {
  await db
    .delete(whatsappMessages)
    .where(
      and(eq(whatsappMessages.sessionId, sessionId), eq(whatsappMessages.messageId, messageId)),
    );
}

export async function deleteWhatsAppMessagesForChat(
  db: IntegrationsDatabase,
  sessionId: string,
  jid: string,
): Promise<void> {
  await db
    .delete(whatsappMessages)
    .where(and(eq(whatsappMessages.sessionId, sessionId), eq(whatsappMessages.jid, jid)));
}

/** A chat's messages, newest first. */
export async function listWhatsAppMessages(
  db: IntegrationsDatabase,
  sessionId: string,
  jid: string,
  limit: number,
) {
  return db
    .select({
      messageId: whatsappMessages.messageId,
      fromMe: whatsappMessages.fromMe,
      timestamp: whatsappMessages.timestamp,
      text: whatsappMessages.text,
      pushName: whatsappMessages.pushName,
    })
    .from(whatsappMessages)
    .where(and(eq(whatsappMessages.sessionId, sessionId), eq(whatsappMessages.jid, jid)))
    .orderBy(desc(whatsappMessages.timestamp), asc(whatsappMessages.messageId))
    .limit(limit);
}

/** The newest message text in a chat, for the chat-list preview. */
export async function findLatestWhatsAppMessageText(
  db: IntegrationsDatabase,
  sessionId: string,
  jid: string,
): Promise<string | null> {
  const [row] = await db
    .select({ text: whatsappMessages.text })
    .from(whatsappMessages)
    .where(and(eq(whatsappMessages.sessionId, sessionId), eq(whatsappMessages.jid, jid)))
    .orderBy(desc(whatsappMessages.timestamp), asc(whatsappMessages.messageId))
    .limit(1);
  return row?.text ?? null;
}
