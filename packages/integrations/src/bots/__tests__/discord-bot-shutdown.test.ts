/**
 * `DiscordBotAdapter.shutdown` against the real discord.js `Client`, never
 * logged in. Only `destroy()` is replaced where a test needs it to be slow or
 * to fail; one test runs the real one.
 *
 * `Client.destroy()` is async (it closes the gateway shards). The adapter used
 * to call it without awaiting, so a failed close was an unhandled rejection —
 * on Node that ends the process — and graceful shutdown moved on to the
 * Postgres pool while the shards were still closing.
 */

import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordBotAdapter } from '../discord-bot/adapter';

function clientOf(adapter: DiscordBotAdapter): Client {
  return (adapter as unknown as { client: Client }).client;
}

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

/** Let any rejection nobody handled reach `unhandledRejection`. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', recordUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', recordUnhandled);
  vi.restoreAllMocks();
});

describe('DiscordBotAdapter.shutdown', () => {
  it('resolves for a client that never logged in, with the real destroy()', async () => {
    const adapter = new DiscordBotAdapter();

    await expect(adapter.shutdown()).resolves.toBeUndefined();
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('does not resolve until the client has finished closing', async () => {
    const adapter = new DiscordBotAdapter();
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    vi.spyOn(clientOf(adapter), 'destroy').mockReturnValue(closing);

    let done = false;
    const shutdown = adapter.shutdown().then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);

    finishClose();
    await shutdown;
    expect(done).toBe(true);
  });

  it('fails the shutdown step with the close error instead of leaving it unhandled', async () => {
    const adapter = new DiscordBotAdapter();
    vi.spyOn(clientOf(adapter), 'destroy').mockRejectedValue(new Error('shard close failed'));

    await expect(adapter.shutdown()).rejects.toThrow('shard close failed');
    await settle();
    expect(unhandled).toEqual([]);
  });
});
