import express from 'express';
import crypto from 'node:crypto';
import { verifySecret } from '@oxy.so/core/server';
import { getChannel } from '../lib/channels/registry.js';
import { getDb } from '../db/index.js';
import {
  findActiveUserBotByWebhookSecret,
  findSystemBot,
  upsertBotUser,
  type BotRow,
} from '../db/integrations/botRepository.js';
import type { ChannelId, ChannelInboundMessage } from '../lib/channels/types.js';
import { log } from '../lib/logger.js';
import { processAgentBotMessage, processChannelMessage } from '../lib/channels/inbound-handlers.js';
import { processAcceptedChannelInbound } from '../lib/channels/inbound-sweep.js';
import {
  acceptChannelInbound,
  settleChannelInbound,
} from '../db/integrations/channelInboundRepository.js';

export { processAgentBotMessage, processChannelMessage };

/**
 * The dedup key of an inbound message: `${channelType}:${scope}:${platformUserId}:${hash(text)}`.
 *
 * Stored in `channel_inbound` (`acceptChannelInbound`), so a platform retry is
 * recognised on ANY instance and across a restart, within the 60-second window.
 */
export function getDeduplicationKey(
  channelType: ChannelId,
  message: ChannelInboundMessage,
  scope?: string,
): string {
  const contentHash = crypto.createHash('md5').update(message.text).digest('hex').slice(0, 12);
  // `scope` isolates per-bot dedup: platformUserId is the same Telegram user id
  // across all bots, so without the receiving bot's id in the key, one person
  // texting two different bots the same thing within 60s would drop the second.
  return `${channelType}:${scope ? `${scope}:` : ''}${message.platformUserId}:${contentHash}`;
}

/**
 * Per-(bot, end-user) inbound rate limit for user-registered agent bots.
 *
 * A user's agent bot is public: anyone on Telegram can message it, and every
 * reply is billed to the bot OWNER. Credits already bound total spend, but this
 * stops a single sender from rapidly burning the owner's balance. Excess is
 * dropped silently (acked, never processed → no credit spend). In-memory /
 * per-instance (an owner's bot across ECS tasks gets N× this); a Redis-backed
 * limiter would make it exact — a fine future upgrade, but credits are the hard
 * cap either way.
 */
const BOT_RL_WINDOW_MS = 60_000;
const BOT_RL_MAX_PER_USER = 15;
const botUserHits = new Map<string, number[]>();

export function isBotUserRateLimited(botId: string, platformUserId: string): boolean {
  const key = `${botId}:${platformUserId}`;
  const now = Date.now();
  const recent = (botUserHits.get(key) ?? []).filter((t) => t > now - BOT_RL_WINDOW_MS);
  if (recent.length >= BOT_RL_MAX_PER_USER) {
    botUserHits.set(key, recent);
    return true;
  }
  recent.push(now);
  botUserHits.set(key, recent);
  return false;
}

// Sweep stale keys so the map can't grow unbounded. unref() so this housekeeping
// timer never keeps the process (or jest) alive.
const botRlSweep = setInterval(() => {
  const cutoff = Date.now() - BOT_RL_WINDOW_MS;
  for (const [key, hits] of botUserHits) {
    const recent = hits.filter((t) => t > cutoff);
    if (recent.length === 0) botUserHits.delete(key);
    else botUserHits.set(key, recent);
  }
}, BOT_RL_WINDOW_MS);
botRlSweep.unref?.();

const router = express.Router();

// WhatsApp GET verification (hub.challenge)
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && verifyToken && verifySecret(token, verifyToken)) {
    log.webhook.info('WhatsApp verification successful');
    res.status(200).send(challenge);
  } else {
    log.webhook.warn('WhatsApp verification failed');
    res.sendStatus(403);
  }
});

