import express from 'express';
import crypto from 'crypto';
import { generateText } from 'ai';
import { getChannel } from '../lib/channels/registry.js';
import { resolveModel, getAIModel, reportModelUsage } from '../lib/chat-core.js';
import { sendChannelMessage } from '../lib/channels/outbound.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { BotUser } from '../models/bot-user.js';
import { Bot } from '../models/bot.js';
import { Conversation } from '../models/conversation.js';
import { Message } from '../models/message.js';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import { reserveCredits, finalizeCredits, type CreditReservation, type CreditUsage } from '../lib/credits-manager.js';
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

function getDeduplicationKey(channelType: ChannelId, message: ChannelInboundMessage): string {
  const contentHash = crypto.createHash('md5').update(message.text).digest('hex').slice(0, 12);
  return `${channelType}:${message.platformUserId}:${contentHash}`;
}

function isDuplicate(channelType: ChannelId, message: ChannelInboundMessage): boolean {
  const key = getDeduplicationKey(channelType, message);
  if (processedWebhookMessages.has(key)) return true;
  processedWebhookMessages.add(key);
  setTimeout(() => processedWebhookMessages.delete(key), 60000);
  return false;
}

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
    } catch (error) {
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
    } catch (error) {
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
  } catch (error) {
    log.webhook.error({ err: error, channelType }, 'Chat processing error');
    try {
      await sendChannelMessage(channelType, message.chatId, 'Sorry, an error occurred. Please try again.', {
        replyToId: message.replyToId,
        threadId: message.threadId,
      });
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

  if (mode === 'subscribe' && token === verifyToken) {
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
    // Find the system bot for this channel type
    const bot = await Bot.findOne({ platform: channelType, status: 'active' });
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
    processChannelMessage(channelType, botUser, message).catch(error => {
      log.webhook.error({ err: error, channelType }, 'Async processing error');
    });
  } catch (error) {
    log.webhook.error({ err: error, channelType }, 'Error processing webhook message');
    res.sendStatus(200);
  }
});

export default router;
