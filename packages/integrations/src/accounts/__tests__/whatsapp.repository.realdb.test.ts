/**
 * The WhatsApp repository against a real Postgres.
 *
 * Every assertion here is about behaviour the Mongo original had and that a
 * plausible-looking rewrite loses SILENTLY: an ordering that differs only in
 * where nulls land, an upsert that resets a counter instead of advancing it, a
 * batch that raises `21000` on its own duplicates, a credential that survives a
 * logout. None of these fail loudly, and none of them can be observed without a
 * server — a mocked `insert` accepts every statement Postgres would reject.
 *
 * The database is the throwaway one `vitest.pg.globalSetup.ts` created and
 * migrated through the REAL `src/db/migrate.ts` entrypoint.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type IntegrationsDatabase } from '../../db';
import { whatsappChats, whatsappSessions } from '../../db/schema';
import {
  createWhatsAppSession,
  deleteWhatsAppChat,
  deleteWhatsAppMessage,
  deleteWhatsAppMessagesForChat,
  findLatestWhatsAppMessageText,
  findRestorableWhatsAppSessions,
  findWhatsAppSession,
  findWhatsAppSessionOwner,
  findWhatsAppSessionQr,
  insertWhatsAppMessages,
  listWhatsAppChats,
  listWhatsAppMessages,
  listWhatsAppSessions,
  listWhatsAppSessionsForUser,
  markWhatsAppConnected,
  markWhatsAppDisconnected,
  markWhatsAppLoggedOut,
  markWhatsAppQrPending,
  readWhatsAppAuthKeys,
  readWhatsAppAuthState,
  saveWhatsAppAuthState,
  updateWhatsAppMessageText,
  upsertWhatsAppChat,
  upsertWhatsAppChats,
  writeWhatsAppAuthKeys,
  type WhatsAppMessageInsert,
} from '../whatsapp/repository';

let db: IntegrationsDatabase;

/** Namespaced so this file cannot collide with a sibling suite on one database. */
const OWNER = 'wa-repo-owner';

async function newSession(sessionId: string, oxyUserId = OWNER): Promise<string> {
  await createWhatsAppSession(db, { sessionId, oxyUserId });
  return sessionId;
}

function message(overrides: Partial<WhatsAppMessageInsert> & { sessionId: string; messageId: string }): WhatsAppMessageInsert {
  return {
    oxyUserId: OWNER,
    jid: '1@s.whatsapp.net',
    fromMe: false,
    timestamp: 1_700_000_000,
    text: 'hello',
    ...overrides,
  };
}

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('globalSetup did not publish DATABASE_URL');
  db = connectPostgres(url);
});

afterAll(async () => {
  await closePostgres();
});

describe('a chat list orders by recency with never-used chats LAST', () => {
  it('puts a null conversationTimestamp after every real one', async () => {
    /**
     * The load-bearing ordering test. Mongo's `sort({ conversationTimestamp: -1 })`
     * put a missing value LAST, because BSON orders `null` below every number.
     * Postgres `DESC` is `NULLS FIRST`, so a plain `desc()` would float exactly
     * the chats that have never carried a message to the top of the page and
     * evict real ones — with no error anywhere.
     */
    const sessionId = await newSession('wa-order');
    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 'old@s', conversationTimestamp: 100 });
    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 'new@s', conversationTimestamp: 900 });
    // A chat whose only update carried a name, exactly as `chats.update` does.
    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 'never@s', name: 'Never' });

    const chats = await listWhatsAppChats(db, sessionId, 50);

    expect(chats.map((c) => c.jid)).toEqual(['new@s', 'old@s', 'never@s']);
    expect(chats[2]?.conversationTimestamp).toBeNull();
  });

  it('honours the limit, keeping the most recent', async () => {
    const sessionId = await newSession('wa-limit');
    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 'a@s', conversationTimestamp: 1 });
    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 'b@s', conversationTimestamp: 2 });
    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 'c@s', conversationTimestamp: 3 });

    const chats = await listWhatsAppChats(db, sessionId, 2);
    expect(chats.map((c) => c.jid)).toEqual(['c@s', 'b@s']);
  });

  it('decodes the epoch column as a NUMBER, not the driver string', async () => {
    /**
     * `postgres.js` hands `int8` back as a STRING while drizzle types it
     * `number`; the `mode: 'number'` mapper is what reconciles them, and it
     * applies to the query builder only. A string here would serialize into the
     * HTTP response as `"900"` and compare wrongly against every client that
     * treats it as a number.
     *
     * Looked up BY JID rather than by position, so this asserts the decode and
     * not the ordering the test above already covers.
     */
    const chats = await listWhatsAppChats(db, 'wa-order', 50);
    const withValue = chats.find((c) => c.jid === 'new@s');
    expect(withValue?.conversationTimestamp).toBe(900);
    expect(typeof withValue?.conversationTimestamp).toBe('number');
  });
});