// Unified webhook handler for all channels
router.post('/:type', async (req, res) => {
  const channelType = req.params.type as ChannelId;

  const channel = getChannel(channelType);
  if (!channel) {
    log.webhook.warn({ channelType }, 'Unknown channel type');
    return res.sendStatus(404);
  }

  if (!channel.webhook) {
    log.webhook.warn({ channelType }, 'Channel has no webhook adapter');
    return res.sendStatus(404);
  }

  // ── NEW: per-bot inbound routing (user-registered bots) ─────────────────────
  // A user-registered bot echoes ITS OWN webhook secret in this header. When it
  // matches an active user-owned bot, the update belongs to that bot and the secret
  // match IS the signature verification, so we handle it here with the bound agent +
  // owner's tools + the bot's own token, then return. When nothing matches (header
  // absent, or it carries the global bot's secret), we fall straight through to the
  // UNCHANGED global-bot code path below.
  const perBotSecret = req.headers['x-telegram-bot-api-secret-token'] as string | undefined;
  if (perBotSecret) {
    try {
      // The BY-VALUE lookup on `bots.webhook_secret`, which is why that column
      // is plaintext and indexed rather than `encryptedText`: a randomized IV
      // would make this match nothing and every inbound update would answer 200
      // having done nothing.
      const userBot = await findActiveUserBotByWebhookSecret(getDb(), perBotSecret, channelType);

      if (userBot?.userId) {
        const message = channel.webhook.parseMessage(req.body);
        if (!message) {
          return res.sendStatus(200);
        }

        // One statement instead of read-then-branch: two messages from the same
        // person arriving together raced the source's insert.
        const botUser = await upsertBotUser(getDb(), {
          botId: userBot.id,
          platform: channelType,
          platformUserId: message.platformUserId,
          chatId: message.chatId,
          username: message.username,
          displayName: message.displayName,
        });

        // Durable, and BEFORE the ack: the platform never redelivers an acked
        // update, so a process that died after acking would lose the message.
        // Scoped by the receiving bot so the same Telegram user texting two
        // different bots the same thing is not collapsed to one.
        const inboundId = await acceptChannelInbound(getDb(), {
          dedupeKey: getDeduplicationKey(channelType, message, userBot.id),
          kind: 'agent_bot',
          channelType,
          botId: userBot.id,
          botUserId: botUser.id,
          message,
        });
        if (!inboundId) {
          log.webhook.info(
            { channelType, platformUserId: message.platformUserId },
            'Duplicate per-bot message skipped',
          );
          return res.sendStatus(200);
        }

        // Drop (silently, no credit spend) when a single sender floods the bot,
        // so a stranger can't rapidly burn the owner's credits.
        if (isBotUserRateLimited(userBot.id, message.platformUserId)) {
          log.webhook.info(
            { channelType, platformUserId: message.platformUserId },
            'Per-bot message rate-limited',
          );
          await settleChannelInbound(getDb(), inboundId, 'done');
          return res.sendStatus(200);
        }

        // Ack immediately (Telegram retries on non-2xx), then answer asynchronously.
        res.sendStatus(200);
        processAcceptedChannelInbound(inboundId).catch((error: unknown) => {
          log.webhook.error({ err: error, channelType }, 'Async per-bot processing error');
        });
        return;
      }
      // No user-owned bot matched — fall through to the global-bot path unchanged.
    } catch (error: unknown) {
      // A DB error here must not leave the request hanging (Telegram would retry
      // forever). Respond 500 so the platform retries cleanly; never fall through
      // to the global path on an error, since we don't know if this was a user bot.
      log.webhook.error({ err: error, channelType }, 'Per-bot inbound routing error');
      return res.sendStatus(500);
    }
  }

  // Slack URL verification challenge
  if (channelType === 'slack' && req.body?.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Verify webhook signature
  if (!channel.webhook.verifySignature(req)) {
    log.webhook.warn({ channelType }, 'Signature verification failed');
    return res.sendStatus(401);
  }

  // Discord interaction ping
  if (channelType === 'discord' && req.body?.type === 1) {
    return res.json({ type: 1 });
  }

  // Parse the inbound message
  const message = channel.webhook.parseMessage(req.body);
  if (!message) {
    return res.sendStatus(200);
  }

  // The message TEXT is a user prompt and never goes to the log; its length is
  // what an operator actually needs to tell an empty webhook from a real one.
  // `username` is out for the same reason `text` is — the platform user id is
  // the opaque handle every other line in this file correlates on.
  log.webhook.info(
    {
      channelType,
      from: message.platformUserId,
      chatId: message.chatId,
      textLength: message.text.length,
    },
    'Inbound message',
  );

  try {
    // Find the system bot for this channel type. Scoped to `userId: { $exists: false }`
    // so a legitimate global-bot update never binds to a user-registered bot now that
    // both live in the same collection — this selects the exact same (system) document
    // the query returned before per-bot support existed.
    const bot: BotRow | null = await findSystemBot(getDb(), channelType, { activeOnly: true });
    if (!bot) {
      log.webhook.warn({ channelType }, 'No active bot found for channel type');
      return res.sendStatus(200);
    }

    // Find or create bot user, in one statement.
    const botUser = await upsertBotUser(getDb(), {
      botId: bot.id,
      platform: channelType,
      platformUserId: message.platformUserId,
      chatId: message.chatId,
      username: message.username,
      displayName: message.displayName,
    });

    // Durable, and BEFORE the ack (see the per-bot path above).
    const inboundId = await acceptChannelInbound(getDb(), {
      dedupeKey: getDeduplicationKey(channelType, message),
      kind: 'system',
      channelType,
      botId: bot.id,
      botUserId: botUser.id,
      message,
    });
    if (!inboundId) {
      log.webhook.info(
        { channelType, platformUserId: message.platformUserId },
        'Duplicate message skipped',
      );
      return res.sendStatus(200);
    }

    // Respond immediately to webhook (Slack has 3s timeout)
    res.sendStatus(200);

    processAcceptedChannelInbound(inboundId).catch((error: unknown) => {
      log.webhook.error({ err: error, channelType }, 'Async processing error');
    });
  } catch (error: unknown) {
    // Nothing was stored, so let the platform retry rather than lose the message.
    log.webhook.error({ err: error, channelType }, 'Error processing webhook message');
    if (!res.headersSent) res.sendStatus(500);
  }
});

export default router;
