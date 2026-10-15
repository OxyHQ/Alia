import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;
interface FakeSocket {
  url: string;
  options: { auth: (cb: (a: unknown) => void) => void };
  handlers: Map<string, Handler>;
  active: boolean;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}
const mocks = vi.hoisted(() => ({ sockets: [] as unknown[] }));
const sockets = () => mocks.sockets as FakeSocket[];

vi.mock('socket.io-client', () => ({
  io: (url: string, options: unknown) => {
    const handlers = new Map<string, Handler>();
    const socket = {
      url,
      options,
      handlers,
      active: true,
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      emit: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      removeAllListeners: vi.fn(() => handlers.clear()),
    };
    mocks.sockets.push(socket);
    return socket;
  },
}));

import { ACTIVITY_QUIET_MS, acquireActivitySocket } from '../../src/lib/activity-socket';
import { selectAliaActivity, useAliaActivityStore } from '../../src/lib/activity-store';

const now = () => selectAliaActivity(useAliaActivityStore.getState());
const fire = (event: string, ...args: unknown[]) =>
  sockets().at(-1)?.handlers.get(event)?.(...args);

describe('activity socket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.sockets.length = 0;
    useAliaActivityStore.setState({ local: {}, remote: {} });
  });
  afterEach(() => vi.useRealTimers());

  it('connects once for any number of holders, subscribes on connect, and closes with the last', () => {
    const releaseA = acquireActivitySocket('https://api.test', () => 't1');
    const releaseB = acquireActivitySocket('https://api.test', () => 't1');
    expect(sockets()).toHaveLength(1);

    fire('connect');
    expect(sockets()[0].emit).toHaveBeenCalledWith('subscribe-alia-activity');

    releaseA();
    releaseA();
    expect(sockets()[0].disconnect).not.toHaveBeenCalled();
    releaseB();
    expect(sockets()[0].disconnect).toHaveBeenCalledTimes(1);

    // A later holder opens a fresh connection.
    const releaseC = acquireActivitySocket('https://api.test', () => 't1');
    expect(sockets()).toHaveLength(2);
    releaseC();
  });

  it('reads the token at every handshake', () => {
    let token = 'first';
    const release = acquireActivitySocket('https://api.test', () => token);
    const seen: unknown[] = [];
    sockets()[0].options.auth((a) => seen.push(a));
    token = 'rotated';
    sockets()[0].options.auth((a) => seen.push(a));
    expect(seen).toEqual([{ token: 'first' }, { token: 'rotated' }]);
    release();
  });

  it('maps server events to states per session, ignoring malformed ones', () => {
    const release = acquireActivitySocket('https://api.test', () => 't');
    fire('alia:activity', { state: 'thinking', sessionId: 's1' });
    expect(now()).toBe('thinking');
    fire('alia:activity', { state: 'working', sessionId: 's2' });
    expect(now()).toBe('working');
    fire('alia:activity', { state: 'idle', sessionId: 's2' });
    expect(now()).toBe('thinking');
    fire('alia:activity', { state: 'bogus', sessionId: 's1' });
    fire('alia:activity', null);
    fire('alia:activity', { state: 'writing' });
    expect(now()).toBe('thinking');
    fire('alia:activity', { state: 'idle', sessionId: 's1' });
    expect(now()).toBe('idle');
    release();
  });

  it('forgets a run that goes quiet, and every run when the connection drops or closes', () => {
    const release = acquireActivitySocket('https://api.test', () => 't');
    fire('alia:activity', { state: 'working', sessionId: 's1' });
    vi.advanceTimersByTime(ACTIVITY_QUIET_MS + 1);
    expect(now()).toBe('idle');

    fire('alia:activity', { state: 'working', sessionId: 's1' });
    fire('disconnect');
    expect(now()).toBe('idle');

    fire('alia:activity', { state: 'working', sessionId: 's1' });
    release();
    expect(now()).toBe('idle');
  });

  it('keeps local turns when the socket closes', () => {
    const release = acquireActivitySocket('https://api.test', () => 't');
    useAliaActivityStore.getState().setLocal('sheet', 'writing');
    release();
    expect(now()).toBe('writing');
  });

  it('retries a refused handshake itself, because socket.io will not', () => {
    const release = acquireActivitySocket('https://api.test', () => null);
    const socket = sockets()[0];
    socket.active = false;
    fire('connect_error');
    fire('connect_error');
    vi.advanceTimersByTime(5_001);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    release();
  });
});
