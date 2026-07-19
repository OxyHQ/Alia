import express from 'express';
import crypto from 'crypto';
import mongoose, { Schema } from 'mongoose';
import { authenticateToken } from '../middleware/auth.js';
import { Integration } from '../models/integration.js';
import { INTEGRATION_REGISTRY, type IntegrationRegistryEntry } from '../lib/integration-registry.js';
import { log } from '../lib/logger.js';

const router = express.Router();

// MongoDB-backed OAuth state store (survives restarts, works across instances)
const OAuthStateSchema = new Schema({
  _id: { type: String }, // the random state token
  service: { type: String, required: true },
  userId: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
OAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL auto-cleanup
const OAuthState = mongoose.model('OAuthState', OAuthStateSchema);

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
  } catch (error: unknown) {
    log.general.error({ err: error }, 'List integrations error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Generate OAuth URL for a service
router.get('/:service/oauth-url', authenticateToken, async (req: express.Request<{ service: string }>, res) => {
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
  await OAuthState.create({
    _id: state,
    service,
    userId: req.userId!,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
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

// Public OAuth callback — the provider redirects the browser here after consent.
// It does NOT finalize the link: identity from the `state` alone is NOT trusted
// for linking (that would be account-linking CSRF — an attacker who initiates
// the flow could have a victim consent at the provider and get the victim's
// external tokens linked under the attacker's account). Instead this validates
// the state exists+unexpired WITHOUT consuming it, then hands `state`+`code` to
// the app (delivered only to the browser that received the callback). The
// frontend reads int_oauth_state/int_oauth_code on /settings/integrations and
// finalizes via the authenticated POST /:service/complete below, which binds the
// link to the initiating session.
router.get('/:service/callback', async (req: express.Request<{ service: string }>, res) => {
  const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
  const { service } = req.params;
  const { code, state } = req.query;

  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    return res.redirect(
      `${appUrl}/settings/integrations?service=${encodeURIComponent(service)}&error=oauth_invalid`,
    );
  }

  // Validate the state exists, matches the service, and is unexpired WITHOUT
  // consuming it — the authenticated /complete call consumes it after verifying
  // the caller owns it.
  const stateData = await OAuthState.findOne({ _id: state });
  if (!stateData || stateData.service !== service || stateData.expiresAt < new Date()) {
    return res.redirect(
      `${appUrl}/settings/integrations?service=${encodeURIComponent(service)}&error=oauth_expired`,
    );
  }

  // Deliver state+code to the app (this browser only). The exchange still
  // happens server-side in POST /:service/complete, scoped to the caller.
  const params = new URLSearchParams({
    service,
    int_oauth_state: state,
    int_oauth_code: code,
  });
  res.redirect(`${appUrl}/settings/integrations?${params.toString()}`);
});

// Finalize the OAuth link — AUTHENTICATED, so the linked Integration is bound to
// the caller's session, never an identity smuggled in via `state`. Verifies the
// state was issued to THIS user before exchanging the code, defeating
// account-linking CSRF. The frontend calls this with the int_oauth_state/
// int_oauth_code it received on the /settings/integrations screen.
router.post('/:service/complete', authenticateToken, async (req: express.Request<{ service: string }>, res) => {
  const { service } = req.params;
  const { state, code } = req.body;

  if (!state || !code || typeof state !== 'string' || typeof code !== 'string') {
    return res.status(400).json({ error: 'state and code are required' });
  }

  // Load and validate the state WITHOUT consuming it, so a mismatched caller
  // cannot burn the initiating user's state.
  const stateData = await OAuthState.findOne({ _id: state });
  if (!stateData || stateData.service !== service || stateData.expiresAt < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired state' });
  }

  // CSRF binding: the state must have been issued to the authenticated caller.
  // Whoever holds the code (the browser that got the callback) can only finish
  // the link into their OWN account, never someone else's.
  if (stateData.userId !== req.userId) {
    return res.status(403).json({ error: 'State was not issued to this account' });
  }

  // Consume the state (single-use) now that the caller is verified. The atomic
  // delete also guards against replay/race between the load above and here.
  const consumed = await OAuthState.findOneAndDelete({ _id: state });
  if (!consumed) {
    return res.status(400).json({ error: 'Invalid or expired state' });
  }

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
      log.general.error(
        { error: tokenData.error, errorDescription: tokenData.error_description, service },
        'OAuth token exchange failed',
      );
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
      } catch (profileErr: unknown) {
        log.general.warn({ err: profileErr, service }, 'Profile fetch failed (non-blocking)');
      }
    }

    // Create the integration bound to the authenticated caller (never stateData
    // identity — that is the CSRF fix).
    const integration = new Integration({
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
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

    // Return the integration without the encrypted OAuth tokens.
    const integrationSafe = await Integration.findById(integration._id).select('-oauthTokens');
    res.json({ integration: integrationSafe });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'OAuth complete error');
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
  } catch (error: unknown) {
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
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Integration status error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