describe('a partial chat update leaves the fields it did not mention alone', () => {
  it('keeps unreadCount and the timestamp when only the name changes', async () => {
    /**
     * Baileys' `chats.update` reports only what changed. The Mongo original
     * built its `$set` from exactly the present keys; an upsert that always
     * wrote all three would null the two the event never mentioned.
     */
    const sessionId = await newSession('wa-partial');
    await upsertWhatsAppChat(db, {
      sessionId,
      oxyUserId: OWNER,
      jid: 'p@s',
      name: 'Before',
      unreadCount: 7,
      conversationTimestamp: 500,
    });

    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 'p@s', name: 'After' });

    const [chat] = await listWhatsAppChats(db, sessionId, 50);
    expect(chat).toEqual({
      jid: 'p@s',
      name: 'After',
      unreadCount: 7,
      conversationTimestamp: 500,
    });
  });

  it('advances updated_at on the conflict branch', async () => {
    /**
     * drizzle applies `$onUpdate` inside an `onConflictDoUpdate` set as well as
     * in a plain update, which is WHY the conflict clauses in the repositories
     * never name `updated_at`. That is a property of the pinned drizzle version
     * and of `@oxyhq/db`'s `updatedAt()`, not of this code, so it is asserted
     * rather than assumed: pinning the column in a conflict set (an explicit
     * value beats the `$onUpdate`) turns this red.
     */
    const sessionId = await newSession('wa-touch');
    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 't@s', name: 'One' });
    const [before] = await db
      .select({ updatedAt: whatsappChats.updatedAt })
      .from(whatsappChats)
      .where(eq(whatsappChats.sessionId, sessionId));

    await new Promise((resolve) => setTimeout(resolve, 5));
    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 't@s', name: 'Two' });

    const [after] = await db
      .select({ updatedAt: whatsappChats.updatedAt })
      .from(whatsappChats)
      .where(eq(whatsappChats.sessionId, sessionId));

    expect(after?.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
  });
});

