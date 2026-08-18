/**
 * The Signal repository against a real Postgres.
 *
 * Signal's lifecycle is the one that differs from the other two: it LINKS a
 * device rather than scanning into a web session, so its statuses are `linking`
 * and `unlinked`, and its daemon state (`dataDir`, `daemonPort`, `daemonPid`)
 * is host-local. `dataDir` names the directory holding signal-cli's own key
 * material and is a protected column; before this port,
 * `GET /sessions/:sessionId/status` returned the whole document.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type IntegrationsDatabase } from '../../db';
import {
  createSignalSession,
  findLatestSignalMessageText,
  findRestorableSignalSessions,
  findSignalDaemonState,
  findSignalSession,
  findSignalSessionOwner,
  findSignalSessionQr,
  insertSignalMessages,
  listSignalChats,
  listSignalMessages,
  listSignalSessions,
  listSignalSessionsForUser,
  markSignalConnected,
  markSignalDaemonStarted,
  markSignalDisconnected,
  markSignalFailed,
  markSignalLinked,
  markSignalUnlinked,
  saveSignalLinkQr,
  upsertSignalChat,
} from '../signal/repository';

let db: IntegrationsDatabase;

const OWNER = 'sig-repo-owner';

async function newSession(sessionId: string, oxyUserId = OWNER): Promise<string> {
  await createSignalSession(db, {
    sessionId,
    oxyUserId,
    dataDir: `/var/lib/signal/${sessionId}`,
  });
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

describe('a new session starts in linking', () => {
  it('records the data directory and no daemon', async () => {
    const sessionId = await newSession('sig-new');
    const daemon = await findSignalDaemonState(db, sessionId);
    expect(daemon).toEqual({
      status: 'linking',
      dataDir: '/var/lib/signal/sig-new',
      phoneNumber: null,
      daemonPort: null,
    });
    expect(await findSignalSessionOwner(db, sessionId)).toBe(OWNER);
  });
});

describe('the link, daemon and unlink lifecycle', () => {
  it('carries the QR, then the number, then the daemon coordinates', async () => {
    const sessionId = await newSession('sig-life');

    await saveSignalLinkQr(db, sessionId, 'sgnl://linkdevice?uuid=live');
    expect((await findSignalSessionQr(db, sessionId))?.lastQr).toBe('sgnl://linkdevice?uuid=live');

    await markSignalLinked(db, sessionId, '+34600111222');
    const linked = await findSignalSession(db, sessionId);
    expect(linked?.status).toBe('connected');
    expect(linked?.phoneNumber).toBe('+34600111222');
    expect(linked?.lastConnected).toBeInstanceOf(Date);
    // Linking spends the QR.
    expect((await findSignalSessionQr(db, sessionId))?.lastQr).toBeNull();

    await markSignalDaemonStarted(db, sessionId, { port: 9100, pid: 4242 });
    expect((await findSignalDaemonState(db, sessionId))?.daemonPort).toBe(9100);

    await markSignalUnlinked(db, sessionId);
    const after = await findSignalDaemonState(db, sessionId);
    expect(after?.status).toBe('unlinked');
    expect(after?.daemonPort).toBeNull();
  });

  it('stores a daemon with no pid as null rather than a string', async () => {
    const sessionId = await newSession('sig-nopid');
    await markSignalDaemonStarted(db, sessionId, { port: 9101, pid: undefined });
    expect((await findSignalDaemonState(db, sessionId))?.daemonPort).toBe(9101);
  });

  it('a failure records the status and nothing else, as the source did', async () => {
    const sessionId = await newSession('sig-fail');
    await markSignalFailed(db, sessionId);
    const session = await findSignalSession(db, sessionId);
    expect(session?.status).toBe('failed');
    expect(session?.lastDisconnected).toBeNull();
  });

  it('a disconnect does stamp the loss', async () => {
    const sessionId = await newSession('sig-disc');
    await markSignalDisconnected(db, sessionId);
    const session = await findSignalSession(db, sessionId);
    expect(session?.status).toBe('disconnected');
    expect(session?.lastDisconnected).toBeInstanceOf(Date);
  });
});

describe('the data directory stays inside the process', () => {
  it('is absent from an ordinary session read and present in the daemon read', async () => {
    const sessionId = await newSession('sig-secret');
    await saveSignalLinkQr(db, sessionId, 'sgnl://linkdevice?uuid=secret');

    const session = await findSignalSession(db, sessionId);
    expect(Object.keys(session ?? {}).sort()).toEqual([
      'createdAt',
      'daemonPid',
      'daemonPort',
      'displayName',
      'lastConnected',
      'lastDisconnected',
      'oxyUserId',
      'phoneNumber',
      'sessionId',
      'status',
      'updatedAt',
    ]);
    // The positive control: the read is not simply empty.
    expect(session?.sessionId).toBe(sessionId);
    expect(session?.status).toBe('linking');

    expect((await findSignalDaemonState(db, sessionId))?.dataDir).toBe('/var/lib/signal/sig-secret');
    expect((await findSignalSessionQr(db, sessionId))?.lastQr).toBe('sgnl://linkdevice?uuid=secret');
  });

  it('returns null for a session that does not exist', async () => {
    expect(await findSignalSession(db, 'sig-nope')).toBeNull();
    expect(await findSignalDaemonState(db, 'sig-nope')).toBeNull();
    expect(await findSignalSessionQr(db, 'sig-nope')).toBeNull();
    expect(await findSignalSessionOwner(db, 'sig-nope')).toBeNull();
  });
});

describe('the unread counter advances rather than resetting', () => {
  it('starts at one and counts up, while the other fields take the new values', async () => {
    const sessionId = await newSession('sig-unread');
    const chat = { sessionId, contactId: '+34600999888' };

    await upsertSignalChat(db, { ...chat, name: 'First', lastMessageTimestamp: 100, chatType: 'direct' });
    expect((await listSignalChats(db, sessionId, 50))[0]?.unreadCount).toBe(1);

    await upsertSignalChat(db, { ...chat, name: 'Second', lastMessageTimestamp: 200, chatType: 'group' });
    const [row] = await listSignalChats(db, sessionId, 50);
    expect(row?.unreadCount).toBe(2);
    expect(row?.name).toBe('Second');
    expect(row?.lastMessageTimestamp).toBe(200);
  });

  it('orders a chat list by recency', async () => {
    const sessionId = 'sig-unread';
    await upsertSignalChat(db, {
      sessionId,
      contactId: 'group-id',
      name: 'Group',
      lastMessageTimestamp: 50,
      chatType: 'group',
    });

    const chats = await listSignalChats(db, sessionId, 50);
    expect(chats.map((c) => c.contactId)).toEqual(['+34600999888', 'group-id']);
    expect(typeof chats[0]?.lastMessageTimestamp).toBe('number');
  });
});

describe('a message list is newest first and scoped to its contact', () => {
  it('orders three messages descending', async () => {
    const sessionId = await newSession('sig-msgs');
    await insertSignalMessages(db, [
      { sessionId, contactId: 'c1', messageTimestamp: '1700000000100', fromMe: false, timestamp: 100, text: 'oldest', senderName: 'A' },
      { sessionId, contactId: 'c1', messageTimestamp: '1700000000200', fromMe: false, timestamp: 200, text: 'middle', senderName: 'A' },
      { sessionId, contactId: 'c1', messageTimestamp: '1700000000300', fromMe: false, timestamp: 300, text: 'newest', senderName: 'B' },
    ]);

    const messages = await listSignalMessages(db, sessionId, 'c1', 50);
    expect(messages.map((m) => m.text)).toEqual(['newest', 'middle', 'oldest']);
    expect(messages[0]?.senderName).toBe('B');
    expect(await findLatestSignalMessageText(db, sessionId, 'c1')).toBe('newest');
  });

  it('ignores another contact in the same session', async () => {
    const sessionId = 'sig-msgs';
    await insertSignalMessages(db, [
      { sessionId, contactId: 'c2', messageTimestamp: '1700000009999', fromMe: false, timestamp: 999, text: 'elsewhere', senderName: '' },
    ]);
    expect((await listSignalMessages(db, sessionId, 'c1', 50)).map((m) => m.text)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
    expect(await findLatestSignalMessageText(db, sessionId, 'c2')).toBe('elsewhere');
  });

  it('keeps the first row when a batch repeats a send-timestamp', async () => {
    const sessionId = await newSession('sig-dup');
    await insertSignalMessages(db, [
      { sessionId, contactId: 'c', messageTimestamp: 'same', fromMe: false, timestamp: 1, text: 'kept', senderName: '' },
      { sessionId, contactId: 'c', messageTimestamp: 'same', fromMe: false, timestamp: 2, text: 'dropped', senderName: '' },
    ]);
    expect((await listSignalMessages(db, sessionId, 'c', 50)).map((m) => m.text)).toEqual(['kept']);
  });
});

describe('restore picks up exactly the sessions a restart should reconnect', () => {
  it('takes connected and disconnected, in creation order, and skips linking', async () => {
    const owner = 'sig-restore-owner';
    await newSession('sig-r1', owner);
    await newSession('sig-r2', owner);
    await newSession('sig-r3', owner);
    await markSignalConnected(db, 'sig-r1');
    await markSignalDisconnected(db, 'sig-r2');

    const mine = await listSignalSessionsForUser(db, owner);
    expect(mine.map((s) => s.sessionId)).toEqual(['sig-r1', 'sig-r2', 'sig-r3']);
    expect(mine.map((s) => s.status)).toEqual(['connected', 'disconnected', 'linking']);

    const ids = (await findRestorableSignalSessions(db)).map((s) => s.sessionId);
    expect(ids).toContain('sig-r1');
    expect(ids).toContain('sig-r2');
    expect(ids).not.toContain('sig-r3');
    expect(ids.indexOf('sig-r1')).toBeLessThan(ids.indexOf('sig-r2'));
  });

  it('lists every session in creation order without the data directory', async () => {
    const sessions = await listSignalSessions(db);
    const created = sessions.map((s) => s.createdAt.getTime());
    expect(sessions.length).toBeGreaterThan(1);
    expect([...created].sort((a, b) => a - b)).toEqual(created);
    expect(Object.keys(sessions[0] ?? {})).not.toContain('dataDir');
    expect(Object.keys(sessions[0] ?? {})).toContain('daemonPort');
  });
});
