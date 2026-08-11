import express from 'express';
import crypto from 'crypto';
import { authenticateToken } from '../middleware/auth.js';
import { authenticateChannelBot } from '../middleware/channel-auth.js';
import { getDb } from '../db/index.js';
import {
  deleteBot,
  findBotById,
  findBotByPlatformIdentity,
  findBotUser,
  findBotUserByAuthToken,
  findLinkedBotUser,
  findOwnedBot,
  findOwnedBotWithToken,
  findSystemBot,
  linkBotUser,
  listVisibleBots,
  logoutBotUser,
  registerBot,
  setBotAgent,
  setBotUserAuthToken,
  setBotUserConversation,
  setBotUserPreferredModel,
  unlinkBotUser,
  upsertBotUser,
  type BotRow,
} from '../db/integrations/botRepository.js';
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

/**
 * Serialize a Bot for API responses, never exposing the token or routing secret.
 *
 * `BotRow` already carries neither — the repository's column list has no
 * credential in it — so this is now a SHAPE choice rather than the only thing
 * between a secret and the wire. `undefined` for an absent owner or agent is
 * kept: it is what the clients have always received, and `null` would serialize
 * differently.
 */
function serializeBot(bot: BotRow): Record<string, unknown> {
  return {
    id: bot.id,
    platform: bot.platform,
    botId: bot.botId,
    name: bot.name,
    username: bot.username,
    avatarUrl: bot.avatarUrl,
    status: bot.status,
    userId: bot.userId ?? undefined,
    agentId: bot.agentId ?? undefined,
  };
}

// ============================================
// Public routes (authenticated users)
// ============================================