describe('a batch survives its own duplicates', () => {
  it('upserts a chat batch that names the same jid twice, last one winning', async () => {
    /**
     * `ON CONFLICT DO UPDATE` raises `21000` when one statement would touch a
     * row twice, where Mongo's unordered `bulkWrite` applied both operations.
     * A history sync really does carry the same jid more than once.
     */
    const sessionId = await newSession('wa-batch-chats');
    await upsertWhatsAppChats(db, [
      { sessionId, oxyUserId: OWNER, jid: 'dup@s', name: 'First', unreadCount: 1, conversationTimestamp: 10 },
      { sessionId, oxyUserId: OWNER, jid: 'other@s', name: 'Other', unreadCount: 0, conversationTimestamp: 20 },
      { sessionId, oxyUserId: OWNER, jid: 'dup@s', name: 'Second', unreadCount: 4, conversationTimestamp: 30 },
    ]);

    const chats = await listWhatsAppChats(db, sessionId, 50);
    expect(chats.map((c) => [c.jid, c.name, c.unreadCount])).toEqual([
      ['dup@s', 'Second', 4],
      ['other@s', 'Other', 0],
    ]);
  });

  it('applies a second batch over the first, taking excluded values', async () => {
    // A positive control for the `excluded.*` clause: without it the conflict
    // branch would write nothing and this would still read 'Second'.
    const sessionId = 'wa-batch-chats';
    await upsertWhatsAppChats(db, [
      { sessionId, oxyUserId: OWNER, jid: 'dup@s', name: 'Third', unreadCount: 9, conversationTimestamp: 40 },
    ]);

    const chats = await listWhatsAppChats(db, sessionId, 50);
    expect(chats[0]).toEqual({
      jid: 'dup@s',
      name: 'Third',
      unreadCount: 9,
      conversationTimestamp: 40,
    });
  });

  it('inserts a message batch that names the same protocol id twice, FIRST winning', async () => {
    const sessionId = await newSession('wa-batch-msgs');
    await insertWhatsAppMessages(db, [
      message({ sessionId, messageId: 'm-dup', text: 'first', timestamp: 5 }),
      message({ sessionId, messageId: 'm-dup', text: 'second', timestamp: 6 }),
      message({ sessionId, messageId: 'm-other', text: 'other', timestamp: 7 }),
    ]);

    const messages = await listWhatsAppMessages(db, sessionId, '1@s.whatsapp.net', 50);
    expect(messages.map((m) => [m.messageId, m.text])).toEqual([
      ['m-other', 'other'],
      ['m-dup', 'first'],
    ]);
  });

  it('never overwrites a stored message, matching $setOnInsert', async () => {
    const sessionId = 'wa-batch-msgs';
    await insertWhatsAppMessages(db, [
      message({ sessionId, messageId: 'm-dup', text: 'REWRITTEN', timestamp: 5 }),
    ]);

    const messages = await listWhatsAppMessages(db, sessionId, '1@s.whatsapp.net', 50);
    expect(messages.find((m) => m.messageId === 'm-dup')?.text).toBe('first');
  });

  it('writes nothing at all for an empty batch', async () => {
    const sessionId = await newSession('wa-empty');
    await insertWhatsAppMessages(db, []);
    await upsertWhatsAppChats(db, []);
    expect(await listWhatsAppChats(db, sessionId, 50)).toHaveLength(0);
  });
});

describe('a message list is newest first', () => {
  it('orders by timestamp descending across several rows', async () => {
    const sessionId = await newSession('wa-msg-order');
    await insertWhatsAppMessages(db, [
      message({ sessionId, messageId: 'm1', text: 'oldest', timestamp: 100 }),
      message({ sessionId, messageId: 'm2', text: 'middle', timestamp: 200 }),
      message({ sessionId, messageId: 'm3', text: 'newest', timestamp: 300 }),
    ]);

    const messages = await listWhatsAppMessages(db, sessionId, '1@s.whatsapp.net', 50);
    expect(messages.map((m) => m.text)).toEqual(['newest', 'middle', 'oldest']);
    expect(await findLatestWhatsAppMessageText(db, sessionId, '1@s.whatsapp.net')).toBe('newest');
  });

  it('scopes to the requested chat', async () => {
    const sessionId = 'wa-msg-order';
    await insertWhatsAppMessages(db, [
      message({ sessionId, messageId: 'm4', jid: 'other@s', text: 'elsewhere', timestamp: 999 }),
    ]);

    const messages = await listWhatsAppMessages(db, sessionId, '1@s.whatsapp.net', 50);
    expect(messages.map((m) => m.text)).toEqual(['newest', 'middle', 'oldest']);
    expect(await findLatestWhatsAppMessageText(db, sessionId, 'other@s')).toBe('elsewhere');
  });

  it('edits, deletes one message and clears a chat', async () => {
    const sessionId = await newSession('wa-mutate');
    await insertWhatsAppMessages(db, [
      message({ sessionId, messageId: 'e1', text: 'before', timestamp: 1 }),
      message({ sessionId, messageId: 'e2', text: 'keep', timestamp: 2 }),
      message({ sessionId, messageId: 'e3', jid: 'keep@s', text: 'other chat', timestamp: 3 }),
    ]);

    await updateWhatsAppMessageText(db, sessionId, 'e1', 'after');
    expect(await findLatestWhatsAppMessageText(db, sessionId, '1@s.whatsapp.net')).toBe('keep');
    expect(
      (await listWhatsAppMessages(db, sessionId, '1@s.whatsapp.net', 50)).map((m) => m.text),
    ).toEqual(['keep', 'after']);

    await deleteWhatsAppMessage(db, sessionId, 'e2');
    expect(
      (await listWhatsAppMessages(db, sessionId, '1@s.whatsapp.net', 50)).map((m) => m.text),
    ).toEqual(['after']);

    await deleteWhatsAppMessagesForChat(db, sessionId, '1@s.whatsapp.net');
    expect(await listWhatsAppMessages(db, sessionId, '1@s.whatsapp.net', 50)).toHaveLength(0);
    // The positive control: the OTHER chat is untouched.
    expect(await findLatestWhatsAppMessageText(db, sessionId, 'keep@s')).toBe('other chat');
  });

  it('deletes a chat without touching another', async () => {
    const sessionId = await newSession('wa-chat-delete');
    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 'gone@s', conversationTimestamp: 1 });
    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 'stays@s', conversationTimestamp: 2 });

    await deleteWhatsAppChat(db, sessionId, 'gone@s');
    expect((await listWhatsAppChats(db, sessionId, 50)).map((c) => c.jid)).toEqual(['stays@s']);
  });
});

