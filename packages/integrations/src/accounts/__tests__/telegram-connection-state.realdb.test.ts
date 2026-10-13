/**
 * The Telegram gateway's reaction to GramJS updates, through the real session
 * manager against a real Postgres. The client is the REAL GramJS
 * `TelegramClient` with only its network edges stubbed (connect, the QR login,
 * `getMe`, `invoke`); updates go in through GramJS's own `_handleUpdate` — the
 * callback its MTProto sender calls — so they reach the handlers by GramJS's
 * real event dispatch and event-builder filters.
 *
 * The gateway registered its "disconnected" handler with no event builder.
 * GramJS gives such a handler a `Raw({})`, which matches EVERY update
 * (`client/updates.js` `addEventHandler`), so the first incoming message — or
 * the `connected` GramJS dispatches after every successful ping — tore the
 * session down and scheduled a reconnect, over and over.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { _handleUpdate } from 'telegram/client/updates';
import { UpdateConnectionState } from 'telegram/network';
import { Api } from 'telegram/tl';
import { returnBigInt } from 'telegram/Helpers';
import type { TelegramClient } from 'telegram';
import { closePostgres, connectPostgres } from '../../db';

const fakes = vi.hoisted(() => ({
  clients: [] as TelegramClient[],
}));

vi.mock('telegram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('telegram')>();
  const { Api: TL } = await import('telegram/tl');
  const { AuthKey } = await import('telegram/crypto/AuthKey');
  const { LogLevel } = await import('telegram/extensions/Logger');
  const { returnBigInt: big } = await import('telegram/Helpers');
  const network = await import('telegram/network');
  const updates = await import('telegram/client/updates');

  const me = () =>
    new TL.User({ id: big(42), firstName: 'Ada', lastName: 'Lovelace', phone: '15550001' });

  /** The real client, minus the network. */
  class OfflineTelegramClient extends actual.TelegramClient {
    /** What the MTProto sender's `isConnected()` would answer; tests flip it. */
    online = false;

    override get connected(): boolean {
      return this.online;
    }

    constructor(...args: ConstructorParameters<typeof actual.TelegramClient>) {
      super(...args);
      this.setLogLevel(LogLevel.NONE);
      fakes.clients.push(this);
    }

    /** Leaves the session holding a DC and an auth key, so it saves a real session string. */
    override async connect(): Promise<boolean> {
      const key = new AuthKey();
      await key.setKey(Buffer.alloc(256, 7));
      this.session.setDC(2, '127.0.0.1', 443);
      this.session.setAuthKey(key);
      this.online = true;
      return true;
    }

    /**
     * What GramJS's MTProto sender does on every disconnect, intentional or not
     * (`network/MTProtoSender.js` `_disconnect`): report the connection down
     * through the client's update callback, then drop it.
     */
    override async _disconnect(): Promise<void> {
      this.online = false;
      updates._handleUpdate(
        this,
        new network.UpdateConnectionState(
          network.UpdateConnectionState.disconnected,
        ) as unknown as Api.TypeUpdate,
      );
    }

    override getMe(inputPeer: true): Promise<Api.InputPeerUser>;
    override getMe(inputPeer?: false): Promise<Api.User>;
    override async getMe(inputPeer?: boolean): Promise<Api.User | Api.InputPeerUser> {
      return inputPeer ? new TL.InputPeerUser({ userId: big(42), accessHash: big(0) }) : me();
    }

    override async isUserAuthorized(): Promise<boolean> {
      return true;
    }

    override async signInUserWithQrCode(
      _credentials: unknown,
      params: { qrCode?: (token: { token: Buffer; expires: number }) => Promise<void> },
    ): Promise<Api.User> {
      await params.qrCode?.({ token: Buffer.from('qr-token'), expires: 0 });
      return me();
    }

    override async invoke(): Promise<never> {
      throw new Error('offline');
    }
  }

  return { ...actual, TelegramClient: OfflineTelegramClient };
});

vi.mock('../../shared/chat-handler', () => ({
  handleIncomingMessage: vi.fn(async () => {}),
}));

vi.mock('../telegram-gateway/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telegram-gateway/repository')>();
  return { ...actual, markTelegramDisconnected: vi.fn(actual.markTelegramDisconnected) };
});

// Imported after the mocks are registered (vi.mock is hoisted above these).
import { handleIncomingMessage } from '../../shared/chat-handler';
import { markTelegramDisconnected } from '../telegram-gateway/repository';
import { sessionManager as telegram } from '../telegram-gateway/session-manager';

/**
 * The manager's timings, shortened so a test can sit through a whole grace
 * period and backoff. Same code paths, smaller numbers.
 */
const TIMINGS = {
  CONNECTION_LOSS_GRACE_MS: 60,
  BASE_RECONNECT_MS: 20,
  MAX_RECONNECT_MS: 20,
  JITTER_MAX_MS: 1,
};
/** Longer than any grace period plus backoff above. */
const PAST_GRACE_AND_BACKOFF_MS = 300;

