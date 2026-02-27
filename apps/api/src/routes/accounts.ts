import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth.js';
import { ConnectedAccount } from '../models/connected-account.js';
import { log } from '../lib/logger.js';

const router = express.Router();

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
  label = 'accounts proxy',
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

const authed = [authenticateToken, requireIntegrations] as const;

// Platform -> integrations service path mapping (adapter name may differ from platform)
const PLATFORM_PATHS: Record<string, string> = {
  whatsapp: 'accounts/whatsapp',
  telegram: 'accounts/telegram-gateway',
  signal: 'accounts/signal-gateway',
  gmail: 'accounts/gmail',
};

// OAuth state store for Gmail connect flow
const gmailOAuthStates = new Map<string, { userId: string; accountId: string; expiresAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of gmailOAuthStates) {
    if (value.expiresAt < now) gmailOAuthStates.delete(key);
  }
}, 60_000);

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
];
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// List all connected accounts for the current user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const accounts = await ConnectedAccount.find({
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    }).sort({ createdAt: -1 });
    res.json({ accounts });
  } catch (error) {
    log.channels.error({ err: error }, 'List accounts error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List accounts for a specific platform
router.get('/:platform', authenticateToken, async (req, res) => {
  try {
    const { platform } = req.params;
    const accounts = await ConnectedAccount.find({
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
      platform,
    }).sort({ createdAt: -1 });
    res.json({ accounts });
  } catch (error) {
    log.channels.error({ err: error }, 'List platform accounts error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Gmail OAuth connect — returns OAuth URL for Google authorization
router.post('/gmail/connect', authenticateToken, (req, res) => {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return res.status(503).json({ error: 'Google OAuth not configured' });
  }

  // Create pending account
  const accountId = new mongoose.Types.ObjectId();
  const account = new ConnectedAccount({
    _id: accountId,
    oxyUserId: new mongoose.Types.ObjectId(req.userId),
    platform: 'gmail',
    accountId: 'pending',
    status: 'connecting',
    capabilities: ['read_messages', 'send_messages'],
  });
  account.save().catch((err: any) => log.channels.error({ err }, 'Gmail account save error'));

  const state = crypto.randomBytes(32).toString('hex');
  gmailOAuthStates.set(state, {
    userId: req.userId!,
    accountId: accountId.toString(),
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
  const redirectUri = `${apiBaseUrl}/accounts/gmail/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: GMAIL_SCOPES.join(' '),
    state,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
  });

  res.json({ accountId, authUrl: `${GOOGLE_AUTH_URL}?${params}` });
});

// Gmail OAuth callback — exchanges code for tokens
router.get('/gmail/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  const stateData = gmailOAuthStates.get(state);
  if (!stateData || stateData.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired state' });
  }
  gmailOAuthStates.delete(state);

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(503).json({ error: 'Google OAuth not configured' });
  }

  try {
    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
    const redirectUri = `${apiBaseUrl}/accounts/gmail/callback`;

    // Exchange code for tokens
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const tokenData = (await tokenResponse.json()) as any;

    if (!tokenResponse.ok || !tokenData.access_token) {
      log.channels.error({ tokenData }, 'Gmail OAuth token exchange failed');
      return res.status(400).json({ error: 'Failed to exchange code for tokens' });
    }

    // Fetch user email from Google
    const profileResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(5_000),
    });
    const profile = (await profileResponse.json()) as any;
    const email = profile.email || 'unknown';

    // Update the ConnectedAccount
    const account = await ConnectedAccount.findById(stateData.accountId);
    if (account) {
      account.status = 'connected';
      account.accountId = email;
      account.email = email;
      account.displayName = profile.name || email;
      account.connectedAt = new Date();
      account.oauthTokens = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: tokenData.expires_in
          ? new Date(Date.now() + tokenData.expires_in * 1000)
          : undefined,
        scope: tokenData.scope || GMAIL_SCOPES.join(' '),
      };
      await account.save();

      // Create session in integrations service
      if (INTEGRATIONS_URL && INTEGRATIONS_SECRET) {
        try {
          const sessionResponse = await fetch(
            `${INTEGRATIONS_URL}/accounts/gmail/sessions/connect`,
            {
              method: 'POST',
              headers: {
                'X-Gateway-Secret': INTEGRATIONS_SECRET,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                oxyUserId: stateData.userId,
                accountId: stateData.accountId,
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                expiresAt: account.oauthTokens.expiresAt?.toISOString(),
                email,
              }),
              signal: AbortSignal.timeout(10_000),
            },
          );
          const sessionData = (await sessionResponse.json()) as any;
          if (sessionData.sessionId) {
            account.sessionId = sessionData.sessionId;
            await account.save();
          }
        } catch (err) {
          log.channels.warn({ err }, 'Failed to create Gmail session in integrations');
        }
      }
    }

    // Redirect to frontend
    const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
    res.redirect(`${appUrl}/settings/accounts?connected=gmail`);
  } catch (error) {
    log.channels.error({ err: error }, 'Gmail callback error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initiate connection (returns QR code or OAuth URL)
router.post('/:platform/connect', ...authed, async (req, res) => {
  try {
    const platform = req.params.platform as string;
    const servicePath = PLATFORM_PATHS[platform];
    if (!servicePath) {
      return res.status(400).json({ error: `Unsupported platform: ${platform}` });
    }

    // Create ConnectedAccount record
    const account = new ConnectedAccount({
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
      platform,
      accountId: 'pending',
      status: 'connecting',
      capabilities: ['read_messages', 'send_messages'],
    });
    await account.save();

    // Proxy to integrations service to start session
    const response = await fetch(`${INTEGRATIONS_URL}/${servicePath}/sessions/connect`, {
      method: 'POST',
      headers: {
        'X-Gateway-Secret': INTEGRATIONS_SECRET!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ oxyUserId: req.userId, accountId: account._id.toString() }),
      signal: AbortSignal.timeout(15_000),
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      await account.deleteOne();
      return res.status(502).json({ error: `Integration service unavailable for ${platform}` });
    }

    const data = await response.json();

    if (response.ok && data.sessionId) {
      account.sessionId = data.sessionId;
      await account.save();
    }

    res.status(response.status).json({
      accountId: account._id,
      ...data,
    });
  } catch (error) {
    log.channels.error({ err: error, platform }, 'Connect account error');
    if (account?._id) {
      await ConnectedAccount.deleteOne({ _id: account._id }).catch((err: any) => log.channels.warn({ err, accountId: account._id }, 'Failed to clean up ConnectedAccount after connect error'));
    }
    res.status(502).json({ error: `Failed to connect ${platform}` });
  }
});

// Get account status
router.get('/:id/status', authenticateToken, async (req, res) => {
  try {
    const account = await ConnectedAccount.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // If has sessionId, also fetch live status from integrations
    if (account.sessionId) {
      const servicePath = PLATFORM_PATHS[account.platform];
      if (servicePath) {
        try {
          const response = await fetch(
            `${INTEGRATIONS_URL}/${servicePath}/sessions/${account.sessionId}/status`,
            {
              headers: { 'X-Gateway-Secret': INTEGRATIONS_SECRET! },
              signal: AbortSignal.timeout(5_000),
            },
          );
          if (response.ok) {
            const statusData = await response.json();
            // Sync status from integrations
            if (statusData.status && statusData.status !== account.status) {
              account.status = statusData.status;
              if (statusData.phoneNumber) account.phoneNumber = statusData.phoneNumber;
              if (statusData.displayName) account.displayName = statusData.displayName;
              if (statusData.status === 'connected' && !account.connectedAt) {
                account.connectedAt = new Date();
                account.accountId = statusData.phoneNumber || statusData.accountId || account.accountId;
              }
              await account.save();
            }
            return res.json({ account, liveStatus: statusData });
          }
        } catch {
          // Fall through to return stored status
        }
      }
    }

    res.json({ account });
  } catch (error) {
    log.channels.error({ err: error }, 'Account status error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get QR code for connecting account
router.get('/:id/qr', ...authed, async (req, res) => {
  try {
    const account = await ConnectedAccount.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!account || !account.sessionId) {
      return res.status(404).json({ error: 'Account not found or no active session' });
    }

    const servicePath = PLATFORM_PATHS[account.platform];
    if (!servicePath) {
      return res.status(400).json({ error: 'Platform does not support QR' });
    }

    await proxyToIntegrations(
      res,
      `/${servicePath}/sessions/${account.sessionId}/qr`,
      undefined,
      `${account.platform} QR`,
    );
  } catch (error) {
    log.channels.error({ err: error }, 'QR error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Disconnect account
router.post('/:id/disconnect', ...authed, async (req, res) => {
  try {
    const account = await ConnectedAccount.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Disconnect in integrations service
    if (account.sessionId) {
      const servicePath = PLATFORM_PATHS[account.platform];
      if (servicePath) {
        try {
          await fetch(`${INTEGRATIONS_URL}/${servicePath}/sessions/${account.sessionId}/disconnect`, {
            method: 'POST',
            headers: { 'X-Gateway-Secret': INTEGRATIONS_SECRET! },
            signal: AbortSignal.timeout(10_000),
          });
        } catch {
          // Continue even if integrations service fails
        }
      }
    }

    account.status = 'disconnected';
    await account.save();

    res.json({ success: true });
  } catch (error) {
    log.channels.error({ err: error }, 'Disconnect error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List chats for a connected account
router.get('/:id/chats', ...authed, async (req, res) => {
  try {
    const account = await ConnectedAccount.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!account || !account.sessionId) {
      return res.status(404).json({ error: 'Account not found or not connected' });
    }

    const servicePath = PLATFORM_PATHS[account.platform];
    if (!servicePath) {
      return res.status(400).json({ error: 'Platform does not support chats' });
    }

    await proxyToIntegrations(
      res,
      `/${servicePath}/sessions/${account.sessionId}/chats`,
      undefined,
      `${account.platform} chats`,
    );
  } catch (error) {
    log.channels.error({ err: error }, 'List chats error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get messages from a chat
router.get('/:id/chats/:chatId/messages', ...authed, async (req, res) => {
  try {
    const account = await ConnectedAccount.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!account || !account.sessionId) {
      return res.status(404).json({ error: 'Account not found or not connected' });
    }

    const servicePath = PLATFORM_PATHS[account.platform];
    if (!servicePath) {
      return res.status(400).json({ error: 'Platform does not support messages' });
    }

    const limit = String(req.query.limit || '20');
    await proxyToIntegrations(
      res,
      `/${servicePath}/sessions/${account.sessionId}/chats/${encodeURIComponent(req.params.chatId as string)}/messages?limit=${limit}`,
      undefined,
      `${account.platform} messages`,
    );
  } catch (error) {
    log.channels.error({ err: error }, 'Get messages error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send message via connected account
router.post('/:id/send', ...authed, async (req, res) => {
  try {
    const account = await ConnectedAccount.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!account || !account.sessionId) {
      return res.status(404).json({ error: 'Account not found or not connected' });
    }

    const servicePath = PLATFORM_PATHS[account.platform];
    if (!servicePath) {
      return res.status(400).json({ error: 'Platform does not support sending' });
    }

    await proxyToIntegrations(
      res,
      `/${servicePath}/sessions/${account.sessionId}/send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      },
      `${account.platform} send`,
    );
  } catch (error) {
    log.channels.error({ err: error }, 'Send message error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update account settings (auto-reply, context, tools, etc.)
router.patch('/:id/settings', authenticateToken, async (req, res) => {
  try {
    const account = await ConnectedAccount.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const {
      autoReply,
      autoReplyAgentId,
      customContext,
      allowedTools,
      blockedTools,
      allowedSkillIds,
    } = req.body;

    if (autoReply !== undefined) account.autoReply = autoReply;
    if (autoReplyAgentId !== undefined) {
      account.autoReplyAgentId = autoReplyAgentId
        ? new mongoose.Types.ObjectId(autoReplyAgentId)
        : undefined;
    }
    if (customContext !== undefined) account.customContext = customContext;
    if (allowedTools !== undefined) account.allowedTools = allowedTools;
    if (blockedTools !== undefined) account.blockedTools = blockedTools;
    if (allowedSkillIds !== undefined) {
      account.allowedSkillIds = allowedSkillIds?.map(
        (id: string) => new mongoose.Types.ObjectId(id),
      );
    }

    await account.save();
    res.json({ account });
  } catch (error) {
    log.channels.error({ err: error }, 'Update settings error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete account
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const account = await ConnectedAccount.findOneAndDelete({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Disconnect in integrations service
    if (account.sessionId) {
      const servicePath = PLATFORM_PATHS[account.platform];
      if (servicePath) {
        try {
          await fetch(`${INTEGRATIONS_URL}/${servicePath}/sessions/${account.sessionId}/disconnect`, {
            method: 'POST',
            headers: { 'X-Gateway-Secret': INTEGRATIONS_SECRET! },
            signal: AbortSignal.timeout(10_000),
          });
        } catch {
          // Best effort
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    log.channels.error({ err: error }, 'Delete account error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
