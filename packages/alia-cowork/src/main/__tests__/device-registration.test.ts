import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const world = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  token: 'session-a' as string | null,
  fetch: vi.fn<typeof fetch>(),
  dispose: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));
vi.mock('electron-store', () => ({
  default: class {
    get(key: string) {
      return key === 'deviceId' ? 'test-device' : 'https://api.alia.onl';
    }
  },
}));
vi.mock('../auth', () => ({
  currentAccessToken: () => world.token,
  linkedAliaClient: () => ({ fetch: world.fetch, dispose: world.dispose }),
  onSessionContextChange: (fn: () => void) => {
    world.listeners.add(fn);
    return () => world.listeners.delete(fn);
  },
}));
import { startCoworkDeviceRegistration } from '../device-registration';
beforeEach(() => {
  vi.useFakeTimers();
  world.fetch.mockReset();
  world.dispose.mockReset();
  world.listeners.clear();
  world.token = 'session-a';
});
afterEach(() => {
  vi.useRealTimers();
});
it.runIf(process.platform === 'linux' || process.platform === 'win32')(
  'late registration from another account cannot enable heartbeat on the new account',
  async () => {
    let finish!: (response: Response) => void;
    world.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    world.fetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const stop = startCoworkDeviceRegistration();
    expect(world.fetch).toHaveBeenCalledTimes(1);
    const oldSignal = world.fetch.mock.calls[0][1]?.signal;
    world.token = 'session-b';
    for (const listener of world.listeners) listener();
    expect(oldSignal?.aborted).toBe(true);
    finish(new Response('{}', { status: 200 }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.fetch.mock.calls[1][0]).toBe(
      'https://api.alia.onl/agents/cowork/devices/register',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.fetch.mock.calls[2][0]).toBe(
      'https://api.alia.onl/agents/cowork/devices/test-device/heartbeat',
    );
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.fetch).toHaveBeenCalledTimes(3);
    expect(world.listeners.size).toBe(0);
  },
);
it.runIf(process.platform === 'linux' || process.platform === 'win32')(
  'signed-out clients do not register a device',
  async () => {
    world.token = null;
    const stop = startCoworkDeviceRegistration();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.fetch).not.toHaveBeenCalled();
    stop();
  },
);
