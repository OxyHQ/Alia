import express from 'express';
import crypto from 'crypto';
import { generateText } from 'ai';
import { getChannel } from '../lib/channels/registry.js';
import { resolveModel, getAIModel, reportModelUsage } from '../lib/chat-core.js';
import { sendChannelMessage } from '../lib/channels/outbound.js';
import { ChannelUser } from '../models/channel-user.js';
import { Conversation } from '../models/conversation.js';
import type { ChannelId, ChannelInboundMessage } from '../lib/channels/types.js';

const CHANNEL_SYSTEM_PROMPT = `You are Alia, a helpful AI assistant. Be concise and friendly. Respond in the same language the user writes to you.`;

function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function processChannelMessage(
  channelType: ChannelId,
  channelUser: any,
  message: ChannelInboundMessage
): Promise<void> {
  try {
    // Check authentication
    if (!channelUser.isAuthenticated || !channelUser.oxyUserId) {
      // Generate auth token and send auth link
      const authToken = generateAuthToken();
      channelUser.authToken = authToken;
      channelUser.authTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
      await channelUser.save();

      const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
      const authUrl = `${apiBaseUrl}/channels/${channelType}/verify?token=${authToken}`;

      await sendChannelMessage(
        channelType,
        message.chatId,
        `Hi! To use Alia, please link your account first:\n${authUrl}\n\nThis link expires in 15 minutes.`,
        { replyToId: message.replyToId, threadId: message.threadId }
      );
      return;
    }

    // Load or create conversation
    let conversationId = channelUser.conversationId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      channelUser.conversationId = conversationId;
      await channelUser.save();
    }

    // Load conversation history
    let messages: Array<{ role: string; content: string }> = [];
    try {
      const conversation = await Conversation.findOne({
        oxyUserId: channelUser.oxyUserId,
        conversationId,
      });
      if (conversation?.messages?.length) {
        messages = conversation.messages.slice(-20).map((m: any) => ({
          role: m.role,
          content: m.content,
        }));
      }
    } catch (error) {
      console.error(`[Webhook] Failed to load history for ${channelType}:`, error);
    }

    // Add the new user message
    messages.push({ role: 'user', content: message.text });

    // Resolve AI model
    const resolved = await resolveModel(channelUser.preferredModel || 'alia-lite');
    if (!resolved) {
      await sendChannelMessage(channelType, message.chatId, 'Sorry, no AI models are available right now.', {
        replyToId: message.replyToId,
        threadId: message.threadId,
      });
      return;
    }

    const model = getAIModel(resolved.keyConfig);

    // Generate AI response
    const startTime = Date.now();
    const result = await generateText({
      model,
      system: CHANNEL_SYSTEM_PROMPT,
      messages: messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      temperature: 0.7,
      maxOutputTokens: 2048,
    });

    const latencyMs = Date.now() - startTime;
    const fullResponse = result.text;

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

    // Save conversation
    if (fullResponse) {
      messages.push({ role: 'assistant', content: fullResponse });
      await Conversation.findOneAndUpdate(
        { oxyUserId: channelUser.oxyUserId, conversationId },
        {
          $set: {
            messages,
            lastMessage: fullResponse.slice(0, 100),
            updatedAt: new Date(),
          },
          $setOnInsert: {
            oxyUserId: channelUser.oxyUserId,
            conversationId,
            source: channelType,
            title: message.text.slice(0, 50),
            createdAt: new Date(),
          },
        },
        { upsert: true }
      );
    }
  } catch (error) {
    console.error(`[Webhook] Chat processing error for ${channelType}:`, error);
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
    console.log('[Webhook] WhatsApp verification successful');
    res.status(200).send(challenge);
  } else {
    console.warn('[Webhook] WhatsApp verification failed');
    res.sendStatus(403);
  }
});

// Unified webhook handler for all channels
router.post('/:type', async (req, res) => {
  const channelType = req.params.type as ChannelId;

  const channel = getChannel(channelType);
  if (!channel) {
    console.warn(`[Webhook] Unknown channel type: ${channelType}`);
    return res.sendStatus(404);
  }

  if (!channel.webhook) {
    console.warn(`[Webhook] Channel ${channelType} has no webhook adapter`);
    return res.sendStatus(404);
  }

  // Slack URL verification challenge
  if (channelType === 'slack' && req.body?.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }

  // Verify webhook signature
  if (!channel.webhook.verifySignature(req)) {
    console.warn(`[Webhook] Signature verification failed for ${channelType}`);
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

  console.log(`[Webhook] Inbound ${channelType} message:`, {
    from: message.channelUserId,
    chatId: message.chatId,
    text: message.text.slice(0, 100),
    username: message.username,
  });

  try {
    // Find or create channel user
    let channelUser = await ChannelUser.findOne({
      channelType,
      channelUserId: message.channelUserId,
    });

    if (!channelUser) {
      channelUser = new ChannelUser({
        channelType,
        channelUserId: message.channelUserId,
        chatId: message.chatId,
        username: message.username,
        displayName: message.displayName,
        metadata: {},
      });
      await channelUser.save();
      console.log(`[Webhook] Created new ${channelType} user: ${message.channelUserId}`);
    } else {
      let updated = false;
      if (message.chatId && channelUser.chatId !== message.chatId) {
        channelUser.chatId = message.chatId;
        updated = true;
      }
      if (message.username && channelUser.username !== message.username) {
        channelUser.username = message.username;
        updated = true;
      }
      if (message.displayName && channelUser.displayName !== message.displayName) {
        channelUser.displayName = message.displayName;
        updated = true;
      }
      if (updated) await channelUser.save();
    }

    // Respond immediately to webhook (Slack has 3s timeout)
    res.sendStatus(200);

    // Process message asynchronously
    processChannelMessage(channelType, channelUser, message).catch(error => {
      console.error(`[Webhook] Async processing error for ${channelType}:`, error);
    });
  } catch (error) {
    console.error(`[Webhook] Error processing ${channelType} message:`, error);
    res.sendStatus(200);
  }
});

export default router;