describe('the Baileys key map is merged per key, never replaced', () => {
  it('adds keys, keeps the ones it did not mention, and removes the ones it did', async () => {
    const sessionId = await newSession('wa-keys');
    await writeWhatsAppAuthKeys(db, sessionId, {
      set: { 'pre-key-1': { k: 1 }, 'pre-key-2': { k: 2 } },
      remove: [],
    });
    await writeWhatsAppAuthKeys(db, sessionId, {
      set: { 'pre-key-3': { k: 3 } },
      remove: ['pre-key-1'],
    });

    expect(await readWhatsAppAuthKeys(db, sessionId)).toEqual({
      'pre-key-2': { k: 2 },
      'pre-key-3': { k: 3 },
    });
  });

  it('treats a key containing a dot as one flat key, not a path', async () => {
    /**
     * The Mongo original wrote dotted `$set` paths, so an id with a `.` in it
     * would have created a nested object nothing could read back.
     */
    const sessionId = await newSession('wa-dotted');
    await writeWhatsAppAuthKeys(db, sessionId, { set: { 'session-1.2': { k: 'flat' } }, remove: [] });
    expect(await readWhatsAppAuthKeys(db, sessionId)).toEqual({ 'session-1.2': { k: 'flat' } });
  });

  it('writes nothing when there is nothing to write', async () => {
    const sessionId = await newSession('wa-noop');
    await writeWhatsAppAuthKeys(db, sessionId, { set: { a: 1 }, remove: [] });
    await writeWhatsAppAuthKeys(db, sessionId, { set: {}, remove: [] });
    expect(await readWhatsAppAuthKeys(db, sessionId)).toEqual({ a: 1 });
  });

  it('starts at an empty object rather than null', async () => {
    const sessionId = await newSession('wa-fresh-keys');
    expect(await readWhatsAppAuthKeys(db, sessionId)).toEqual({});
    expect(await readWhatsAppAuthState(db, sessionId)).toBeNull();
  });
});

describe('logging out destroys the credentials with the status', () => {
  it('clears authState, authKeys and the QR in one statement', async () => {
    const sessionId = await newSession('wa-logout');
    await saveWhatsAppAuthState(db, sessionId, { creds: { noiseKey: 'secret' } });
    await writeWhatsAppAuthKeys(db, sessionId, { set: { 'pre-key-1': { k: 1 } }, remove: [] });
    await markWhatsAppQrPending(db, sessionId, 'a-live-pairing-qr');

    // Positive control: everything really is there before the logout.
    expect(await readWhatsAppAuthState(db, sessionId)).toEqual({ creds: { noiseKey: 'secret' } });
    expect(await readWhatsAppAuthKeys(db, sessionId)).toEqual({ 'pre-key-1': { k: 1 } });
    expect((await findWhatsAppSessionQr(db, sessionId))?.lastQr).toBe('a-live-pairing-qr');

    await markWhatsAppLoggedOut(db, sessionId);

    expect(await readWhatsAppAuthState(db, sessionId)).toBeNull();
    expect(await readWhatsAppAuthKeys(db, sessionId)).toEqual({});
    const qr = await findWhatsAppSessionQr(db, sessionId);
    expect(qr?.lastQr).toBeNull();
    expect(qr?.status).toBe('logged-out');
  });
});

