import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth.js';
import { authenticateChannelBot } from '../middleware/channel-auth.js';
import { Bot } from '../models/bot.js';
import { BotUser } from '../models/bot-user.js';
import type { ChannelId } from '../lib/channels/types.js';
import { log } from '../lib/logger.js';

const router = express.Router();

function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================
// Public routes (authenticated users)
// ============================================

// List all system bots
router.get('/', authenticateToken, async (_req, res) => {
  try {
    const bots = await Bot.find({ status: { $ne: 'inactive' } }).select('-platformConfig');
    res.json({ bots });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'List bots error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get bot details
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id).select('-platformConfig');
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    res.json({ bot });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Get bot error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get link status for current user with a specific bot
router.get('/:id/link-status', authenticateToken, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await BotUser.findOne({
      botId: bot._id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
      isLinked: true,
    });

    if (!botUser) {
      return res.json({ linked: false });
    }

    res.json({
      linked: true,
      username: botUser.username,
      displayName: botUser.displayName,
      linkedAt: botUser.linkedAt,
    });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Link status error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Link account to bot (with auth token)
router.post('/:id/link', authenticateToken, async (req, res) => {
  try {
    const { authToken } = req.body;
    if (!authToken) {
      return res.status(400).json({ error: 'Missing auth token' });
    }

    const bot = await Bot.findById(req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await BotUser.findOne({
      botId: bot._id,
      authToken,
      authTokenExpiry: { $gt: new Date() },
    });

    if (!botUser) {
      return res.status(404).json({ error: 'Auth token not found or expired' });
    }

    botUser.oxyUserId = new mongoose.Types.ObjectId(req.userId);
    botUser.isLinked = true;
    botUser.linkedAt = new Date();
    botUser.authToken = undefined;
    botUser.authTokenExpiry = undefined;
    if (req.accessToken) {
      botUser.metadata = { ...botUser.metadata, sessionToken: req.accessToken };
    }
    await botUser.save();

    res.json({ success: true });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Link error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unlink account from bot
router.post('/:id/unlink', authenticateToken, async (req, res) => {
  try {
    const bot = await Bot.findById(req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await BotUser.findOne({
      botId: bot._id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
      isLinked: true,
    });

    if (!botUser) {
      return res.status(404).json({ error: 'No linked account found' });
    }

    botUser.oxyUserId = undefined as any;
    botUser.isLinked = false;
    botUser.conversationId = undefined;
    botUser.linkedAt = undefined;
    await botUser.save();

    res.json({ success: true });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Unlink error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Link by platform + auth token (used by the authorize page)
router.post('/platform/:platform/link', authenticateToken, async (req, res) => {
  try {
    const { authToken } = req.body;
    const { platform } = req.params;
    if (!authToken) {
      return res.status(400).json({ error: 'Missing auth token' });
    }

    const bot = await Bot.findOne({ platform });
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found for platform' });
    }

    const botUser = await BotUser.findOne({
      botId: bot._id,
      authToken,
      authTokenExpiry: { $gt: new Date() },
    });

    if (!botUser) {
      return res.status(404).json({ error: 'Auth token not found or expired' });
    }

    botUser.oxyUserId = new mongoose.Types.ObjectId(req.userId);
    botUser.isLinked = true;
    botUser.linkedAt = new Date();
    botUser.authToken = undefined;
    botUser.authTokenExpiry = undefined;
    if (req.accessToken) {
      botUser.metadata = { ...botUser.metadata, sessionToken: req.accessToken };
    }
    await botUser.save();

    res.json({ success: true });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Platform link error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Internal routes (authenticated by bot secret)
// ============================================

function botAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const platform = req.params.platform as ChannelId;
  authenticateChannelBot(platform)(req, res, next);
}

// Create or update bot user
router.post('/internal/:platform/users', botAuth, async (req, res) => {
  try {
    const { platform } = req.params;
    const { platformUserId, chatId, username, displayName, metadata } = req.body;

    if (!platformUserId || !chatId) {
      return res.status(400).json({ error: 'platformUserId and chatId are required' });
    }

    // Find the system bot for this platform
    const bot = await Bot.findOne({ platform });
    if (!bot) {
      return res.status(404).json({ error: `No bot configured for platform: ${platform}` });
    }

    let botUser = await BotUser.findOne({ botId: bot._id, platformUserId });

    if (!botUser) {
      botUser = new BotUser({
        botId: bot._id,
        platform,
        platformUserId,
        chatId,
        username,
        displayName,
        metadata: metadata || {},
      });
      await botUser.save();
    } else {
      if (chatId) botUser.chatId = chatId;
      if (username) botUser.username = username;
      if (displayName) botUser.displayName = displayName;
      if (metadata) botUser.metadata = { ...botUser.metadata, ...metadata };
      await botUser.save();
    }

    res.json({
      platform: botUser.platform,
      platformUserId: botUser.platformUserId,
      chatId: botUser.chatId,
      username: botUser.username,
      displayName: botUser.displayName,
      isLinked: botUser.isLinked,
      conversationId: botUser.conversationId,
      preferredModel: botUser.preferredModel,
      oxyUserId: botUser.oxyUserId,
    });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Create/update bot user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get bot user by platform user ID
router.get('/internal/:platform/users/:platformUserId', botAuth, async (req, res) => {
  try {
    const { platform, platformUserId } = req.params;

    const bot = await Bot.findOne({ platform });
    if (!bot) {
      return res.status(404).json({ error: `No bot for platform: ${platform}` });
    }

    const botUser = await BotUser.findOne({ botId: bot._id, platformUserId });
    if (!botUser) {
      return res.status(404).json({ error: 'Bot user not found' });
    }

    res.json({
      platform: botUser.platform,
      platformUserId: botUser.platformUserId,
      chatId: botUser.chatId,
      username: botUser.username,
      displayName: botUser.displayName,
      isLinked: botUser.isLinked,
      oxyUserId: botUser.oxyUserId,
      conversationId: botUser.conversationId,
      linkedAt: botUser.linkedAt,
      preferredModel: botUser.preferredModel,
    });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Get bot user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create auth request for bot user
router.post('/internal/:platform/auth-request', botAuth, async (req, res) => {
  try {
    const { platform } = req.params;
    const { platformUserId } = req.body;
    if (!platformUserId) {
      return res.status(400).json({ error: 'platformUserId is required' });
    }

    const bot = await Bot.findOne({ platform });
    if (!bot) {
      return res.status(404).json({ error: `No bot for platform: ${platform}` });
    }

    const botUser = await BotUser.findOne({ botId: bot._id, platformUserId });
    if (!botUser) {
      return res.status(404).json({ error: 'Bot user not found' });
    }

    const authToken = generateAuthToken();
    botUser.authToken = authToken;
    botUser.authTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await botUser.save();

    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
    const authUrl = `${apiBaseUrl}/bots/internal/${platform}/verify?token=${authToken}`;

    res.json({
      authToken,
      authUrl,
      expiresAt: botUser.authTokenExpiry,
    });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Auth request error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify token (redirect to app)
router.get('/internal/:platform/verify', async (req, res) => {
  const { platform } = req.params;
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const bot = await Bot.findOne({ platform });
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await BotUser.findOne({
      botId: bot._id,
      authToken: token,
      authTokenExpiry: { $gt: new Date() },
    });

    if (!botUser) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }

    // Deliver the token in the URL fragment, NOT the query string. Fragments are
    // never sent to servers, so the short-lived auth token does not leak into
    // access logs, proxies, or the Referer header on the next navigation. The
    // channel-auth screen reads it from `window.location.hash` client-side.
    const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
    const fragment = `token=${encodeURIComponent(token)}&channel=${encodeURIComponent(platform)}`;
    res.redirect(`${appUrl}/channel-auth#${fragment}`);
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Verify error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get token info
router.get('/internal/:platform/users/token/:token', async (req, res) => {
  try {
    const { platform, token } = req.params;

    const bot = await Bot.findOne({ platform });
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await BotUser.findOne({
      botId: bot._id,
      authToken: token,
      authTokenExpiry: { $gt: new Date() },
    });

    if (!botUser) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }

    res.json({
      platformUserId: botUser.platformUserId,
      oxyUserId: botUser.oxyUserId,
      isLinked: botUser.isLinked,
      displayName: botUser.displayName || botUser.username || '',
    });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Token info error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check token validity
router.get('/internal/:platform/check-token/:token', async (req, res) => {
  try {
    const { platform, token } = req.params;

    const bot = await Bot.findOne({ platform });
    if (!bot) {
      return res.json({ valid: false, error: 'Bot not found' });
    }

    const botUser = await BotUser.findOne({
      botId: bot._id,
      authToken: token,
      authTokenExpiry: { $gt: new Date() },
    });

    if (!botUser) {
      return res.json({ valid: false, error: 'Token not found or expired' });
    }

    res.json({ valid: true, expiresAt: botUser.authTokenExpiry });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Check token error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update conversation ID
router.post('/internal/:platform/users/:platformUserId/conversation', botAuth, async (req, res) => {
  try {
    const { platform, platformUserId } = req.params;
    const { conversationId } = req.body;

    const bot = await Bot.findOne({ platform });
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await BotUser.findOne({ botId: bot._id, platformUserId });
    if (!botUser) {
      return res.status(404).json({ error: 'Bot user not found' });
    }

    botUser.conversationId = conversationId;
    await botUser.save();

    res.json({ success: true, conversationId });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Update conversation error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update preferred model
router.post('/internal/:platform/users/:platformUserId/model', botAuth, async (req, res) => {
  try {
    const { platform, platformUserId } = req.params;
    const { model } = req.body;

    if (!model) {
      return res.status(400).json({ error: 'Model is required' });
    }

    const bot = await Bot.findOne({ platform });
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await BotUser.findOne({ botId: bot._id, platformUserId });
    if (!botUser) {
      return res.status(404).json({ error: 'Bot user not found' });
    }

    botUser.preferredModel = model;
    await botUser.save();

    res.json({ success: true, model });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Update model error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout bot user
router.post('/internal/:platform/users/:platformUserId/logout', botAuth, async (req, res) => {
  try {
    const { platform, platformUserId } = req.params;

    const bot = await Bot.findOne({ platform });
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await BotUser.findOne({ botId: bot._id, platformUserId });
    if (!botUser) {
      return res.status(404).json({ error: 'Bot user not found' });
    }

    botUser.isLinked = false;
    botUser.oxyUserId = undefined as any;
    botUser.conversationId = undefined;
    await botUser.save();

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Logout error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
