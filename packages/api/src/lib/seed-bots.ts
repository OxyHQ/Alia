import { getDb } from '../db/index.js';
import { seedSystemBot } from '../db/integrations/botRepository.js';
import { getConfiguredChannels } from './channels/registry.js';
import { log } from './logger.js';

/**
 * Ensure a Bot document exists for every configured channel platform.
 * Uses upsert so it's safe to call on every startup.
 */
export async function seedBots(): Promise<void> {
  try {
    const db = getDb();
    const configured = getConfiguredChannels();
    let seeded = 0;

    for (const plugin of configured) {
      await seedSystemBot(db, {
        platform: plugin.id,
        botId: getBotId(plugin.id),
        name: plugin.meta.name,
      });
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
