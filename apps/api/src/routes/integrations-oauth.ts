import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth.js';
import { Integration } from '../models/integration.js';
import { INTEGRATION_REGISTRY, type IntegrationRegistryEntry } from '../lib/integration-registry.js';
import { log } from '../lib/logger.js';

const router = express.Router();

// In-memory state store for OAuth flows (short-lived)
const oauthStates = new Map<string, { service: string; userId: string; expiresAt: number }>();

// Clean expired states periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of oauthStates) {
    if (value.expiresAt < now) oauthStates.delete(key);
  }
}, 60_000);

function getRegistryEntry(service: string): IntegrationRegistryEntry | undefined {
  return INTEGRATION_REGISTRY.find(i => i.service === service);
}

function getOAuthCredentials(entry: IntegrationRegistryEntry): { clientId: string; clientSecret: string } | null {
  const clientId = process.env[entry.oauthConfig.envClientId];
  const clientSecret = process.env[entry.oauthConfig.envClientSecret];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// List available integrations
router.get('/available', authenticateToken, (_req, res) => {
  const available = INTEGRATION_REGISTRY.map(entry => {
    const creds = getOAuthCredentials(entry);
    return {
      service: entry.service,
      name: entry.name,
      icon: entry.icon,
      description: entry.description,
      configured: !!creds,
    };
  });
  res.json({ integrations: available });
});

// List user's connected integrations
router.get('/', authenticateToken, async (req, res) => {
  try {
    const integrations = await Integration.find({
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    })
      .select('-oauthTokens')
      .sort({ createdAt: -1 });
    res.json({ integrations });
  } catch (error) {
    log.general.error({ err: error }, 'List integrations error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate OAuth URL for a service
router.get('/:service/oauth-url', authenticateToken, (req, res) => {
  const { service } = req.params;
  const entry = getRegistryEntry(service);
  if (!entry) {
    return res.status(404).json({ error: `Unknown service: ${service}` });
  }

  const creds = getOAuthCredentials(entry);
  if (!creds) {
    return res.status(503).json({ error: `${entry.name} integration is not configured` });
  }

  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, {
    service,
    userId: req.userId!,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
  });

  const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
  const redirectUri = `${apiBaseUrl}/integrations/${service}/callback`;

  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    scope: entry.oauthConfig.scopes.join(' '),
    state,
    response_type: 'code',
    access_type: 'offline',
  });

  const authUrl = `${entry.oauthConfig.authUrl}?${params.toString()}`;
  res.json({ authUrl });
});

// OAuth callback
router.get('/:service/callback', async (req, res) => {
  const { service } = req.params;
  const { code, state } = req.query;

  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  const stateData = oauthStates.get(state);
  if (!stateData || stateData.service !== service || stateData.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Invalid or expired state' });
  }
  oauthStates.delete(state);

  const entry = getRegistryEntry(service);
  if (!entry) {
    return res.status(404).json({ error: 'Unknown service' });
  }

  const creds = getOAuthCredentials(entry);
  if (!creds) {
    return res.status(503).json({ error: 'Service not configured' });
  }

  try {
    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
    const redirectUri = `${apiBaseUrl}/integrations/${service}/callback`;

    // Build token exchange request (provider-specific auth method)
    const authMethod = entry.oauthConfig.authMethod || 'body';
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    const bodyParams: Record<string, string> = {
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    };

    if (authMethod === 'basic') {
      headers['Authorization'] = `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`;
    } else {
      bodyParams.client_id = creds.clientId;
      bodyParams.client_secret = creds.clientSecret;
    }

    const tokenResponse = await fetch(entry.oauthConfig.tokenUrl, {
      method: 'POST',
      headers,
      body: new URLSearchParams(bodyParams),
      signal: AbortSignal.timeout(10_000),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      log.general.error({ tokenData }, 'OAuth token exchange failed');
      return res.status(400).json({ error: 'Failed to exchange code for tokens' });
    }

    // Fetch user profile from the connected service (best-effort)
    let profileData: { accountId?: string; accountName?: string; avatarUrl?: string } = {};
    if (entry.profile) {
      try {
        const profileHeaders: Record<string, string> = {
          Authorization: `${tokenData.token_type || 'Bearer'} ${tokenData.access_token}`,
          Accept: 'application/json',
          ...entry.profile.headers,
        };
        const profileResponse = await fetch(entry.profile.url, {
          method: entry.profile.method || 'GET',
          headers: profileHeaders,
          body: entry.profile.body || undefined,
          signal: AbortSignal.timeout(5_000),
        });
        if (profileResponse.ok) {
          const raw = await profileResponse.json();
          profileData = entry.profile.mapResponse(raw);
        }
      } catch (profileErr) {
        log.general.warn({ err: profileErr, service }, 'Profile fetch failed (non-blocking)');
      }
    }

    // Create or update integration
    const integration = new Integration({
      oxyUserId: new mongoose.Types.ObjectId(stateData.userId),
      service,
      displayName: entry.name,
      oauthTokens: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: tokenData.expires_in
          ? new Date(Date.now() + tokenData.expires_in * 1000)
          : undefined,
        scope: tokenData.scope || entry.oauthConfig.scopes.join(' '),
        tokenType: tokenData.token_type || 'Bearer',
      },
      accountId: profileData.accountId,
      accountName: profileData.accountName,
      avatarUrl: profileData.avatarUrl,
      status: 'active',
      connectedAt: new Date(),
    });

    await integration.save();

    // Redirect to frontend
    const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
    res.redirect(`${appUrl}/settings/integrations?connected=${service}`);
  } catch (error) {
    log.general.error({ err: error }, 'OAuth callback error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Disconnect integration
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const integration = await Integration.findOneAndDelete({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!integration) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    res.json({ success: true });
  } catch (error) {
    log.general.error({ err: error }, 'Disconnect integration error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get integration status
router.get('/:id/status', authenticateToken, async (req, res) => {
  try {
    const integration = await Integration.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    }).select('-oauthTokens');

    if (!integration) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    res.json({
      status: integration.status,
      service: integration.service,
      enabled: integration.enabled,
      connectedAt: integration.connectedAt,
      lastUsedAt: integration.lastUsedAt,
    });
  } catch (error) {
    log.general.error({ err: error }, 'Integration status error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