describe('a session read never carries a credential', () => {
  it('omits authState, authKeys and lastQr, and still returns the rest', async () => {
    const sessionId = await newSession('wa-public');
    await saveWhatsAppAuthState(db, sessionId, { creds: 'secret' });
    await markWhatsAppQrPending(db, sessionId, 'qr-secret');
    await markWhatsAppConnected(db, sessionId, { phoneNumber: '+34600', displayName: 'Nate' });

    const session = await findWhatsAppSession(db, sessionId);
    expect(session).not.toBeNull();
    // The positive control: a projection that returned NOTHING would also have
    // no protected keys, so the readable fields are asserted too.
    expect(session?.sessionId).toBe(sessionId);
    expect(session?.phoneNumber).toBe('+34600');
    expect(session?.displayName).toBe('Nate');
    expect(session?.status).toBe('connected');
    expect(Object.keys(session ?? {}).sort()).toEqual([
      'createdAt',
      'displayName',
      'lastConnected',
      'lastDisconnected',
      'oxyUserId',
      'phoneNumber',
      'sessionId',
      'status',
      'updatedAt',
    ]);
  });

  it('returns null for a session that does not exist', async () => {
    expect(await findWhatsAppSession(db, 'wa-nope')).toBeNull();
    expect(await findWhatsAppSessionOwner(db, 'wa-nope')).toBeNull();
    expect(await findWhatsAppSessionQr(db, 'wa-nope')).toBeNull();
  });
});

describe('restore picks up exactly the sessions a restart should reconnect', () => {
  it('takes connected and disconnected, in creation order, and skips the rest', async () => {
    const owner = 'wa-restore-owner';
    await newSession('wa-r1', owner);
    await newSession('wa-r2', owner);
    await newSession('wa-r3', owner);
    await markWhatsAppConnected(db, 'wa-r1', { phoneNumber: '', displayName: '' });
    await markWhatsAppDisconnected(db, 'wa-r2');
    // wa-r3 stays 'qr-pending'.

    const restorable = (await findRestorableWhatsAppSessions(db)).filter(
      (s) => s.oxyUserId === owner,
    );
    expect(restorable.map((s) => s.sessionId)).toEqual(['wa-r1', 'wa-r2']);

    // The positive control: the skipped session is present, just not restorable.
    const all = await listWhatsAppSessionsForUser(db, owner);
    expect(all.map((s) => s.sessionId)).toEqual(['wa-r1', 'wa-r2', 'wa-r3']);
    expect(all.map((s) => s.status)).toEqual(['connected', 'disconnected', 'qr-pending']);
  });

  it('lists every session in creation order, and the summary omits credentials', async () => {
    const sessions = await listWhatsAppSessions(db);
    const created = sessions.map((s) => s.createdAt.getTime());
    expect(sessions.length).toBeGreaterThan(1);
    expect([...created].sort((a, b) => a - b)).toEqual(created);
    expect(Object.keys(sessions[0] ?? {}).sort()).toEqual([
      'createdAt',
      'displayName',
      'lastConnected',
      'lastDisconnected',
      'oxyUserId',
      'phoneNumber',
      'sessionId',
      'status',
    ]);
  });

  it('scopes a user list to that user', async () => {
    const mine = await listWhatsAppSessionsForUser(db, 'wa-restore-owner');
    expect(mine.every((s) => s.oxyUserId === 'wa-restore-owner')).toBe(true);
    expect(await listWhatsAppSessionsForUser(db, 'wa-nobody')).toHaveLength(0);
  });
});

describe('a chat cannot outlive the session it belongs to', () => {
  it('cascades on delete', async () => {
    const sessionId = await newSession('wa-cascade-repo');
    await upsertWhatsAppChat(db, { sessionId, oxyUserId: OWNER, jid: 'c@s', conversationTimestamp: 1 });
    await insertWhatsAppMessages(db, [message({ sessionId, messageId: 'cm1' })]);

    await db.delete(whatsappSessions).where(eq(whatsappSessions.sessionId, sessionId));

    expect(await listWhatsAppChats(db, sessionId, 50)).toHaveLength(0);
    expect(await listWhatsAppMessages(db, sessionId, '1@s.whatsapp.net', 50)).toHaveLength(0);
  });
});
