/**
 * `POST /sessions/connect` for WhatsApp and the Telegram gateway, through the
 * real session managers against a real Postgres, with only the network clients
 * (Baileys, GramJS) faked.
 *
 * Both managers used to arm the QR wait and then call `startSession`, whose
 * `cleanupSocket` rejected that same wait with 'Session was reset' before
 * anything awaited it. Once the reset was followed by real I/O, that was an
 * unhandled rejection — which on Node ends the process — and the request got
 * 'Session was reset' instead of a QR. The fakes cross a macrotask on connect,
 * as the real clients do, so the rejection surfaces exactly as in production.
 *
 * The Telegram gateway also awaited GramJS's QR login, which settles only once
 * the user has scanned the code: connect could never answer with the QR.
 */

import type { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePostgres, connectPostgres } from '../../db';

interface QrLoginParams {
  qrCode: (token: { token: Buffer; expires: number }) => Promise<void>;
  onError: (err: Error) => Promise<boolean>;
}

const fakes = vi.hoisted(() => {
  const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    nextMacrotask,
    waSockets: [] as Array<{ ev: EventEmitter }>,
    /** Set to make the fake Baileys version lookup fail, as a network error would. */
    waVersion: { fail: null as Error | null },
    /** What the fake GramJS QR login does once called; set per test. */
    tgLogin: {
      run: null as null | ((params: QrLoginParams) => Promise<unknown>),
    },
  };
});

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  const { EventEmitter: Emitter } = await import('node:events');
  const makeWASocket = () => {
    const sock = { ev: new Emitter(), end: () => {}, logout: async () => {}, user: undefined };
    fakes.waSockets.push(sock);
    return sock;
  };
  return {
    ...actual,
    default: makeWASocket,
    fetchLatestBaileysVersion: async () => {
      await fakes.nextMacrotask();
      if (fakes.waVersion.fail) throw fakes.waVersion.fail;
      return { version: [2, 3000, 1], isLatest: true };
    },
  };
});

vi.mock('telegram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('telegram')>();
  class FakeTelegramClient {
    session = { save: () => 'fake-session-string' };
    async connect() {
      await fakes.nextMacrotask();
    }
    async disconnect() {}
    async getMe() {
      return { phone: '15550001', firstName: 'Ada', lastName: 'Lovelace', id: 42 };
    }
    addEventHandler() {}
    async isUserAuthorized() {
      return true;
    }
    async signInUserWithQrCode(_credentials: unknown, params: QrLoginParams) {
      if (!fakes.tgLogin.run) throw new Error('test did not configure the QR login');
      return fakes.tgLogin.run(params);
    }
  }
  return { ...actual, TelegramClient: FakeTelegramClient };
});

// Imported after the mocks are registered (vi.mock is hoisted above these).
import { sessionManager as whatsapp } from '../whatsapp/session-manager';
import { sessionManager as telegram } from '../telegram-gateway/session-manager';

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

/** Let any rejection nobody handled reach `unhandledRejection`. */
async function settle(): Promise<void> {
  await fakes.nextMacrotask();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('globalSetup did not publish DATABASE_URL');
  connectPostgres(url);
});

afterAll(async () => {
  await whatsapp.shutdown();
  await telegram.shutdown();
  await closePostgres();
});

beforeEach(() => {
  unhandled.length = 0;
  fakes.waVersion.fail = null;
  fakes.tgLogin.run = null;
  process.on('unhandledRejection', recordUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', recordUnhandled);
});

describe('WhatsApp connect', () => {
  it('answers with the first QR and rejects nothing on the way', async () => {
    const { sessionId, qrPromise } = await whatsapp.createSession('wa-connect-owner');

    const sock = fakes.waSockets.at(-1);
    if (!sock) throw new Error('no socket was opened');
    sock.ev.emit('connection.update', { qr: 'wa-qr-1' });

    await expect(qrPromise).resolves.toBe('wa-qr-1');
    await settle();
    expect(unhandled).toEqual([]);
    expect(await whatsapp.getQr(sessionId)).toMatchObject({
      status: 'qr-pending',
      lastQr: 'wa-qr-1',
    });
  });

  it('fails the request with the real cause when the socket cannot open', async () => {
    fakes.waVersion.fail = new Error('version lookup failed');

    await expect(whatsapp.createSession('wa-connect-owner')).rejects.toThrow(
      'version lookup failed',
    );
    await settle();
    expect(unhandled).toEqual([]);
  });
});

describe('Telegram gateway connect', () => {
  const TOKEN = Buffer.from('login-token');
  const QR = `tg://login?token=${TOKEN.toString('base64url')}`;

  it('answers with the QR before the user has scanned it, then records the login', async () => {
    const scanned = deferred<void>();
    fakes.tgLogin.run = async ({ qrCode }) => {
      await qrCode({ token: TOKEN, expires: 0 });
      await scanned.promise;
      return {};
    };

    const created = await Promise.race([
      telegram.createSession('tg-connect-owner'),
      new Promise<'waiting for the scan'>((resolve) =>
        setTimeout(() => resolve('waiting for the scan'), 2000),
      ),
    ]);
    try {
      if (created === 'waiting for the scan') {
        throw new Error('createSession did not return until the QR had been scanned');
      }
      await expect(created.qrPromise).resolves.toBe(QR);
      await settle();
      expect(unhandled).toEqual([]);
      expect(await telegram.getQr(created.sessionId)).toMatchObject({
        status: 'qr-pending',
        lastQr: QR,
      });

      scanned.resolve();
      await vi.waitFor(async () => {
        expect(await telegram.getStatus(created.sessionId)).toMatchObject({
          status: 'connected',
          phoneNumber: '15550001',
          displayName: 'Ada Lovelace',
        });
      });
    } finally {
      // Lets a createSession still parked on the scan finish too.
      scanned.resolve();
    }
  });

  it('fails the QR wait with the login error and marks the session failed', async () => {
    fakes.tgLogin.run = async () => {
      await fakes.nextMacrotask();
      throw new Error('AUTH_TOKEN_INVALID');
    };

    const { sessionId, qrPromise } = await telegram.createSession('tg-connect-owner');

    await expect(qrPromise).rejects.toThrow('AUTH_TOKEN_INVALID');
    await vi.waitFor(async () => {
      expect(await telegram.getStatus(sessionId)).toMatchObject({ status: 'failed' });
    });
    await settle();
    expect(unhandled).toEqual([]);
  });
});
