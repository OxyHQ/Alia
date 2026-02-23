import mongoose from 'mongoose';
import { Bot } from '../models/bot.js';
import { BotUser } from '../models/bot-user.js';
import { getConfiguredChannels } from './channels/registry.js';
import { log } from './logger.js';

/**
 * Ensure a Bot document exists for every configured channel platform,
 * then migrate any legacy ChannelUser records to BotUser.
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

    // Migrate legacy ChannelUser records (one-time, idempotent)
    await migrateChannelUsers();
  } catch (error) {
    log.seed.error({ err: error }, 'Error seeding bots');
  }
}

/**
 * Migrate documents from the legacy `channelusers` collection to `botusers`.
 * Runs on every startup but skips records that already exist (idempotent).
 */
async function migrateChannelUsers(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;

  const collections = await db.listCollections({ name: 'channelusers' }).toArray();
  if (collections.length === 0) return; // nothing to migrate

  const legacy = db.collection('channelusers');
  const docs = await legacy.find({}).toArray();
  if (docs.length === 0) return;

  let migrated = 0;
  let skipped = 0;

  for (const doc of docs) {
    const platform = doc.channelType;
    if (!platform) { skipped++; continue; }

    // Find the corresponding Bot document
    const bot = await Bot.findOne({ platform });
    if (!bot) { skipped++; continue; }

    // Skip if BotUser already exists for this platform + user combo
    const exists = await BotUser.findOne({
      botId: bot._id,
      platformUserId: doc.channelUserId,
    });
    if (exists) { skipped++; continue; }

    await BotUser.create({
      botId: bot._id,
      platform,
      platformUserId: doc.channelUserId,
      chatId: doc.chatId || doc.channelUserId,
      oxyUserId: doc.oxyUserId,
      isLinked: doc.isAuthenticated ?? false,
      linkedAt: doc.linkedAt,
      username: doc.username,
      displayName: doc.displayName,
      authToken: doc.authToken,
      authTokenExpiry: doc.authTokenExpiry,
      authTokenMode: doc.authTokenMode,
      conversationId: doc.conversationId,
      preferredModel: doc.preferredModel,
      metadata: doc.metadata || {},
    });
    migrated++;
  }

  if (migrated > 0) {
    log.seed.info({ migrated, skipped }, 'Migrated legacy ChannelUser records to BotUser');
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
