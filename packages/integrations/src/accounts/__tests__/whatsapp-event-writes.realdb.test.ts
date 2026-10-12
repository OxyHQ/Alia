/**
 * WhatsApp socket event handlers whose DB writes fail, through the real session
 * manager against a real Postgres. Baileys is faked (a plain EventEmitter, as
 * the real `sock.ev` is); single repository writes are made to fail once, as a
 * Postgres blip would.
 *
 * Baileys' emitter drops the promise an async listener returns, so a write that
 * rejected inside `connection.update` or `messages.upsert` was an unhandled
 * rejection — on Node that ends the process, with every other account and bot
 * on it. It also cut the handler short: the QR never reached the waiting
 * request, and a dropped socket was never rescheduled.
 */

import type { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePostgres, connectPostgres } from '../../db';

const fakes = vi.hoisted(() => ({
  waSockets: [] as Array<{ ev: EventEmitter }>,
}));

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
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
  };
});

vi.mock('../whatsapp/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../whatsapp/repository')>();
  return {
    ...actual,
    markWhatsAppQrPending: vi.fn(actual.markWhatsAppQrPending),
    markWhatsAppDisconnected: vi.fn(actual.markWhatsAppDisconnected),
    findWhatsAppSessionOwner: vi.fn(actual.findWhatsAppSessionOwner),
  };
});

// Imported after the mocks are registered (vi.mock is hoisted above these).
import {
  findWhatsAppSessionOwner,
  markWhatsAppDisconnected,
  markWhatsAppQrPending,
} from '../whatsapp/repository';
import { sessionManager as whatsapp } from '../whatsapp/session-manager';

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

/** Let any rejection nobody handled reach `unhandledRejection`. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function connectedSocket(): Promise<{ sessionId: string; ev: EventEmitter }> {
  const { sessionId, qrPromise } = await whatsapp.createSession('wa-writes-owner');
  const sock = fakes.waSockets.at(-1);
  if (!sock) throw new Error('no socket was opened');
  sock.ev.emit('connection.update', { qr: 'wa-qr' });
  await qrPromise;
  return { sessionId, ev: sock.ev };
}

/** The manager's private reconnect timers, read to observe what it scheduled. */
const reconnectTimers = () =>
  (whatsapp as unknown as { reconnectTimers: Map<string, unknown> }).reconnectTimers;

const postgresDown = () => new Error('postgres unreachable');

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('globalSetup did not publish DATABASE_URL');
  connectPostgres(url);
});

afterAll(async () => {
  await whatsapp.shutdown();
  await closePostgres();
});

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', recordUnhandled);
});

afterEach(async () => {
  process.off('unhandledRejection', recordUnhandled);
  await whatsapp.shutdown();
});

describe('WhatsApp socket events with a failing write', () => {
  it('still answers connect with the QR when storing it fails', async () => {
    vi.mocked(markWhatsAppQrPending).mockRejectedValueOnce(postgresDown());
    const { qrPromise } = await whatsapp.createSession('wa-writes-owner');
    const sock = fakes.waSockets.at(-1);
    if (!sock) throw new Error('no socket was opened');

    sock.ev.emit('connection.update', { qr: 'wa-qr-unstored' });

    await expect(within(qrPromise, 2_000, 'connect never received the QR')).resolves.toBe(
      'wa-qr-unstored',
    );
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('still schedules the reconnect when recording the disconnect fails', async () => {
    const { sessionId, ev } = await connectedSocket();
    vi.mocked(markWhatsAppDisconnected).mockRejectedValueOnce(postgresDown());

    ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } }, date: new Date() },
    });
    await waitFor(
      () => vi.mocked(markWhatsAppDisconnected).mock.calls.some(([, id]) => id === sessionId),
      'the disconnected write',
    );
    await settle();

    expect(reconnectTimers().has(sessionId)).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it('survives an incoming message whose owner lookup fails', async () => {
    const { ev } = await connectedSocket();
    vi.mocked(findWhatsAppSessionOwner).mockRejectedValueOnce(postgresDown());

    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { id: 'msg-1', remoteJid: '15550003@s.whatsapp.net', fromMe: false },
          message: { conversation: 'hello' },
          messageTimestamp: 1_700_000_000,
        },
      ],
    });
    await waitFor(
      () => vi.mocked(findWhatsAppSessionOwner).mock.calls.length > 0,
      'the owner lookup',
    );
    await settle();

    expect(unhandled).toEqual([]);
  });
});
