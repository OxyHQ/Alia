import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth.js';
import { authenticateChannelBot } from '../middleware/channel-auth.js';
import { getChannel, listChannels, getConfiguredChannels } from '../lib/channels/registry.js';
import { ChannelUser } from '../models/channel-user.js';
import type { ChannelId } from '../lib/channels/types.js';

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
    console.error(`[Channels] Create/update user error:`, error);
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
    console.error(`[Channels] Get user error:`, error);
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
    console.error(`[Channels] Auth request error:`, error);
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
    console.error(`[Channels] Verify error:`, error);
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
    console.error(`[Channels] Check token error:`, error);
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
    console.error(`[Channels] Link error:`, error);
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
    console.error(`[Channels] Link status error:`, error);
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
    console.error(`[Channels] Unlink error:`, error);
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
    console.error(`[Channels] Update conversation error:`, error);
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
    console.error(`[Channels] Update model error:`, error);
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
    console.error(`[Channels] Logout error:`, error);
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
    console.error(`[Channels] Token info error:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Gateway Proxy (WhatsApp, Telegram, Signal)
// ============================================
// These endpoints require JWT auth and proxy requests to standalone gateway services.
// Each gateway manages per-session connections; users scan QR codes to link accounts.

function createGatewayProxy(gatewayUrl: string | undefined, gatewaySecret: string | undefined, name: string) {
  const requireGateway = (_req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!gatewayUrl || !gatewaySecret) {
      res.status(503).json({ error: `${name} gateway not configured` });
      return;
    }
    next();
  };

  const proxy = async (
    res: express.Response,
    path: string,
    options?: RequestInit,
    label = `${name} proxy`,
  ) => {
    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [1000, 2000, 4000];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${gatewayUrl}${path}`, {
          ...options,
          headers: { 'X-Gateway-Secret': gatewaySecret!, ...options?.headers },
        });

        let data: any;
        try {
          data = await response.json();
        } catch {
          if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
            continue;
          }
          res.status(502).json({ error: `${label}: gateway returned non-JSON response` });
          return;
        }

        if (response.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
          continue;
        }

        res.status(response.status).json(data);
        return;
      } catch (error) {
        console.error(`[Channels] ${label} attempt ${attempt + 1}/${MAX_ATTEMPTS} error:`, error);
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
          continue;
        }
        res.status(502).json({ error: `Failed: ${label}` });
      }
    }
  };

  return { requireGateway, proxy };
}

// --- WhatsApp Gateway ---
const wa = createGatewayProxy(process.env.WHATSAPP_GATEWAY_URL, process.env.WHATSAPP_GATEWAY_SECRET, 'WhatsApp');
const waSession = [authenticateToken, wa.requireGateway] as const;

router.post('/whatsapp/session/connect', ...waSession, async (req, res) => {
  await wa.proxy(res, '/sessions/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oxyUserId: req.userId }),
  }, 'WhatsApp connect');
});

router.get('/whatsapp/sessions', ...waSession, async (req, res) => {
  await wa.proxy(res, `/sessions/user/${req.userId}`, undefined, 'WhatsApp sessions');
});

router.get('/whatsapp/session/:sessionId/qr', ...waSession, async (req, res) => {
  await wa.proxy(res, `/sessions/${req.params.sessionId}/qr`, undefined, 'WhatsApp QR');
});

router.get('/whatsapp/session/:sessionId/status', ...waSession, async (req, res) => {
  await wa.proxy(res, `/sessions/${req.params.sessionId}/status`, undefined, 'WhatsApp status');
});

router.post('/whatsapp/session/:sessionId/disconnect', ...waSession, async (req, res) => {
  await wa.proxy(res, `/sessions/${req.params.sessionId}/disconnect`, {
    method: 'POST',
  }, 'WhatsApp disconnect');
});

router.get('/whatsapp/session/:sessionId/chats', ...waSession, async (req, res) => {
  await wa.proxy(res, `/sessions/${req.params.sessionId}/chats`, undefined, 'WhatsApp chats');
});

router.get('/whatsapp/session/:sessionId/chats/:jid/messages', ...waSession, async (req, res) => {
  const { sessionId, jid } = req.params;
  const limit = (req.query.limit as string) || '20';
  await wa.proxy(
    res,
    `/sessions/${sessionId}/chats/${encodeURIComponent(jid)}/messages?limit=${limit}`,
    undefined,
    'WhatsApp messages',
  );
});

