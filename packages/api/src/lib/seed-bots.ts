import { Bot } from '../models/bot.js';
import { getConfiguredChannels } from './channels/registry.js';
import { log } from './logger.js';

/**
 * Ensure a Bot document exists for every configured channel platform.
 * Uses upsert so it's safe to call on every startup.
 */
export async function seedBots(): Promise<void> {
  try {
    const configured = getConfiguredChannels();
    let seeded = 0;

    for (const plugin of configured) {
      const botId = getBotId(plugin.id);

      await Bot.findOneAndUpdate(
        { platform: plugin.id },
        {
          $setOnInsert: {
            botId,
            name: plugin.meta.name,
            status: 'active',
          },
        },
        { upsert: true },
      );
      seeded++;
    }

    log.seed.info({ count: seeded }, 'Seeded bot documents');
  } catch (error) {
    log.seed.error({ err: error }, 'Error seeding bots');
  }
}

/** Extract a stable bot ID from env vars when possible. */
function getBotId(platform: string): string {
  if (platform === 'telegram') {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    const id = token.split(':')[0];
    if (id) return id;
  }
  if (platform === 'discord') {
    return process.env.DISCORD_APP_ID || 'discord-bot';
  }
  return `${platform}-bot`;
}
