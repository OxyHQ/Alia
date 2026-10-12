/**
 * `TelegramBotAdapter.shutdown` against the real Telegraf, with only its HTTP
 * transport (`telegram.callApi`) stubbed.
 *
 * Telegraf's `stop()` throws 'Bot is not running!' unless polling began. The
 * adapter used to call it unconditionally, so a bot that failed to start threw
 * out of graceful shutdown and the steps after it never ran.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';

vi.hoisted(() => {
  process.env.TELEGRAM_BOT_TOKEN ??= '123456:test-token';
});

import { TelegramBotAdapter } from '../telegram-bot/adapter';

type CallApi = (
  method: string,
  payload: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<unknown>;

const BOT_INFO = { id: 1, is_bot: true, first_name: 'Alia', username: 'alia_test_bot' };

function botOf(adapter: TelegramBotAdapter): Telegraf {
  return (adapter as unknown as { bot: Telegraf }).bot;
}

/** Replace the bot's HTTP transport. `getUpdates` long-polls until aborted. */
function stubTelegramApi(
  adapter: TelegramBotAdapter,
  overrides: Record<string, () => unknown> = {},
) {
  const calls: string[] = [];
  const callApi: CallApi = async (method, _payload, opts) => {
    calls.push(method);
    if (overrides[method]) return overrides[method]();
    if (method === 'getMe') return BOT_INFO;
    if (method === 'getUpdates' && opts?.signal) {
      const signal = opts.signal;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    }
    if (method === 'getUpdates') return [];
    return true;
  };
  vi.spyOn(botOf(adapter).telegram, 'callApi').mockImplementation(
    callApi as unknown as Telegraf['telegram']['callApi'],
  );
  return calls;
}

/** Let the detached `launch()` reach polling, or fail. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TelegramBotAdapter.shutdown', () => {
  it('does nothing for a bot that was never initialised', async () => {
    const adapter = new TelegramBotAdapter();
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  it('does nothing when initialisation failed before launch', async () => {
    const adapter = new TelegramBotAdapter();
    stubTelegramApi(adapter, {
      setMyCommands: () => {
        throw new Error('401: Unauthorized');
      },
    });

    await expect(adapter.initialize()).rejects.toThrow('401: Unauthorized');
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  it('does nothing when launch failed before polling began', async () => {
    const adapter = new TelegramBotAdapter();
    const calls = stubTelegramApi(adapter, {
      getMe: () => {
        throw new Error('401: Unauthorized');
      },
    });

    await adapter.initialize();
    await settle();
    expect(calls).toContain('getMe');
    expect(calls).not.toContain('getUpdates');

    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  it('stops polling when the bot is running', async () => {
    const adapter = new TelegramBotAdapter();
    const calls = stubTelegramApi(adapter);
    const stop = vi.spyOn(botOf(adapter), 'stop');

    await adapter.initialize();
    await vi.waitFor(() => expect(calls).toContain('getUpdates'));

    await expect(adapter.shutdown()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
    // Stopped once: a second shutdown has nothing left to stop.
    await expect(adapter.shutdown()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
