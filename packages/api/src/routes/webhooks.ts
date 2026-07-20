import express from 'express';
import crypto from 'crypto';
import { verifySecret } from '@oxyhq/core/server';
import { generateText, stepCountIs } from 'ai';
import { getChannel } from '../lib/channels/registry.js';
import { resolveModel, getAIModel, reportModelUsage, getDefaultAliaModel } from '../lib/chat-core.js';
import { sendChannelMessage } from '../lib/channels/outbound.js';
import { buildChatTools } from '../services/chat.service.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import type { HydratedDocument } from 'mongoose';
import { BotUser, type IBotUser } from '../models/bot-user.js';
import { Bot, type IBot } from '../models/bot.js';
import { Agent } from '../models/agent.js';
import { Conversation } from '../models/conversation.js';
import { Message } from '../models/message.js';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import { reserveCredits, finalizeCredits, type CreditUsage } from '../lib/credits-manager.js';
import type { ChannelId, ChannelInboundMessage } from '../lib/channels/types.js';
import { log } from '../lib/logger.js';

const DEFAULT_CHANNEL_PROMPT = `You are Alia, an AI assistant by Oxy. Be concise and direct — this is a messaging channel.

CRITICAL: Respond in the same language the user writes to you.

- Skip preambles ("Sure!", "Of course!"). Get to the point.
- Keep responses short. A few sentences is usually enough.
- Be honest about uncertainty.
- When the request is unclear, make a reasonable assumption and state it briefly.`;

/** Map channel types to their dedicated prompt files (when available). */
const CHANNEL_PROMPT_MAP: Partial<Record<ChannelId, string>> = {
  telegram: 'alia-telegram',
};

async function getChannelSystemPrompt(channelType: ChannelId): Promise<string> {
  const promptName = CHANNEL_PROMPT_MAP[channelType];
  if (!promptName) return DEFAULT_CHANNEL_PROMPT;

  const prompt = await loadPrompt(promptName);
  return prompt || DEFAULT_CHANNEL_PROMPT;
}

/**
 * Deduplication map: prevents processing the same webhook message twice.
 * Key format: `${channelType}:${platformUserId}:${messageId || hash(text)}`
 * Entries are automatically removed after 60 seconds.
 */
const processedWebhookMessages = new Set<string>();

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