router.post('/whatsapp/session/:sessionId/send', ...waSession, async (req, res) => {
  await wa.proxy(res, `/sessions/${req.params.sessionId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  }, 'WhatsApp send');
});

// --- Telegram Gateway ---
const tg = createGatewayProxy(process.env.TELEGRAM_GATEWAY_URL, process.env.TELEGRAM_GATEWAY_SECRET, 'Telegram');
const tgSession = [authenticateToken, tg.requireGateway] as const;

router.post('/telegram-gateway/session/connect', ...tgSession, async (req, res) => {
  await tg.proxy(res, '/sessions/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oxyUserId: req.userId }),
  }, 'Telegram connect');
});

router.get('/telegram-gateway/sessions', ...tgSession, async (req, res) => {
  await tg.proxy(res, `/sessions/user/${req.userId}`, undefined, 'Telegram sessions');
});

router.get('/telegram-gateway/session/:sessionId/qr', ...tgSession, async (req, res) => {
  await tg.proxy(res, `/sessions/${req.params.sessionId}/qr`, undefined, 'Telegram QR');
});

router.get('/telegram-gateway/session/:sessionId/status', ...tgSession, async (req, res) => {
  await tg.proxy(res, `/sessions/${req.params.sessionId}/status`, undefined, 'Telegram status');
});

router.post('/telegram-gateway/session/:sessionId/disconnect', ...tgSession, async (req, res) => {
  await tg.proxy(res, `/sessions/${req.params.sessionId}/disconnect`, {
    method: 'POST',
  }, 'Telegram disconnect');
});

router.get('/telegram-gateway/session/:sessionId/chats', ...tgSession, async (req, res) => {
  await tg.proxy(res, `/sessions/${req.params.sessionId}/chats`, undefined, 'Telegram chats');
});

router.get('/telegram-gateway/session/:sessionId/chats/:chatId/messages', ...tgSession, async (req, res) => {
  const { sessionId, chatId } = req.params;
  const limit = (req.query.limit as string) || '20';
  await tg.proxy(
    res,
    `/sessions/${sessionId}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`,
    undefined,
    'Telegram messages',
  );
});

router.post('/telegram-gateway/session/:sessionId/send', ...tgSession, async (req, res) => {
  await tg.proxy(res, `/sessions/${req.params.sessionId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  }, 'Telegram send');
});

// --- Signal Gateway ---
const sg = createGatewayProxy(process.env.SIGNAL_GATEWAY_URL, process.env.SIGNAL_GATEWAY_SECRET, 'Signal');
const sgSession = [authenticateToken, sg.requireGateway] as const;

router.post('/signal-gateway/session/link', ...sgSession, async (req, res) => {
  await sg.proxy(res, '/sessions/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oxyUserId: req.userId }),
  }, 'Signal link');
});

router.get('/signal-gateway/sessions', ...sgSession, async (req, res) => {
  await sg.proxy(res, `/sessions/user/${req.userId}`, undefined, 'Signal sessions');
});

router.get('/signal-gateway/session/:sessionId/qr', ...sgSession, async (req, res) => {
  await sg.proxy(res, `/sessions/${req.params.sessionId}/qr`, undefined, 'Signal QR');
});

router.get('/signal-gateway/session/:sessionId/status', ...sgSession, async (req, res) => {
  await sg.proxy(res, `/sessions/${req.params.sessionId}/status`, undefined, 'Signal status');
});

router.post('/signal-gateway/session/:sessionId/unlink', ...sgSession, async (req, res) => {
  await sg.proxy(res, `/sessions/${req.params.sessionId}/unlink`, {
    method: 'POST',
  }, 'Signal unlink');
});

router.get('/signal-gateway/session/:sessionId/chats', ...sgSession, async (req, res) => {
  await sg.proxy(res, `/sessions/${req.params.sessionId}/chats`, undefined, 'Signal chats');
});

router.get('/signal-gateway/session/:sessionId/chats/:contactId/messages', ...sgSession, async (req, res) => {
  const { sessionId, contactId } = req.params;
  const limit = (req.query.limit as string) || '20';
  await sg.proxy(
    res,
    `/sessions/${sessionId}/chats/${encodeURIComponent(contactId)}/messages?limit=${limit}`,
    undefined,
    'Signal messages',
  );
});

router.post('/signal-gateway/session/:sessionId/send', ...sgSession, async (req, res) => {
  await sg.proxy(res, `/sessions/${req.params.sessionId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  }, 'Signal send');
});

export default router;
