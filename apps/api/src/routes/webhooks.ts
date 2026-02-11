import express from 'express';
import { getChannel } from '../lib/channels/registry.js';
import { ChannelUser } from '../models/channel-user.js';
import type { ChannelId } from '../lib/channels/types.js';

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

    // Chat forwarding will be wired later
    res.sendStatus(200);
  } catch (error) {
    console.error(`[Webhook] Error processing ${channelType} message:`, error);
    res.sendStatus(200);
  }
});

export default router;
