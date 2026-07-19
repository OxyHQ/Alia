import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth.js';
import { authenticateChannelBot } from '../middleware/channel-auth.js';
import { Bot, type IBot } from '../models/bot.js';
import { BotUser } from '../models/bot-user.js';
import { Agent } from '../models/agent.js';
import type { ChannelId } from '../lib/channels/types.js';
import { log } from '../lib/logger.js';

const router = express.Router();

/** Telegram bot tokens look like `<numericId>:<alphanumeric>`. */
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;

interface TelegramGetMeResult {
  ok: boolean;
  result?: {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    username?: string;
  };
}

function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Serialize a Bot for API responses, never exposing the token or routing secret. */
function serializeBot(bot: IBot): Record<string, unknown> {
  return {
    id: String(bot._id),
    platform: bot.platform,
    botId: bot.botId,
    name: bot.name,
    username: bot.username,
    avatarUrl: bot.avatarUrl,
    status: bot.status,
    userId: bot.userId ? bot.userId.toString() : undefined,
    agentId: bot.agentId ? bot.agentId.toString() : undefined,
  };
}

// ============================================
// Public routes (authenticated users)
// ============================================

// List system bots plus the current user's own registered bots
router.get('/', authenticateToken, async (req, res) => {
  try {
    const bots = await Bot.find({
      status: { $ne: 'inactive' },
      $or: [
        { userId: { $exists: false } },
        { userId: new mongoose.Types.ObjectId(req.userId) },
      ],
    }).select('-platformConfig');
    res.json({ bots });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'List bots error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register a user-owned Telegram bot bound to an optional agent
router.post('/telegram', authenticateToken, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { botToken, agentId } = req.body as { botToken?: string; agentId?: string };

    if (!botToken || typeof botToken !== 'string' || !TELEGRAM_TOKEN_RE.test(botToken.trim())) {
      return res.status(400).json({ error: 'A valid Telegram bot token is required' });
    }
    const token = botToken.trim();

    // Validate the token against Telegram (getMe).
    let getMe: TelegramGetMeResult;
    try {
      const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      getMe = (await meRes.json()) as TelegramGetMeResult;
      if (!meRes.ok || !getMe.ok || !getMe.result) {
        return res.status(400).json({ error: 'Invalid Telegram bot token' });
      }
    } catch (error: unknown) {
      log.channels.error({ err: error }, 'Telegram getMe failed');
      return res.status(400).json({ error: 'Could not validate the Telegram bot token' });
    }

    const numericBotId = token.split(':')[0];

    // Verify agent ownership when a binding is requested.
    let boundAgentId: mongoose.Types.ObjectId | undefined;
    if (agentId) {
      const agent = await Agent.findById(agentId).select('author').lean();
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      if (agent.author.toString() !== req.userId) {
        return res.status(403).json({ error: 'You do not own this agent' });
      }
      boundAgentId = new mongoose.Types.ObjectId(agentId);
    }

    // A Telegram bot token can only ever be bound to one webhook.
    const existing = await Bot.findOne({ platform: 'telegram', botId: numericBotId });
    if (existing) {
      return res.status(409).json({ error: 'This Telegram bot is already registered' });
    }

    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
    const webhookUrl = `${apiBaseUrl}/webhooks/telegram`;

    const bot = new Bot({
      platform: 'telegram',
      botId: numericBotId,
      name: getMe.result.first_name || 'Telegram bot',
      username: getMe.result.username,
      userId: new mongoose.Types.ObjectId(req.userId),
      agentId: boundAgentId,
      botToken: token,
      webhookSecret,
      status: 'active',
      platformConfig: { webhookUrl },
    });

    try {
      await bot.save();
    } catch (error: unknown) {
      // Duplicate key (another concurrent registration of the same bot).
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: number }).code === 11000) {
        return res.status(409).json({ error: 'This Telegram bot is already registered' });
      }
      throw error;
    }

    // Point Telegram's webhook at us, echoing our per-bot secret on every update.
    try {
      const swRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret }),
      });
      const swData = (await swRes.json()) as { ok?: boolean; description?: string };
      if (!swRes.ok || !swData.ok) {
        await Bot.deleteOne({ _id: bot._id });
        log.channels.error({ description: swData.description }, 'Telegram setWebhook failed');
        return res.status(502).json({ error: 'Failed to register the Telegram webhook' });
      }
    } catch (error: unknown) {
      await Bot.deleteOne({ _id: bot._id });
      log.channels.error({ err: error }, 'Telegram setWebhook request error');
      return res.status(502).json({ error: 'Failed to register the Telegram webhook' });
    }

    res.status(201).json({ bot: serializeBot(bot) });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Register Telegram bot error');
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
    // User-owned bots are private to their owner; system bots stay public.
    if (bot.userId && bot.userId.toString() !== req.userId) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    res.json({ bot });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Get bot error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bind / change / clear the agent on a user-owned bot
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const bot = await Bot.findOne({
      _id: req.params.id,
      userId: new mongoose.Types.ObjectId(req.userId),
    });
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const { agentId } = req.body as { agentId?: string | null };

    if (agentId === null || agentId === '') {
      // Explicit clear of the agent binding.
      bot.agentId = undefined;
    } else if (typeof agentId === 'string') {
      const agent = await Agent.findById(agentId).select('author').lean();
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      if (agent.author.toString() !== req.userId) {
        return res.status(403).json({ error: 'You do not own this agent' });
      }
      bot.agentId = new mongoose.Types.ObjectId(agentId);
    } else {
      return res.status(400).json({ error: 'agentId is required' });
    }

    await bot.save();
    res.json({ bot: serializeBot(bot) });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Update bot error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a user-owned bot (never the system/global bot)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Scope to the owner: a system bot (no userId) can never match here.
    const bot = await Bot.findOne({
      _id: req.params.id,
      userId: new mongoose.Types.ObjectId(req.userId),
    }).select('+botToken');
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    // Best-effort removal of the Telegram webhook using the bot's own token.
    if (bot.platform === 'telegram' && bot.botToken) {
      try {
        await fetch(`https://api.telegram.org/bot${bot.botToken}/deleteWebhook`, { method: 'POST' });
      } catch (error: unknown) {
        log.channels.warn({ err: error }, 'Telegram deleteWebhook failed (continuing)');
      }
    }

    await BotUser.deleteMany({ botId: bot._id });
    await Bot.deleteOne({ _id: bot._id });

    res.json({ success: true });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Delete bot error');
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

    botUser.oxyUserId = undefined;
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

    const bot = await Bot.findOne({ platform, userId: { $exists: false } });
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
    const bot = await Bot.findOne({ platform, userId: { $exists: false } });
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

    const bot = await Bot.findOne({ platform, userId: { $exists: false } });
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

    const bot = await Bot.findOne({ platform, userId: { $exists: false } });
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
    const bot = await Bot.findOne({ platform, userId: { $exists: false } });
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

    const bot = await Bot.findOne({ platform, userId: { $exists: false } });
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

    const bot = await Bot.findOne({ platform, userId: { $exists: false } });
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

    const bot = await Bot.findOne({ platform, userId: { $exists: false } });
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

    const bot = await Bot.findOne({ platform, userId: { $exists: false } });
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

    const bot = await Bot.findOne({ platform, userId: { $exists: false } });
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await BotUser.findOne({ botId: bot._id, platformUserId });
    if (!botUser) {
      return res.status(404).json({ error: 'Bot user not found' });
    }

    botUser.isLinked = false;
    botUser.oxyUserId = undefined;
    botUser.conversationId = undefined;
    await botUser.save();

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Logout error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
