import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger';
import { runShutdownSteps } from '../shutdown';

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('runShutdownSteps', () => {
  it('runs every step after one fails and names the failures', async () => {
    const ran: string[] = [];
    const logger = silentLogger();

    const failed = await runShutdownSteps(
      [
        {
          name: 'telegram-bot',
          run: () => {
            ran.push('telegram-bot');
            throw new Error('Bot is not running!');
          },
        },
        {
          name: 'discord-bot',
          run: async () => {
            ran.push('discord-bot');
          },
        },
        {
          name: 'whatsapp',
          run: async () => {
            ran.push('whatsapp');
            throw new Error('socket already closed');
          },
        },
        {
          name: 'Postgres pool',
          run: async () => {
            ran.push('Postgres pool');
          },
        },
      ],
      logger,
    );

    expect(ran).toEqual(['telegram-bot', 'discord-bot', 'whatsapp', 'Postgres pool']);
    expect(failed).toEqual(['telegram-bot', 'whatsapp']);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('runs the steps in order, one at a time', async () => {
    const events: string[] = [];
    const step = (name: string) => ({
      name,
      run: async () => {
        events.push(`${name}:start`);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        events.push(`${name}:end`);
      },
    });

    const failed = await runShutdownSteps([step('a'), step('b')], silentLogger());

    expect(failed).toEqual([]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });
});
