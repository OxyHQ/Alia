/**
 * The Telegram repository against a real Postgres.
 *
 * The distinctive risk here is the unread counter. Mongo expressed it as
 * `$inc: { unreadCount: 1 }` alongside `$setOnInsert`, which starts a new chat
 * at 1 and ADVANCES an existing one. The obvious `excluded.unread_count`
 * translation is the rejected row's `1`, so every subsequent message would
 * reset the badge to one instead of counting — a wrong number, never an error.
 *
 * The second is `sessionString`: a GramJS `StringSession` is the account. It is
 * a protected column, and before this port `GET /sessions/:sessionId/status`
 * returned the whole document.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type IntegrationsDatabase } from '../../db';
import {
  createTelegramSession,
  findLatestTelegramMessageText,
  findRestorableTelegramSessions,
  findTelegramSession,
  findTelegramSessionCredential,
  findTelegramSessionOwner,
  findTelegramSessionQr,
  insertTelegramMessages,
  listTelegramChats,
  listTelegramMessages,
  listTelegramSessions,
  listTelegramSessionsForUser,
  markTelegramConnected,
  markTelegramDisconnected,
  markTelegramLoggedOut,
  markTelegramLoginFailed,
  markTelegramQrPending,
  markTelegramReconnectExhausted,
  upsertTelegramChat,
} from '../telegram-gateway/repository';

let db: IntegrationsDatabase;

const OWNER = 'tg-repo-owner';
const SESSION_STRING = `1BQANOTEuMTA4LjU2LjE3MwG7${'x'.repeat(300)}`;

async function newSession(sessionId: string, oxyUserId = OWNER): Promise<string> {
  await createTelegramSession(db, { sessionId, oxyUserId });
  return sessionId;
}

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('globalSetup did not publish DATABASE_URL');
  db = connectPostgres(url);
});

afterAll(async () => {
  await closePostgres();
});

describe('the unread counter advances rather than resetting', () => {
  it('starts a new chat at one and counts up from there', async () => {
    const sessionId = await newSession('tg-unread');
    const chat = { sessionId, chatId: '4242', chatType: 'user' as const };

    await upsertTelegramChat(db, { ...chat, name: 'First', lastMessageTimestamp: 100 });
    // The positive control for the insert branch: a counter that ignored the
    // `1` and took the column default would read 0 here.
    expect((await listTelegramChats(db, sessionId, 50))[0]?.unreadCount).toBe(1);

    await upsertTelegramChat(db, { ...chat, name: 'Second', lastMessageTimestamp: 200 });
    await upsertTelegramChat(db, { ...chat, name: 'Third', lastMessageTimestamp: 300 });

    const [row] = await listTelegramChats(db, sessionId, 50);
    expect(row?.unreadCount).toBe(3);
    // The other fields DO take the new values, so this is not just an inert set.
    expect(row?.name).toBe('Third');
    expect(row?.lastMessageTimestamp).toBe(300);
  });

  it('counts each chat separately', async () => {
    const sessionId = 'tg-unread';
    await upsertTelegramChat(db, {
      sessionId,
      chatId: '9999',
      name: 'Other',
      lastMessageTimestamp: 50,
      chatType: 'group',
    });

    const chats = await listTelegramChats(db, sessionId, 50);
    expect(chats.map((c) => [c.chatId, c.unreadCount])).toEqual([
      ['4242', 3],
      ['9999', 1],
    ]);
  });
});

describe('a chat list orders by recency with never-used chats LAST', () => {
  it('orders three chats and puts the null timestamp at the end', async () => {
    const sessionId = await newSession('tg-order');
    await upsertTelegramChat(db, { sessionId, chatId: 'old', name: 'Old', lastMessageTimestamp: 10, chatType: 'user' });
    await upsertTelegramChat(db, { sessionId, chatId: 'new', name: 'New', lastMessageTimestamp: 90, chatType: 'channel' });

    const chats = await listTelegramChats(db, sessionId, 50);
    expect(chats.map((c) => c.chatId)).toEqual(['new', 'old']);
    expect(typeof chats[0]?.lastMessageTimestamp).toBe('number');
  });
});

describe('a message list is newest first and scoped to its chat', () => {
  it('orders three messages descending', async () => {
    const sessionId = await newSession('tg-msgs');
    await insertTelegramMessages(db, [
      { sessionId, chatId: 'c1', messageId: '1', fromMe: false, timestamp: 100, text: 'oldest', senderName: 'A' },
      { sessionId, chatId: 'c1', messageId: '2', fromMe: false, timestamp: 200, text: 'middle', senderName: 'A' },
      { sessionId, chatId: 'c1', messageId: '3', fromMe: true, timestamp: 300, text: 'newest', senderName: '' },
    ]);

    const messages = await listTelegramMessages(db, sessionId, 'c1', 50);
    expect(messages.map((m) => m.text)).toEqual(['newest', 'middle', 'oldest']);
    expect(messages[0]?.fromMe).toBe(true);
    expect(await findLatestTelegramMessageText(db, sessionId, 'c1')).toBe('newest');
  });

  it('ignores another chat in the same session', async () => {
    const sessionId = 'tg-msgs';
    await insertTelegramMessages(db, [
      { sessionId, chatId: 'c2', messageId: '4', fromMe: false, timestamp: 999, text: 'elsewhere', senderName: '' },
    ]);
    expect((await listTelegramMessages(db, sessionId, 'c1', 50)).map((m) => m.text)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
    expect(await findLatestTelegramMessageText(db, sessionId, 'c2')).toBe('elsewhere');
  });

  it('keeps the first row when a batch repeats a protocol id', async () => {
    const sessionId = await newSession('tg-dup');
    await insertTelegramMessages(db, [
      { sessionId, chatId: 'c', messageId: 'same', fromMe: false, timestamp: 1, text: 'kept', senderName: '' },
      { sessionId, chatId: 'c', messageId: 'same', fromMe: false, timestamp: 2, text: 'dropped', senderName: '' },
    ]);
    expect((await listTelegramMessages(db, sessionId, 'c', 50)).map((m) => m.text)).toEqual(['kept']);
  });
});

describe('the GramJS session string stays inside the process', () => {
  it('is absent from an ordinary session read and present in the one that needs it', async () => {
    const sessionId = await newSession('tg-secret');
    await markTelegramQrPending(db, sessionId, 'tg://login?token=live');
    await markTelegramConnected(db, sessionId, {
      phoneNumber: '34600',
      displayName: 'Nate Isern',
      telegramUserId: '777',
      sessionString: SESSION_STRING,
    });

    const session = await findTelegramSession(db, sessionId);
    expect(Object.keys(session ?? {}).sort()).toEqual([
      'createdAt',
      'displayName',
      'lastConnected',
      'lastDisconnected',
      'oxyUserId',
      'phoneNumber',
      'sessionId',
      'status',
      'telegramUserId',
      'updatedAt',
    ]);
    // The positive control: the read is not simply empty.
    expect(session?.displayName).toBe('Nate Isern');
    expect(session?.telegramUserId).toBe('777');
    expect(session?.status).toBe('connected');

    // And the one caller entitled to it gets it back byte-identical.
    expect((await findTelegramSessionCredential(db, sessionId))?.sessionString).toBe(SESSION_STRING);
    // Connecting spends the QR.
    expect((await findTelegramSessionQr(db, sessionId))?.lastQr).toBeNull();
  });

  it('is destroyed by a logout, together with the QR', async () => {
    const sessionId = 'tg-secret';
    await markTelegramQrPending(db, sessionId, 'tg://login?token=live-again');
    expect((await findTelegramSessionQr(db, sessionId))?.lastQr).toBe('tg://login?token=live-again');

    await markTelegramLoggedOut(db, sessionId);

    expect((await findTelegramSessionCredential(db, sessionId))?.sessionString).toBeNull();
    const qr = await findTelegramSessionQr(db, sessionId);
    expect(qr?.lastQr).toBeNull();
    expect(qr?.status).toBe('logged-out');
  });

  it('returns null for a session that does not exist', async () => {
    expect(await findTelegramSession(db, 'tg-nope')).toBeNull();
    expect(await findTelegramSessionCredential(db, 'tg-nope')).toBeNull();
    expect(await findTelegramSessionQr(db, 'tg-nope')).toBeNull();
    expect(await findTelegramSessionOwner(db, 'tg-nope')).toBeNull();
  });
});

describe('the two failure paths record different things, as the source did', () => {
  it('a failed QR login stamps no disconnection instant', async () => {
    const sessionId = await newSession('tg-fail-login');
    await markTelegramLoginFailed(db, sessionId);

    const session = await findTelegramSession(db, sessionId);
    expect(session?.status).toBe('failed');
    expect(session?.lastDisconnected).toBeNull();
  });

  it('an exhausted reconnect budget does stamp one', async () => {
    const sessionId = await newSession('tg-fail-reconnect');
    await markTelegramReconnectExhausted(db, sessionId);

    const session = await findTelegramSession(db, sessionId);
    expect(session?.status).toBe('failed');
    expect(session?.lastDisconnected).toBeInstanceOf(Date);
  });
});

describe('restore picks up exactly the sessions a restart should reconnect', () => {
  it('takes connected and disconnected, in creation order', async () => {
    const owner = 'tg-restore-owner';
    await newSession('tg-r1', owner);
    await newSession('tg-r2', owner);
    await newSession('tg-r3', owner);
    await markTelegramConnected(db, 'tg-r1', {
      phoneNumber: '',
      displayName: '',
      telegramUserId: undefined,
      sessionString: 'restore-string',
    });
    await markTelegramDisconnected(db, 'tg-r2');

    const mine = await listTelegramSessionsForUser(db, owner);
    expect(mine.map((s) => s.sessionId)).toEqual(['tg-r1', 'tg-r2', 'tg-r3']);
    expect(mine.map((s) => s.status)).toEqual(['connected', 'disconnected', 'qr-pending']);
    // An absent telegramUserId stays null rather than becoming the string
    // "undefined", which is what a bare `?.toString()` would have stored.
    expect(mine[0]?.telegramUserId).toBeNull();

    const restorable = await findRestorableTelegramSessions(db);
    const ids = restorable.map((s) => s.sessionId);
    expect(ids).toContain('tg-r1');
    expect(ids).toContain('tg-r2');
    expect(ids).not.toContain('tg-r3');
    expect(ids.indexOf('tg-r1')).toBeLessThan(ids.indexOf('tg-r2'));
  });

  it('lists every session in creation order without the credential', async () => {
    const sessions = await listTelegramSessions(db);
    const created = sessions.map((s) => s.createdAt.getTime());
    expect(sessions.length).toBeGreaterThan(1);
    expect([...created].sort((a, b) => a - b)).toEqual(created);
    expect(Object.keys(sessions[0] ?? {})).not.toContain('sessionString');
    expect(Object.keys(sessions[0] ?? {})).toContain('phoneNumber');
  });
});