// List system bots plus the current user's own registered bots
router.get('/', authenticateToken, async (req, res) => {
  try {
    const bots = await listVisibleBots(getDb(), req.userId!);
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
    const db = getDb();
    let boundAgentId: string | undefined;
    if (agentId) {
      const agent = await Agent.findById(agentId).select('author').lean();
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      if (agent.author.toString() !== req.userId) {
        return res.status(403).json({ error: 'You do not own this agent' });
      }
      boundAgentId = agentId;
    }

    // A Telegram bot token can only ever be bound to one webhook.
    const existing = await findBotByPlatformIdentity(db, 'telegram', numericBotId);
    if (existing) {
      return res.status(409).json({ error: 'This Telegram bot is already registered' });
    }

    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:4150';
    const webhookUrl = `${apiBaseUrl}/webhooks/telegram`;

    // `null` means the platform identity was taken between the check above and
    // here — a concurrent registration of the same bot, decided by
    // `bots_platform_bot_id_key` rather than by a caught error.
    const bot = await registerBot(db, {
      platform: 'telegram',
      botId: numericBotId,
      name: getMe.result.first_name || 'Telegram bot',
      username: getMe.result.username,
      userId: req.userId,
      agentId: boundAgentId,
      botToken: token,
      webhookSecret,
      platformConfigWebhookUrl: webhookUrl,
    });
    if (!bot) {
      return res.status(409).json({ error: 'This Telegram bot is already registered' });
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
        await deleteBot(db, bot.id);
        log.channels.error({ description: swData.description }, 'Telegram setWebhook failed');
        return res.status(502).json({ error: 'Failed to register the Telegram webhook' });
      }
    } catch (error: unknown) {
      await deleteBot(db, bot.id);
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
router.get('/:id', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const bot = await findBotById(getDb(), req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    // User-owned bots are private to their owner; system bots stay public.
    if (bot.userId && bot.userId !== req.userId) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    res.json({ bot });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Get bot error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bind / change / clear the agent on a user-owned bot
router.patch('/:id', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const db = getDb();
    const bot = await findOwnedBot(db, req.params.id, req.userId);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const { agentId } = req.body as { agentId?: string | null };

    // An explicit clear writes NULL. The source assigned `undefined`, which
    // unset the field in Mongo; the same assignment through drizzle is a silent
    // no-op, so the bot would have kept answering with the old agent's prompt
    // while the UI showed it unbound.
    let nextAgentId: string | null;
    if (agentId === null || agentId === '') {
      nextAgentId = null;
    } else if (typeof agentId === 'string') {
      const agent = await Agent.findById(agentId).select('author').lean();
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      if (agent.author.toString() !== req.userId) {
        return res.status(403).json({ error: 'You do not own this agent' });
      }
      nextAgentId = agentId;
    } else {
      return res.status(400).json({ error: 'agentId is required' });
    }

    const updated = await setBotAgent(db, bot.id, req.userId, nextAgentId);
    if (!updated) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    res.json({ bot: serializeBot(updated) });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Update bot error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a user-owned bot (never the system/global bot)
router.delete('/:id', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Scope to the owner: a system bot (no userId) can never match here.
    const db = getDb();
    const bot = await findOwnedBotWithToken(db, req.params.id, req.userId);
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

    // `bot_users` go with the bot: the foreign key is `ON DELETE CASCADE`, which
    // is the structural version of the source's explicit `deleteMany` and cannot
    // be forgotten by a future caller.
    await deleteBot(db, bot.id);

    res.json({ success: true });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Delete bot error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get link status for current user with a specific bot
router.get('/:id/link-status', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const db = getDb();
    const bot = await findBotById(db, req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await findLinkedBotUser(db, bot.id, req.userId!);

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
router.post('/:id/link', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const { authToken } = req.body;
    if (!authToken) {
      return res.status(400).json({ error: 'Missing auth token' });
    }

    const db = getDb();
    const bot = await findBotById(db, req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await findBotUserByAuthToken(db, bot.id, authToken);

    if (!botUser) {
      return res.status(404).json({ error: 'Auth token not found or expired' });
    }

    // `linkBotUser` CLEARS the token to NULL. The source assigned `undefined`,
    // which unset it in Mongo; the same through drizzle is a no-op, and a
    // redeemed one-time token would stay live for its remaining 15 minutes.
    await linkBotUser(db, botUser.id, {
      oxyUserId: req.userId!,
      sessionToken: req.accessToken,
    });

    res.json({ success: true });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Link error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unlink account from bot
router.post('/:id/unlink', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const db = getDb();
    const bot = await findBotById(db, req.params.id);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await findLinkedBotUser(db, bot.id, req.userId!);

    if (!botUser) {
      return res.status(404).json({ error: 'No linked account found' });
    }

    await unlinkBotUser(db, botUser.id);

    res.json({ success: true });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Unlink error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Link by platform + auth token (used by the authorize page)
router.post('/platform/:platform/link', authenticateToken, async (req: express.Request<{ platform: string }>, res) => {
  try {
    const { authToken } = req.body;
    const { platform } = req.params;
    if (!authToken) {
      return res.status(400).json({ error: 'Missing auth token' });
    }

    const db = getDb();
    const bot = await findSystemBot(db, platform);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found for platform' });
    }

    const botUser = await findBotUserByAuthToken(db, bot.id, authToken);

    if (!botUser) {
      return res.status(404).json({ error: 'Auth token not found or expired' });
    }

    await linkBotUser(db, botUser.id, {
      oxyUserId: req.userId!,
      sessionToken: req.accessToken,
    });

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
router.post('/internal/:platform/users', botAuth, async (req: express.Request<{ platform: string }>, res) => {
  try {
    const { platform } = req.params;
    const { platformUserId, chatId, username, displayName, metadata } = req.body;

    if (!platformUserId || !chatId) {
      return res.status(400).json({ error: 'platformUserId and chatId are required' });
    }

    // Find the system bot for this platform
    const db = getDb();
    const bot = await findSystemBot(db, platform);
    if (!bot) {
      return res.status(404).json({ error: `No bot configured for platform: ${platform}` });
    }

    // One statement rather than a read-then-branch: two concurrent inbound
    // messages from the same person raced the source's insert, and the loser
    // now converges on the winner's row instead of failing.
    const botUser = await upsertBotUser(db, {
      botId: bot.id,
      platform,
      platformUserId,
      chatId,
      username,
      displayName,
      metadata,
    });

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
router.get('/internal/:platform/users/:platformUserId', botAuth, async (req: express.Request<{ platform: string; platformUserId: string }>, res) => {
  try {
    const { platform, platformUserId } = req.params;

    const db = getDb();
    const bot = await findSystemBot(db, platform);
    if (!bot) {
      return res.status(404).json({ error: `No bot for platform: ${platform}` });
    }

    const botUser = await findBotUser(db, bot.id, platformUserId);
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
router.post('/internal/:platform/auth-request', botAuth, async (req: express.Request<{ platform: string }>, res) => {
  try {
    const { platform } = req.params;
    const { platformUserId } = req.body;
    if (!platformUserId) {
      return res.status(400).json({ error: 'platformUserId is required' });
    }

    const db = getDb();
    const bot = await findSystemBot(db, platform);
    if (!bot) {
      return res.status(404).json({ error: `No bot for platform: ${platform}` });
    }

    const botUser = await findBotUser(db, bot.id, platformUserId);
    if (!botUser) {
      return res.status(404).json({ error: 'Bot user not found' });
    }

    const authToken = generateAuthToken();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await setBotUserAuthToken(db, botUser.id, authToken, expiresAt);

    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:4150';
    const authUrl = `${apiBaseUrl}/bots/internal/${platform}/verify?token=${authToken}`;

    res.json({
      authToken,
      authUrl,
      expiresAt,
    });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Auth request error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify token (redirect to app)
router.get('/internal/:platform/verify', async (req: express.Request<{ platform: string }>, res) => {
  const { platform } = req.params;
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const db = getDb();
    const bot = await findSystemBot(db, platform);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await findBotUserByAuthToken(db, bot.id, token);

    if (!botUser) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }

    // Deliver the token in the URL fragment, NOT the query string. Fragments are
    // never sent to servers, so the short-lived auth token does not leak into
    // access logs, proxies, or the Referer header on the next navigation. The
    // channel-auth screen reads it from `window.location.hash` client-side.
    const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:4150';
    const fragment = `token=${encodeURIComponent(token)}&channel=${encodeURIComponent(platform)}`;
    res.redirect(`${appUrl}/channel-auth#${fragment}`);
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Verify error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get token info
router.get('/internal/:platform/users/token/:token', async (req: express.Request<{ platform: string; token: string }>, res) => {
  try {
    const { platform, token } = req.params;

    const db = getDb();
    const bot = await findSystemBot(db, platform);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await findBotUserByAuthToken(db, bot.id, token);

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
router.get('/internal/:platform/check-token/:token', async (req: express.Request<{ platform: string; token: string }>, res) => {
  try {
    const { platform, token } = req.params;

    const db = getDb();
    const bot = await findSystemBot(db, platform);
    if (!bot) {
      return res.json({ valid: false, error: 'Bot not found' });
    }

    const botUser = await findBotUserByAuthToken(db, bot.id, token);

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
router.post('/internal/:platform/users/:platformUserId/conversation', botAuth, async (req: express.Request<{ platform: string; platformUserId: string }>, res) => {
  try {
    const { platform, platformUserId } = req.params;
    const { conversationId } = req.body;

    const db = getDb();
    const bot = await findSystemBot(db, platform);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await findBotUser(db, bot.id, platformUserId);
    if (!botUser) {
      return res.status(404).json({ error: 'Bot user not found' });
    }

    await setBotUserConversation(db, botUser.id, conversationId ?? null);

    res.json({ success: true, conversationId });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Update conversation error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update preferred model
router.post('/internal/:platform/users/:platformUserId/model', botAuth, async (req: express.Request<{ platform: string; platformUserId: string }>, res) => {
  try {
    const { platform, platformUserId } = req.params;
    const { model } = req.body;

    if (!model) {
      return res.status(400).json({ error: 'Model is required' });
    }

    const db = getDb();
    const bot = await findSystemBot(db, platform);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await findBotUser(db, bot.id, platformUserId);
    if (!botUser) {
      return res.status(404).json({ error: 'Bot user not found' });
    }

    await setBotUserPreferredModel(db, botUser.id, model);

    res.json({ success: true, model });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Update model error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout bot user
router.post('/internal/:platform/users/:platformUserId/logout', botAuth, async (req: express.Request<{ platform: string; platformUserId: string }>, res) => {
  try {
    const { platform, platformUserId } = req.params;

    const db = getDb();
    const bot = await findSystemBot(db, platform);
    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' });
    }

    const botUser = await findBotUser(db, bot.id, platformUserId);
    if (!botUser) {
      return res.status(404).json({ error: 'Bot user not found' });
    }

    await logoutBotUser(db, botUser.id);

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error: unknown) {
    log.channels.error({ err: error }, 'Logout error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