const managerClass = telegram.constructor as unknown as Record<string, number>;
const originalTimings: Record<string, number> = {};

/** The manager's private reconnect timers, read to observe what it scheduled. */
const reconnectTimers = () =>
  (telegram as unknown as { reconnectTimers: Map<string, unknown> }).reconnectTimers;

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Feed an update in exactly as GramJS's MTProto sender does. */
function receive(client: TelegramClient, update: Api.TypeUpdate | UpdateConnectionState): void {
  _handleUpdate(client, update as Api.TypeUpdate);
}

const connectionState = (state: number) => new UpdateConnectionState(state);

/** Flip what the client reports as its connection, as the MTProto sender would. */
function setOnline(client: TelegramClient, online: boolean): void {
  (client as TelegramClient & { online: boolean }).online = online;
}

function incomingMessage(id: number): Api.UpdateNewMessage {
  return new Api.UpdateNewMessage({
    message: new Api.Message({
      id,
      peerId: new Api.PeerUser({ userId: returnBigInt(1001) }),
      date: 1_700_000_000,
      message: `hello ${id}`,
      out: false,
    }),
    pts: id,
    ptsCount: 1,
  });
}

/** A session logged in by QR, with its update handlers registered. */
async function connectedSession(): Promise<{ sessionId: string; client: TelegramClient }> {
  const { sessionId, qrPromise } = await telegram.createSession('tg-state-owner');
  await qrPromise;
  const client = telegram.getSocket(sessionId);
  if (!client) throw new Error('no client was opened');
  await waitFor(() => client.listEventHandlers().length === 2, 'the update handlers');
  return { sessionId, client };
}

const disconnectWrites = (sessionId: string) =>
  vi.mocked(markTelegramDisconnected).mock.calls.filter(([, id]) => id === sessionId).length;

beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('globalSetup did not publish DATABASE_URL');
  connectPostgres(url);
  process.env.TELEGRAM_API_ID = '1';
  process.env.TELEGRAM_API_HASH = 'test-hash';
  for (const [name, value] of Object.entries(TIMINGS)) {
    originalTimings[name] = managerClass[name];
    managerClass[name] = value;
  }
});

afterAll(async () => {
  await telegram.shutdown();
  Object.assign(managerClass, originalTimings);
  await closePostgres();
});

beforeEach(() => {
  unhandled.length = 0;
  vi.mocked(handleIncomingMessage).mockClear();
  process.on('unhandledRejection', recordUnhandled);
});

afterEach(async () => {
  process.off('unhandledRejection', recordUnhandled);
  await telegram.shutdown();
});

describe('Telegram gateway updates that are not a disconnect', () => {
  it('handles an incoming message and leaves the session up', async () => {
    const { sessionId, client } = await connectedSession();

    receive(client, incomingMessage(1));
    await waitFor(
      () => vi.mocked(handleIncomingMessage).mock.calls.length === 1,
      'the message to reach the chat handler',
    );
    await sleep(PAST_GRACE_AND_BACKOFF_MS);

    expect(vi.mocked(handleIncomingMessage).mock.calls[0][0]).toMatchObject({
      sessionId,
      chatId: '1001',
      messageText: 'hello 1',
    });
    expect(telegram.getSocket(sessionId)).toBe(client);
    expect(reconnectTimers().has(sessionId)).toBe(false);
    expect(disconnectWrites(sessionId)).toBe(0);
    expect(await telegram.getStatus(sessionId)).toMatchObject({ status: 'connected' });
  });

  it('keeps handling messages on the same client, one after another', async () => {
    const { sessionId, client } = await connectedSession();
    const opened = fakes.clients.length;

    for (const id of [11, 12, 13]) receive(client, incomingMessage(id));
    await waitFor(
      () => vi.mocked(handleIncomingMessage).mock.calls.length === 3,
      'all three messages to reach the chat handler',
    );
    await sleep(PAST_GRACE_AND_BACKOFF_MS);

    expect(fakes.clients.length).toBe(opened);
    expect(telegram.getSocket(sessionId)).toBe(client);
  });

  it('ignores the `connected` GramJS reports after every ping', async () => {
    const { sessionId, client } = await connectedSession();

    receive(client, connectionState(UpdateConnectionState.connected));
    await sleep(PAST_GRACE_AND_BACKOFF_MS);

    expect(telegram.getSocket(sessionId)).toBe(client);
    expect(reconnectTimers().has(sessionId)).toBe(false);
    expect(disconnectWrites(sessionId)).toBe(0);
  });

  it('rides out a slow ping', async () => {
    const { sessionId, client } = await connectedSession();
    const opened = fakes.clients.length;

    // GramJS's wake-up warning: a ping slower than a second reports the
    // connection down, and its answer reports it back up.
    receive(client, connectionState(UpdateConnectionState.disconnected));
    await sleep(10);
    receive(client, connectionState(UpdateConnectionState.connected));
    await sleep(PAST_GRACE_AND_BACKOFF_MS);

    expect(telegram.getSocket(sessionId)).toBe(client);
    expect(fakes.clients.length).toBe(opened);
    expect(disconnectWrites(sessionId)).toBe(0);
  });

  it('rides out a reconnect GramJS finishes on its own', async () => {
    const { sessionId, client } = await connectedSession();
    const opened = fakes.clients.length;

    setOnline(client, false);
    receive(client, connectionState(UpdateConnectionState.disconnected));
    await sleep(10);
    setOnline(client, true);
    receive(client, connectionState(UpdateConnectionState.connected));
    await sleep(PAST_GRACE_AND_BACKOFF_MS);

    expect(telegram.getSocket(sessionId)).toBe(client);
    expect(fakes.clients.length).toBe(opened);
    expect(disconnectWrites(sessionId)).toBe(0);
  });

  it('rides out a `connected` that overtook its `disconnected`', async () => {
    const { sessionId, client } = await connectedSession();

    // GramJS dispatches each update on its own promise chain, so they can land
    // out of order.
    receive(client, connectionState(UpdateConnectionState.connected));
    await sleep(10);
    receive(client, connectionState(UpdateConnectionState.disconnected));
    await sleep(PAST_GRACE_AND_BACKOFF_MS);

    expect(telegram.getSocket(sessionId)).toBe(client);
    expect(disconnectWrites(sessionId)).toBe(0);
  });
});

