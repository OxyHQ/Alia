import express from 'express';
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
    log.channels.error({ err: error }, 'Connect account error');
    res.status(500).json({ error: 'Internal server error' });
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