function isDuplicate(channelType: ChannelId, message: ChannelInboundMessage, scope?: string): boolean {
  const key = getDeduplicationKey(channelType, message, scope);
  if (processedWebhookMessages.has(key)) return true;
  processedWebhookMessages.add(key);
  setTimeout(() => processedWebhookMessages.delete(key), 60000);
  return false;
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

function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function processChannelMessage(
  channelType: ChannelId,
  botUser: any,
  message: ChannelInboundMessage
): Promise<void> {
  try {
    // Check if user has linked their Alia account
    if (!botUser.isLinked || !botUser.oxyUserId) {
      // Generate auth token and send auth link
      const authToken = generateAuthToken();
      botUser.authToken = authToken;
      botUser.authTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
      await botUser.save();

      const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
      const authUrl = `${apiBaseUrl}/bots/internal/${channelType}/verify?token=${authToken}`;

      await sendChannelMessage(
        channelType,
        message.chatId,
        `Hi! To use Alia, please link your account first:\n${authUrl}\n\nThis link expires in 15 minutes.`,
        { replyToId: message.replyToId, threadId: message.threadId }
      );
      return;
    }

    const userId = botUser.oxyUserId.toString();
    const aliasModelId = botUser.preferredModel || 'alia-lite';

    // Reserve credits before processing
    await getOrCreateUserCredits(userId);

    const creditReservation = await reserveCredits(userId);
    if (!creditReservation) {
      const appUrl = process.env.APP_URL || process.env.WEB_URL || 'https://alia.onl';
      await sendChannelMessage(
        channelType,
        message.chatId,
        `You've run out of credits. Add more at ${appUrl} to continue using Alia.`,
        { replyToId: message.replyToId, threadId: message.threadId }
      );
      return;
    }

    // Load or create conversation
    let conversationId = botUser.conversationId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      botUser.conversationId = conversationId;
      await botUser.save();
    }

    // Load conversation history from messages collection
    let messages: Array<{ role: string; content: string }> = [];
    try {
      const recentMessages = await Message.find({
        oxyUserId: botUser.oxyUserId,
        conversationId,
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

      if (recentMessages.length > 0) {
        messages = recentMessages.reverse().map((m: any) => ({
          role: m.role,
          content: m.content,
        }));
      }
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Failed to load conversation history');
    }

    // Add the new user message
    messages.push({ role: 'user', content: message.text });

    // Resolve AI model
    const resolved = await resolveModel(aliasModelId);
    if (!resolved) {
      await sendChannelMessage(channelType, message.chatId, 'Sorry, no AI models are available right now.', {
        replyToId: message.replyToId,
        threadId: message.threadId,
      });
      return;
    }

    const model = getAIModel(resolved.keyConfig);

    // Generate AI response
    const systemPrompt = await getChannelSystemPrompt(channelType);
    const startTime = Date.now();
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      temperature: 0.7,
      maxOutputTokens: 2048,
    });

    const latencyMs = Date.now() - startTime;
    const fullResponse = result.text;

    // Finalize credits based on actual token usage
    const tokenUsage: CreditUsage = {
      promptTokens: result.usage?.inputTokens || 0,
      completionTokens: result.usage?.outputTokens || 0,
      totalTokens: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
    };

    try {
      await finalizeCredits(creditReservation, tokenUsage, aliasModelId);
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Error finalizing credits');
    }

    // Send response back via outbound adapter
    if (fullResponse) {
      await sendChannelMessage(channelType, message.chatId, fullResponse, {
        replyToId: message.replyToId,
        threadId: message.threadId,
      });
    }

    // Report model usage for health tracking
    await reportModelUsage(
      resolved.keyConfig.keyId,
      resolved.provider,
      resolved.modelId,
      true,
      latencyMs
    );

    // Save conversation metadata + append messages
    if (fullResponse) {
      await Conversation.findOneAndUpdate(
        { oxyUserId: botUser.oxyUserId, conversationId },
        {
          $set: {
            lastMessage: fullResponse.slice(0, 100),
            updatedAt: new Date(),
          },
          $setOnInsert: {
            oxyUserId: botUser.oxyUserId,
            conversationId,
            source: channelType,
            title: message.text.slice(0, 50),
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );

      // Append user + assistant messages
      await Message.insertMany([
        { conversationId, oxyUserId: botUser.oxyUserId, role: 'user', content: message.text, createdAt: new Date() },
        { conversationId, oxyUserId: botUser.oxyUserId, role: 'assistant', content: fullResponse, createdAt: new Date() },
      ], { ordered: false });
    }
  } catch (error: unknown) {
    log.webhook.error({ err: error, channelType }, 'Chat processing error');
    try {
      await sendChannelMessage(channelType, message.chatId, 'Sorry, an error occurred. Please try again.', {
        replyToId: message.replyToId,
        threadId: message.threadId,
      });
    } catch { /* ignore send errors */ }
  }
}

/**
 * NEW per-bot inbound path. Runs ONLY when an inbound update matched a user-registered
 * bot by its per-bot webhook secret (the secret match IS the verification). Uses the
 * bound Agent's configuration (system prompt + allowed models) and the bot OWNER's real
 * tool pipeline, bills the owner, and replies with the bot's OWN token. Conversation
 * continuity is tracked per Telegram end-user (the BotUser row), while Conversation and
 * Message docs are owned by the bot owner. The existing global-bot path is untouched.
 */
async function processAgentBotMessage(
  bot: IBot,
  botUser: HydratedDocument<IBotUser>,
  message: ChannelInboundMessage,
  channelType: ChannelId,
): Promise<void> {
  const ownerUserId = bot.userId?.toString();
  const outboundOpts = {
    replyToId: message.replyToId,
    threadId: message.threadId,
    botToken: bot.botToken,
  };

  try {
    // Defensive: user-owned bots always carry an owner.
    if (!ownerUserId) return;

    // Bill the bot owner (not the Telegram end-user).
    await getOrCreateUserCredits(ownerUserId);
    const creditReservation = await reserveCredits(ownerUserId);
    if (!creditReservation) {
      const appUrl = process.env.APP_URL || process.env.WEB_URL || 'https://alia.onl';
      await sendChannelMessage(
        channelType,
        message.chatId,
        `This assistant is temporarily unavailable (its owner is out of credits). More at ${appUrl}.`,
        outboundOpts,
      );
      return;
    }

    // Per-end-user conversation id lives on the BotUser row.
    let conversationId = botUser.conversationId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      botUser.conversationId = conversationId;
      await botUser.save();
    }

    // Load recent history (owned by the bot owner, keyed by conversation id).
    let messages: Array<{ role: string; content: string }> = [];
    try {
      const recentMessages = await Message.find({ oxyUserId: bot.userId, conversationId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
      if (recentMessages.length > 0) {
        messages = recentMessages.reverse().map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : '',
        }));
      }
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Failed to load agent-bot conversation history');
    }

    messages.push({ role: 'user', content: message.text });

    // Resolve the bound agent's configuration (prompt + preferred model).
    const agent = bot.agentId
      ? await Agent.findById(bot.agentId).select('systemPrompt allowedModels').lean()
      : null;

    const aliasModelId = agent?.allowedModels?.[0] || getDefaultAliaModel();
    const resolved = await resolveModel(aliasModelId);
    if (!resolved) {
      await sendChannelMessage(channelType, message.chatId, 'Sorry, no AI models are available right now.', outboundOpts);
      return;
    }
    const model = getAIModel(resolved.keyConfig);

    const systemPrompt = agent?.systemPrompt || (await getChannelSystemPrompt(channelType));

    // Wire the bot owner's REAL tool pipeline (memory, integrations, MCP, triggers, …).
    // buildChatTools is the same assembly the internal chat uses; it runs on behalf of a
    // user without a live JWT, which is exactly this background context.
    const tools = await buildChatTools({ userId: ownerUserId });

    const startTime = Date.now();
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      tools,
      temperature: 0.7,
      maxOutputTokens: 2048,
      stopWhen: stepCountIs(5),
    });

    const latencyMs = Date.now() - startTime;
    const fullResponse = result.text;

    const tokenUsage: CreditUsage = {
      promptTokens: result.usage?.inputTokens || 0,
      completionTokens: result.usage?.outputTokens || 0,
      totalTokens: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
    };
    try {
      await finalizeCredits(creditReservation, tokenUsage, aliasModelId);
    } catch (error: unknown) {
      log.webhook.error({ err: error, channelType }, 'Error finalizing agent-bot credits');
    }

    if (fullResponse) {
      await sendChannelMessage(channelType, message.chatId, fullResponse, outboundOpts);
    }

    await reportModelUsage(resolved.keyConfig.keyId, resolved.provider, resolved.modelId, true, latencyMs);

    if (fullResponse) {
      await Conversation.findOneAndUpdate(
        { oxyUserId: bot.userId, conversationId },
        {
          $set: { lastMessage: fullResponse.slice(0, 100), updatedAt: new Date() },
          $setOnInsert: {
            oxyUserId: bot.userId,
            conversationId,
            source: channelType,
            title: message.text.slice(0, 50),
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );

      await Message.insertMany([
        { conversationId, oxyUserId: bot.userId, role: 'user', content: message.text, createdAt: new Date() },
        { conversationId, oxyUserId: bot.userId, role: 'assistant', content: fullResponse, createdAt: new Date() },
      ], { ordered: false });
    }
  } catch (error: unknown) {
    log.webhook.error({ err: error, channelType }, 'Agent-bot processing error');
    try {
      await sendChannelMessage(channelType, message.chatId, 'Sorry, an error occurred. Please try again.', outboundOpts);
    } catch { /* ignore send errors */ }
  }
}

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
      const userBot = await Bot.findOne({
        webhookSecret: perBotSecret,
        platform: channelType,
        status: 'active',
        userId: { $exists: true },
      }).select('+botToken +webhookSecret');

      if (userBot && userBot.userId) {
        const message = channel.webhook.parseMessage(req.body);
        if (!message) {
          return res.sendStatus(200);
        }

        // Scope dedup by the receiving bot so the same Telegram user texting two
        // different bots the same thing is not collapsed to one.
        if (isDuplicate(channelType, message, userBot._id.toString())) {
          log.webhook.info({ channelType, platformUserId: message.platformUserId }, 'Duplicate per-bot message skipped');
          return res.sendStatus(200);
        }

        // Drop (silently, no credit spend) when a single sender floods the bot,
        // so a stranger can't rapidly burn the owner's credits.
        if (isBotUserRateLimited(userBot._id.toString(), message.platformUserId)) {
          log.webhook.info({ channelType, platformUserId: message.platformUserId }, 'Per-bot message rate-limited');
          return res.sendStatus(200);
        }

        let botUser = await BotUser.findOne({ botId: userBot._id, platformUserId: message.platformUserId });
        if (!botUser) {
          botUser = new BotUser({
            botId: userBot._id,
            platform: channelType,
            platformUserId: message.platformUserId,
            chatId: message.chatId,
            username: message.username,
            displayName: message.displayName,
            metadata: {},
          });
          await botUser.save();
        } else {
          let updated = false;
          if (message.chatId && botUser.chatId !== message.chatId) { botUser.chatId = message.chatId; updated = true; }
          if (message.username && botUser.username !== message.username) { botUser.username = message.username; updated = true; }
          if (message.displayName && botUser.displayName !== message.displayName) { botUser.displayName = message.displayName; updated = true; }
          if (updated) await botUser.save();
        }

        // Ack immediately (Telegram retries on non-2xx), then process asynchronously.
        res.sendStatus(200);
        processAgentBotMessage(userBot, botUser, message, channelType).catch((error: unknown) => {
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

  // Deduplicate: skip if this message was already processed recently
  if (isDuplicate(channelType, message)) {
    log.webhook.info({ channelType, platformUserId: message.platformUserId }, 'Duplicate message skipped');
    return res.sendStatus(200);
  }

  log.webhook.info({
    channelType,
    from: message.platformUserId,
    chatId: message.chatId,
    text: message.text.slice(0, 100),
    username: message.username,
  }, 'Inbound message');

  try {
    // Find the system bot for this channel type. Scoped to `userId: { $exists: false }`
    // so a legitimate global-bot update never binds to a user-registered bot now that
    // both live in the same collection — this selects the exact same (system) document
    // the query returned before per-bot support existed.
    const bot = await Bot.findOne({ platform: channelType, status: 'active', userId: { $exists: false } });
    if (!bot) {
      log.webhook.warn({ channelType }, 'No active bot found for channel type');
      return res.sendStatus(200);
    }

    // Find or create bot user
    let botUser = await BotUser.findOne({
      botId: bot._id,
      platformUserId: message.platformUserId,
    });

    if (!botUser) {
      botUser = new BotUser({
        botId: bot._id,
        platform: channelType,
        platformUserId: message.platformUserId,
        chatId: message.chatId,
        username: message.username,
        displayName: message.displayName,
        metadata: {},
      });
      await botUser.save();
      log.webhook.info({ channelType, platformUserId: message.platformUserId }, 'Created new bot user');
    } else {
      let updated = false;
      if (message.chatId && botUser.chatId !== message.chatId) {
        botUser.chatId = message.chatId;
        updated = true;
      }
      if (message.username && botUser.username !== message.username) {
        botUser.username = message.username;
        updated = true;
      }
      if (message.displayName && botUser.displayName !== message.displayName) {
        botUser.displayName = message.displayName;
        updated = true;
      }
      if (updated) await botUser.save();
    }

    // Respond immediately to webhook (Slack has 3s timeout)
    res.sendStatus(200);

    // Process message asynchronously
    processChannelMessage(channelType, botUser, message).catch((error: unknown) => {
      log.webhook.error({ err: error, channelType }, 'Async processing error');
    });
  } catch (error: unknown) {
    log.webhook.error({ err: error, channelType }, 'Error processing webhook message');
    res.sendStatus(200);
  }
});

export default router;