describe('Telegram gateway disconnects', () => {
  it('reconnects a connection that stays down exactly once', async () => {
    const { sessionId, client } = await connectedSession();
    const opened = fakes.clients.length;

    // GramJS reports one outage several times (its reconnect, a failed first
    // connect attempt, a late ping) and here never gets the connection back.
    setOnline(client, false);
    receive(client, connectionState(UpdateConnectionState.disconnected));
    receive(client, connectionState(UpdateConnectionState.disconnected));
    receive(client, connectionState(UpdateConnectionState.disconnected));

    await waitFor(() => {
      const current = telegram.getSocket(sessionId);
      return current !== undefined && current !== client;
    }, 'the session to come back on a new client');
    const replacement = telegram.getSocket(sessionId) as TelegramClient;
    await waitFor(() => replacement.listEventHandlers().length === 2, 'the new handlers');
    await sleep(PAST_GRACE_AND_BACKOFF_MS);

    expect(fakes.clients.length).toBe(opened + 1);
    expect(telegram.getSocket(sessionId)).toBe(replacement);
    expect(disconnectWrites(sessionId)).toBe(1);
    expect(await telegram.getStatus(sessionId)).toMatchObject({ status: 'connected' });
    expect(unhandled).toEqual([]);
    // Destroyed, not just disconnected: GramJS's ping loop runs until then.
    expect(client._destroyed).toBe(true);
  });

  it('reconnects a client whose auth key broke, though it still reports itself connected', async () => {
    const { sessionId, client } = await connectedSession();
    const opened = fakes.clients.length;

    receive(client, connectionState(UpdateConnectionState.broken));
    await waitFor(() => {
      const current = telegram.getSocket(sessionId);
      return current !== undefined && current !== client;
    }, 'the session to come back on a new client');
    await sleep(PAST_GRACE_AND_BACKOFF_MS);

    expect(fakes.clients.length).toBe(opened + 1);
    expect(disconnectWrites(sessionId)).toBe(1);
  });

  it('still reconnects when recording the disconnect fails', async () => {
    const { sessionId, client } = await connectedSession();
    vi.mocked(markTelegramDisconnected).mockRejectedValueOnce(new Error('postgres unreachable'));

    setOnline(client, false);
    receive(client, connectionState(UpdateConnectionState.disconnected));
    await waitFor(() => {
      const current = telegram.getSocket(sessionId);
      return current !== undefined && current !== client;
    }, 'the session to come back on a new client');
    await sleep(20);

    expect(unhandled).toEqual([]);
  });

  it('does not reconnect a session the user unlinked', async () => {
    const { sessionId, client } = await connectedSession();
    const opened = fakes.clients.length;

    // The real `destroy` → `disconnect` → `_disconnect` reports the connection
    // down through GramJS's dispatch, as the MTProto sender would.
    await telegram.disconnectSession(sessionId);
    await sleep(PAST_GRACE_AND_BACKOFF_MS);

    expect(telegram.getSocket(sessionId)).toBeUndefined();
    expect(fakes.clients.length).toBe(opened);
    expect(reconnectTimers().has(sessionId)).toBe(false);
    expect(await telegram.getStatus(sessionId)).toMatchObject({ status: 'logged-out' });
    expect(client._destroyed).toBe(true);
  });

  it('does not reconnect sessions on shutdown', async () => {
    const { sessionId, client } = await connectedSession();
    const opened = fakes.clients.length;

    await telegram.shutdown();
    await sleep(PAST_GRACE_AND_BACKOFF_MS);

    expect(telegram.getSocket(sessionId)).toBeUndefined();
    expect(fakes.clients.length).toBe(opened);
    expect(reconnectTimers().size).toBe(0);
    expect(client._destroyed).toBe(true);
  });
});
