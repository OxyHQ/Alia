import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared socket, and the thing it exists to prevent.
 *
 * Two hooks listen on this connection: `use-notification-setup` for
 * `notification` and `use-show-progress` for `show:progress`. Each used to open
 * its own, so a signed-in user on the shows screen held TWO websockets to the
 * same server, authenticated with the same token, joined to the same room —
 * every server emit delivered twice, and which socket a listener landed on
 * decided by mount order.
 *
 * That is not visible in an integration test and it is not visible in the UI.
 * It is visible in the count of connections, which is what this file asserts.
 */

/** Every socket the module has asked for, so the count is the measurement. */
const created: Array<{ on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; connected: boolean }> = [];

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const socket = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
      connected: false,
    };
    created.push(socket);
    return socket;
  }),
}));

vi.mock('@/lib/config', () => ({ default: { apiUrl: 'https://api.example.test' } }));
vi.mock('@/lib/api/client', () => ({ getSocketToken: () => 'test-token' }));

async function loadModule() {
  // A fresh module registry per test: the refcount is module state by design,
  // so a shared one would make every test after the first measure the previous
  // test's leftovers.
  vi.resetModules();
  created.length = 0;
  return import('../notifications-socket');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the shared notifications socket', () => {
  it('opens ONE connection for two holders', async () => {
    const { acquireNotificationsSocket } = await loadModule();

    const first = acquireNotificationsSocket();
    const second = acquireNotificationsSocket();

    // The whole point of the module. Two, here, is the bug it replaces.
    expect(created).toHaveLength(1);
    expect(first.socket).toBe(second.socket);
  });

  it('stays open while any holder remains', async () => {
    const { acquireNotificationsSocket } = await loadModule();

    const first = acquireNotificationsSocket();
    const second = acquireNotificationsSocket();

    first.release();
    // The notification listener lives in the app layout and the progress
    // listener in a screen; a screen unmounting must not take the app's
    // connection with it.
    expect(created[0]?.disconnect).not.toHaveBeenCalled();

    second.release();
    expect(created[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('opens a NEW connection after the last holder leaves', async () => {
    const { acquireNotificationsSocket } = await loadModule();

    acquireNotificationsSocket().release();
    expect(created).toHaveLength(1);

    // Navigating back to the screen must reconnect rather than hand out a
    // socket that was disconnected.
    acquireNotificationsSocket();
    expect(created).toHaveLength(2);
  });

  it('ignores a repeated release rather than closing somebody else\'s socket', async () => {
    const { acquireNotificationsSocket } = await loadModule();

    const first = acquireNotificationsSocket();
    const second = acquireNotificationsSocket();

    // React runs an effect cleanup twice in strict mode. Without the guard the
    // count goes to zero while `second` is still listening, and the socket it
    // holds is disconnected under it.
    first.release();
    first.release();
    first.release();

    expect(created[0]?.disconnect).not.toHaveBeenCalled();

    second.release();
    expect(created[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('joins the room once per connection, not once per holder', async () => {
    const { acquireNotificationsSocket } = await loadModule();

    acquireNotificationsSocket();
    acquireNotificationsSocket();

    const socket = created[0];
    // The room is derived server-side from the authenticated user, so it is a
    // property of the CONNECTION. The `connect` handler is registered once.
    const connectHandlers = socket?.on.mock.calls.filter(([event]) => event === 'connect') ?? [];
    expect(connectHandlers).toHaveLength(1);

    // And neither holder emitted a subscribe of its own, because the socket was
    // not yet connected.
    expect(socket?.emit).not.toHaveBeenCalled();
  });

  it('subscribes immediately for a holder that arrives AFTER the socket connected', async () => {
    const { acquireNotificationsSocket } = await loadModule();

    acquireNotificationsSocket();
    const socket = created[0];
    if (socket) socket.connected = true;

    acquireNotificationsSocket();

    // Without this the late holder never fires the `connect` handler — it
    // already fired — and sits in no room at all, receiving nothing.
    expect(socket?.emit).toHaveBeenCalledWith('subscribe-notifications');
  });
});
