import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth.js';
import { authenticateChannelBot } from '../middleware/channel-auth.js';
import { getChannel, listChannels, getConfiguredChannels } from '../lib/channels/registry.js';
import { ChannelUser } from '../models/channel-user.js';
import type { ChannelId } from '../lib/channels/types.js';
import { log } from '../lib/logger.js';

const router = express.Router();

function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function validateChannelType(req: express.Request, res: express.Response): ChannelId | null {
  const type = req.params.type as ChannelId;
  const channel = getChannel(type);
  if (!channel) {
    res.status(400).json({ error: `Unknown channel type: ${type}` });
    return null;
  }
  return type;
}

function channelAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const type = req.params.type as ChannelId;
  const channel = getChannel(type);
  if (!channel) {
    res.status(400).json({ error: `Unknown channel type: ${type}` });
    return;
  }
  authenticateChannelBot(type)(req, res, next);
}

// List all registered channels
router.get('/', (_req, res) => {
  const channels = listChannels().map(c => c.meta);
  res.json({ channels });
});

// List configured channels only
router.get('/configured', (_req, res) => {
  const channels = getConfiguredChannels().map(c => c.meta);
  res.json({ channels });
});

// Get or create channel user
router.post('/:type/users', channelAuth, async (req, res) => {
  try {
    const channelType = validateChannelType(req, res);
    if (!channelType) return;

    const { channelUserId, chatId, username, displayName, metadata } = req.body;

    if (!channelUserId || !chatId) {
      return res.status(400).json({ error: 'channelUserId and chatId are required' });
    }

    let channelUser = await ChannelUser.findOne({ channelType, channelUserId });

    if (!channelUser) {
      channelUser = new ChannelUser({
        channelType,
        channelUserId,
        chatId,
        username,
        displayName,
        metadata: metadata || {},
      });
      await channelUser.save();
    } else {
      if (chatId) channelUser.chatId = chatId;
      if (username) channelUser.username = username;
      if (displayName) channelUser.displayName = displayName;
      if (metadata) channelUser.metadata = { ...channelUser.metadata, ...metadata };
      await channelUser.save();
    }

    res.json({
      channelType: channelUser.channelType,
      channelUserId: channelUser.channelUserId,
      chatId: channelUser.chatId,
      username: channelUser.username,
      displayName: channelUser.displayName,
      isAuthenticated: channelUser.isAuthenticated,
      conversationId: channelUser.conversationId,
      preferredModel: channelUser.preferredModel,
    });
  } catch (error) {
    log.channels.error({ err: error }, 'Create/update user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get channel user by channel user ID
router.get('/:type/users/:channelUserId', channelAuth, async (req, res) => {
  try {
    const channelType = validateChannelType(req, res);
    if (!channelType) return;

    const { channelUserId } = req.params;
    const channelUser = await ChannelUser.findOne({ channelType, channelUserId });

    if (!channelUser) {
      return res.status(404).json({ error: 'Channel user not found' });
    }

    res.json({
      channelType: channelUser.channelType,
      channelUserId: channelUser.channelUserId,
      chatId: channelUser.chatId,
      username: channelUser.username,
      displayName: channelUser.displayName,
      isAuthenticated: channelUser.isAuthenticated,
      oxyUserId: channelUser.oxyUserId,
      conversationId: channelUser.conversationId,
      linkedAt: channelUser.linkedAt,
      preferredModel: channelUser.preferredModel,
    });
  } catch (error) {
    log.channels.error({ err: error }, 'Get user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create auth request
router.post('/:type/auth-request', channelAuth, async (req, res) => {
  try {
    const channelType = validateChannelType(req, res);
    if (!channelType) return;

    const { channelUserId } = req.body;
    if (!channelUserId) {
      return res.status(400).json({ error: 'channelUserId is required' });
    }

    const channelUser = await ChannelUser.findOne({ channelType, channelUserId });
    if (!channelUser) {
      return res.status(404).json({ error: 'Channel user not found' });
    }

    const authToken = generateAuthToken();
    channelUser.authToken = authToken;
    channelUser.authTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await channelUser.save();

    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
    const authUrl = `${apiBaseUrl}/channels/${channelType}/verify?token=${authToken}`;

    res.json({
      authToken,
      authUrl,
      expiresAt: channelUser.authTokenExpiry,
    });
  } catch (error) {
    log.channels.error({ err: error }, 'Auth request error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify token (redirect to app)
router.get('/:type/verify', async (req, res) => {
  const channelType = req.params.type;
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const channelUser = await ChannelUser.findOne({
      channelType,
      authToken: token,
      authTokenExpiry: { $gt: new Date() },
    });

    if (!channelUser) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }

    const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
    const redirectUrl = `${appUrl}/channel-auth?token=${token}&channel=${channelType}`;
    res.redirect(redirectUrl);
  } catch (error) {
    log.channels.error({ err: error }, 'Verify error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check token validity
router.get('/:type/check-token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const channelType = req.params.type;

    const channelUser = await ChannelUser.findOne({
      channelType,
      authToken: token,
      authTokenExpiry: { $gt: new Date() },
    });

    if (!channelUser) {
      return res.json({ valid: false, error: 'Token not found or expired' });
    }

    res.json({ valid: true, expiresAt: channelUser.authTokenExpiry });
  } catch (error) {
    log.channels.error({ err: error }, 'Check token error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Link channel account with authenticated Oxy user
router.post('/:type/link', authenticateToken, async (req, res) => {
  try {
    const channelType = validateChannelType(req, res);
    if (!channelType) return;

    const { authToken } = req.body;
    if (!authToken) {
      return res.status(400).json({ error: 'Missing auth token' });
    }

    const oxyUserId = req.userId;
    if (!oxyUserId) {
      return res.status(401).json({ error: 'User ID not found' });
    }

    const channelUser = await ChannelUser.findOne({
      channelType,
      authToken,
      authTokenExpiry: { $gt: new Date() },
    });

    if (!channelUser) {
      return res.status(404).json({ error: 'Auth token not found or expired' });
    }

    channelUser.oxyUserId = new mongoose.Types.ObjectId(oxyUserId);
    channelUser.isAuthenticated = true;
    channelUser.linkedAt = new Date();
    channelUser.authToken = undefined;
    channelUser.authTokenExpiry = undefined;
    if (req.accessToken) {
      channelUser.metadata = { ...channelUser.metadata, sessionToken: req.accessToken };
    }
    await channelUser.save();

    res.json({ success: true });
  } catch (error) {
    log.channels.error({ err: error }, 'Link error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get link status for authenticated user
router.get('/:type/link-status', authenticateToken, async (req, res) => {
  try {
    const channelType = validateChannelType(req, res);
    if (!channelType) return;

    const oxyUserId = req.userId;
    if (!oxyUserId) {
      return res.status(401).json({ error: 'User ID not found' });
    }

    const channelUser = await ChannelUser.findOne({
      channelType,
      oxyUserId: new mongoose.Types.ObjectId(oxyUserId),
      isAuthenticated: true,
    });

    if (!channelUser) {
      return res.json({ linked: false });
    }

    res.json({
      linked: true,
      username: channelUser.username,
      displayName: channelUser.displayName,
      linkedAt: channelUser.linkedAt,
    });
  } catch (error) {
    log.channels.error({ err: error }, 'Link status error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unlink channel account
router.post('/:type/unlink', authenticateToken, async (req, res) => {
  try {
    const channelType = validateChannelType(req, res);
    if (!channelType) return;

    const oxyUserId = req.userId;
    if (!oxyUserId) {
      return res.status(401).json({ error: 'User ID not found' });
    }

    const channelUser = await ChannelUser.findOne({
      channelType,
      oxyUserId: new mongoose.Types.ObjectId(oxyUserId),
      isAuthenticated: true,
    });

    if (!channelUser) {
      return res.status(404).json({ error: 'No linked channel account found' });
    }

    channelUser.oxyUserId = undefined as any;
    channelUser.isAuthenticated = false;
    channelUser.conversationId = undefined;
    channelUser.linkedAt = undefined;
    await channelUser.save();

    res.json({ success: true, message: 'Channel account unlinked successfully' });
  } catch (error) {
    log.channels.error({ err: error }, 'Unlink error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update conversation ID
router.post('/:type/users/:channelUserId/conversation', channelAuth, async (req, res) => {
  try {
    const channelType = validateChannelType(req, res);
    if (!channelType) return;

    const { channelUserId } = req.params;
    const { conversationId } = req.body;

    const channelUser = await ChannelUser.findOne({ channelType, channelUserId });
    if (!channelUser) {
      return res.status(404).json({ error: 'Channel user not found' });
    }

    channelUser.conversationId = conversationId;
    await channelUser.save();

    res.json({ success: true, conversationId });
  } catch (error) {
    log.channels.error({ err: error }, 'Update conversation error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update preferred model
router.post('/:type/users/:channelUserId/model', channelAuth, async (req, res) => {
  try {
    const channelType = validateChannelType(req, res);
    if (!channelType) return;

    const { channelUserId } = req.params;
    const { model } = req.body;

    if (!model) {
      return res.status(400).json({ error: 'Model is required' });
    }

    const channelUser = await ChannelUser.findOne({ channelType, channelUserId });
    if (!channelUser) {
      return res.status(404).json({ error: 'Channel user not found' });
    }

    channelUser.preferredModel = model;
    await channelUser.save();

    res.json({ success: true, model });
  } catch (error) {
    log.channels.error({ err: error }, 'Update model error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout channel user
router.post('/:type/users/:channelUserId/logout', channelAuth, async (req, res) => {
  try {
    const channelType = validateChannelType(req, res);
    if (!channelType) return;

    const { channelUserId } = req.params;

    const channelUser = await ChannelUser.findOne({ channelType, channelUserId });
    if (!channelUser) {
      return res.status(404).json({ error: 'Channel user not found' });
    }

    channelUser.isAuthenticated = false;
    channelUser.oxyUserId = undefined as any;
    channelUser.conversationId = undefined;
    await channelUser.save();

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    log.channels.error({ err: error }, 'Logout error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get token info
router.get('/:type/users/token/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const channelType = req.params.type;

    const channelUser = await ChannelUser.findOne({
      channelType,
      authToken: token,
      authTokenExpiry: { $gt: new Date() },
    });

    if (!channelUser) {
      return res.status(404).json({ error: 'Token not found or expired' });
    }

    res.json({
      channelUserId: channelUser.channelUserId,
      oxyUserId: channelUser.oxyUserId,
      isAuthenticated: channelUser.isAuthenticated,
      displayName: channelUser.displayName || channelUser.username || '',
    });
  } catch (error) {
    log.channels.error({ err: error }, 'Token info error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Integrations Proxy (unified gateway for all messaging + browser + terminal)
// ============================================
// All external integrations run in a single service. The API proxies
// authenticated requests through to it with retry + backoff.

const INTEGRATIONS_URL = process.env.INTEGRATIONS_URL;
const INTEGRATIONS_SECRET = process.env.INTEGRATIONS_SECRET;

const requireIntegrations = (_req: express.Request, res: express.Response, next: express.NextFunction): void => {
  if (!INTEGRATIONS_URL || !INTEGRATIONS_SECRET) {
    res.status(503).json({ error: 'Integrations service not configured' });
    return;
  }
  next();
};

async function proxyToIntegrations(
  res: express.Response,
  path: string,
  options?: RequestInit,
  label = 'integrations proxy',
) {
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [1000, 2000, 4000];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${INTEGRATIONS_URL}${path}`, {
        ...options,
        headers: { 'X-Gateway-Secret': INTEGRATIONS_SECRET!, ...options?.headers },
        signal: AbortSignal.timeout(15_000),
      });

      let data: any;
      try {
        data = await response.json();
      } catch {
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
          continue;
        }
        res.status(502).json({ error: `${label}: non-JSON response` });
        return;
      }

      if (response.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }

      res.status(response.status).json(data);
      return;
    } catch (error) {
      log.channels.error({ err: error, label, attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS }, 'Integrations proxy error');
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }
      res.status(502).json({ error: `Failed: ${label}` });
    }
  }
}

const authedIntegrations = [authenticateToken, requireIntegrations] as const;

// --- Helper: generate platform gateway routes ---
// All platforms share the same REST pattern; only the platform prefix
// and connect/disconnect verb differ.

function mountGatewayRoutes(
  platform: string,
  connectEndpoint = 'connect',
  disconnectEndpoint = 'disconnect',
  chatIdParam = 'chatId',
) {
  // Connect / link
  router.post(`/${platform}/session/${connectEndpoint}`, ...authedIntegrations, async (req, res) => {
    await proxyToIntegrations(res, `/${platform}/sessions/${connectEndpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oxyUserId: req.userId }),
    }, `${platform} ${connectEndpoint}`);
  });

  // List user sessions
  router.get(`/${platform}/sessions`, ...authedIntegrations, async (req, res) => {
    await proxyToIntegrations(res, `/${platform}/sessions/user/${req.userId}`, undefined, `${platform} sessions`);
  });

  // Session QR
  router.get(`/${platform}/session/:sessionId/qr`, ...authedIntegrations, async (req, res) => {
    await proxyToIntegrations(res, `/${platform}/sessions/${req.params.sessionId}/qr`, undefined, `${platform} QR`);
  });

  // Session status
  router.get(`/${platform}/session/:sessionId/status`, ...authedIntegrations, async (req, res) => {
    await proxyToIntegrations(res, `/${platform}/sessions/${req.params.sessionId}/status`, undefined, `${platform} status`);
  });

  // Disconnect / unlink
  router.post(`/${platform}/session/:sessionId/${disconnectEndpoint}`, ...authedIntegrations, async (req, res) => {
    await proxyToIntegrations(res, `/${platform}/sessions/${req.params.sessionId}/${disconnectEndpoint}`, {
      method: 'POST',
    }, `${platform} ${disconnectEndpoint}`);
  });

  // Chats
  router.get(`/${platform}/session/:sessionId/chats`, ...authedIntegrations, async (req, res) => {
    await proxyToIntegrations(res, `/${platform}/sessions/${req.params.sessionId}/chats`, undefined, `${platform} chats`);
  });

  // Chat messages
  router.get(`/${platform}/session/:sessionId/chats/:chatId/messages`, ...authedIntegrations, async (req, res) => {
    const { sessionId, chatId } = req.params;
    const limit = (req.query.limit as string) || '20';
    await proxyToIntegrations(
      res,
      `/${platform}/sessions/${sessionId}/chats/${encodeURIComponent(chatId as string)}/messages?limit=${limit}`,
      undefined,
      `${platform} messages`,
    );
  });

  // Send message
  router.post(`/${platform}/session/:sessionId/send`, ...authedIntegrations, async (req, res) => {
    await proxyToIntegrations(res, `/${platform}/sessions/${req.params.sessionId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    }, `${platform} send`);
  });
}

// Mount all gateway platforms
mountGatewayRoutes('whatsapp', 'connect', 'disconnect', 'jid');
mountGatewayRoutes('telegram-gateway', 'connect', 'disconnect', 'chatId');
mountGatewayRoutes('signal-gateway', 'link', 'unlink', 'contactId');

// --- Browser proxy ---
router.post('/browser/session/:sessionId/navigate', ...authedIntegrations, async (req, res) => {
  await proxyToIntegrations(res, `/browser/session/${req.params.sessionId}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  }, 'browser navigate');
});

router.get('/browser/session/:sessionId/screenshot', ...authedIntegrations, async (req, res) => {
  await proxyToIntegrations(res, `/browser/session/${req.params.sessionId}/screenshot`, undefined, 'browser screenshot');
});

// --- Terminal proxy ---
router.post('/terminal/session/:sessionId/run', ...authedIntegrations, async (req, res) => {
  await proxyToIntegrations(res, `/terminal/session/${req.params.sessionId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  }, 'terminal run');
});

export default router;
