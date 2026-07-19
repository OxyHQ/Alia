import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { authenticateToken } from '../middleware/auth.js';
import { McpServer } from '../models/mcp-server.js';
import { McpOAuthState, MCP_OAUTH_STATE_TTL_SECONDS } from '../models/mcp-oauth-state.js';
import { MCP_REGISTRY } from '../lib/mcp-registry.js';
import { log } from '../lib/logger.js';
import { isDuplicateKeyError } from '../lib/errors/index.js';

const router = express.Router();

const INTEGRATIONS_URL = process.env.INTEGRATIONS_URL;
const INTEGRATIONS_SECRET = process.env.INTEGRATIONS_SECRET;

// Browse MCP registry
router.get('/registry', authenticateToken, (_req, res) => {
  res.json({ servers: MCP_REGISTRY });
});

// Get MCP server details from registry
router.get('/registry/:id', authenticateToken, (req, res) => {
  const server = MCP_REGISTRY.find(s => s.id === req.params.id);
  if (!server) {
    return res.status(404).json({ error: 'Server not found in registry' });
  }
  res.json({ server });
});

// ---------------------------------------------------------------------------
// OAuth for remote MCP connectors
//
// The literal `GET /oauth/callback` MUST be registered BEFORE any `/:id`
// parametrised route so Express never captures `oauth` as an `:id`. Keep this
// block above the `/:id/*` routes below.
// ---------------------------------------------------------------------------

// Begin the interactive OAuth flow — proxies to integrations, returns the
// authorization URL the client should open.
router.post('/:id/oauth/start', authenticateToken, async (req, res) => {
  try {
    const server = await McpServer.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (server.runtime === 'local') {
      return res.status(400).json({ error: 'Local MCP servers are managed by the client app' });
    }

    if (server.transport !== 'sse' && server.transport !== 'streamable-http') {
      return res.status(400).json({ error: 'OAuth is only supported for remote MCP connectors' });
    }

    if (!INTEGRATIONS_URL || !INTEGRATIONS_SECRET) {
      return res.status(503).json({ error: 'Integrations service not configured' });
    }

    const state = crypto.randomBytes(32).toString('hex');
    await McpOAuthState.create({
      state,
      oxyUserId: req.userId,
      serverId: String(server._id),
    });

    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
    const callbackUrl = `${apiBaseUrl}/mcp/oauth/callback`;

    const response = await fetch(`${INTEGRATIONS_URL}/mcp/servers/${server._id}/oauth/start`, {
      method: 'POST',
      headers: {
        'X-Gateway-Secret': INTEGRATIONS_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        oxyUserId: req.userId,
        config: server.config,
        transport: server.transport,
        stateToken: state,
        callbackUrl,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await response.json();

    if (!response.ok) {
      // The state row is short-lived (TTL), so a failed start self-cleans.
      return res.status(response.status).json({ error: data.error || 'Failed to start OAuth' });
    }

    res.json({ authorizationUrl: data.authorizationUrl });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Start MCP OAuth error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public OAuth callback — the Authorization Server redirects the browser here.
// It does NOT finalize the link: identity from the `state` alone is NOT
// trusted for linking (that would be account-linking CSRF — an attacker who
// initiates the flow could have a victim consent at the provider and get the
// victim's external tokens linked under the attacker's account). Instead this
// hands `state`+`code` to the app (delivered only to the browser that received
// the callback), and finalization happens via the authenticated
// POST /oauth/complete below, which binds the link to the initiating session.
router.get('/oauth/callback', async (req, res) => {
  const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
  const { code, state } = req.query;

  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    return res.redirect(`${appUrl}/settings/connectors?error=oauth_invalid`);
  }

  // Validate the state exists and is unexpired WITHOUT consuming it — the
  // authenticated /oauth/complete call consumes it after verifying the caller.
  const stateDoc = await McpOAuthState.findOne({ state });
  if (!stateDoc || Date.now() - stateDoc.createdAt.getTime() > MCP_OAUTH_STATE_TTL_SECONDS * 1000) {
    return res.redirect(`${appUrl}/settings/connectors?error=oauth_expired`);
  }

  // Deliver state+code to the app (this browser only). The raw provider code is
  // useless without the server-side PKCE verifier held in the integrations
  // process, so exposing it to the initiating client is safe for a public
  // client; the exchange still happens server-side in /oauth/complete.
  const params = new URLSearchParams({ mcp_oauth_state: state, mcp_oauth_code: code });
  res.redirect(`${appUrl}/settings/connectors?${params.toString()}`);
});

// Finalize the OAuth link — AUTHENTICATED, so the linked account is the caller's
// session, never an identity smuggled in via `state`. Verifies the state was
// issued to THIS user before exchanging the code, defeating account-linking CSRF.
router.post('/oauth/complete', authenticateToken, async (req, res) => {
  try {
    const { state, code } = req.body;
    if (!state || !code || typeof state !== 'string' || typeof code !== 'string') {
      return res.status(400).json({ error: 'state and code are required' });
    }

    const stateDoc = await McpOAuthState.findOne({ state });
    if (!stateDoc || Date.now() - stateDoc.createdAt.getTime() > MCP_OAUTH_STATE_TTL_SECONDS * 1000) {
      return res.status(400).json({ error: 'Invalid or expired state' });
    }

    // CSRF binding: the state must have been issued to the authenticated caller.
    // Whoever holds the code (the browser that got the callback) can only finish
    // the link into their OWN account, never someone else's.
    if (stateDoc.oxyUserId !== req.userId) {
      return res.status(403).json({ error: 'State was not issued to this account' });
    }

    // Consume the state (single-use) now that the caller is verified.
    await McpOAuthState.deleteOne({ _id: stateDoc._id });

    if (!INTEGRATIONS_URL || !INTEGRATIONS_SECRET) {
      return res.status(503).json({ error: 'Integrations service not configured' });
    }

    const server = await McpServer.findOne({
      _id: stateDoc.serverId,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
    const callbackUrl = `${apiBaseUrl}/mcp/oauth/callback`;

    const response = await fetch(`${INTEGRATIONS_URL}/mcp/servers/${server._id}/oauth/finish`, {
      method: 'POST',
      headers: {
        'X-Gateway-Secret': INTEGRATIONS_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        oxyUserId: req.userId,
        config: server.config,
        transport: server.transport,
        code,
        callbackUrl,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      server.status = 'error';
      server.statusMessage = data.error || 'OAuth connection failed';
      await server.save();
      return res.status(response.status === 200 ? 502 : response.status).json({
        error: data.error || 'OAuth connection failed',
      });
    }

    server.status = 'running';
    // Durably mark this connector as OAuth-authenticated so a later normal
    // /:id/start reattaches the SDK OAuthClientProvider (integrations rebuilds
    // it from config.requiresOAuth) instead of connecting unauthenticated.
    server.config.requiresOAuth = true;
    if (data.tools) server.tools = data.tools;
    if (data.resources) server.resources = data.resources;
    await server.save();

    res.json({ server });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'MCP OAuth complete error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List user's installed MCP servers
router.get('/installed', authenticateToken, async (req, res) => {
  try {
    const servers = await McpServer.find({
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    }).sort({ createdAt: -1 });
    res.json({ servers });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'List MCP servers error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Install MCP server
router.post('/install', authenticateToken, async (req, res) => {
  try {
    const { registryId, name, displayName, description, icon, transport, runtime, config } = req.body;

    let serverConfig = { name, displayName, description, icon, transport, runtime, config };

    // If installing from registry, use registry defaults
    if (registryId) {
      const registryEntry = MCP_REGISTRY.find(s => s.id === registryId);
      if (!registryEntry) {
        return res.status(404).json({ error: 'Server not found in registry' });
      }

      serverConfig = {
        name: registryEntry.id,
        displayName: registryEntry.name,
        description: registryEntry.description,
        icon: registryEntry.icon,
        transport: registryEntry.transport,
        runtime: runtime || 'server',
        config: {
          command: registryEntry.command,
          args: registryEntry.args,
          // Remote connectors carry their hosted endpoint + OAuth requirement;
          // stdio entries leave these undefined (Mongoose omits them).
          url: registryEntry.url,
          requiresOAuth: registryEntry.requiresOAuth,
          ...config,
        },
      };
    }

    if (!serverConfig.name || !serverConfig.displayName || !serverConfig.transport) {
      return res.status(400).json({ error: 'name, displayName, and transport are required' });
    }

    const server = new McpServer({
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
      ...serverConfig,
      source: registryId ? 'registry' : 'custom',
      registryId,
      status: 'installed',
    });

    await server.save();
    res.status(201).json({ server });
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      // Registry installs are idempotent: the Connect flow calls /install to
      // "ensure the connector exists" before starting OAuth, so an already-
      // installed registry connector must return the existing server (200)
      // rather than 409 — otherwise Connect fails with a duplicate-key 409.
      // Custom installs keep the 409 (the user explicitly named a new server).
      const rid = req.body.registryId;
      if (rid) {
        const existing = await McpServer.findOne({
          oxyUserId: new mongoose.Types.ObjectId(req.userId),
          name: rid,
        });
        if (existing) {
          return res.status(200).json({ server: existing });
        }
      }
      return res.status(409).json({ error: 'MCP server with this name is already installed' });
    }
    log.general.error({ err: error }, 'Install MCP server error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Uninstall MCP server
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const server = await McpServer.findOneAndDelete({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Stop in integrations if running
    if (server.status === 'running' && server.runtime === 'server' && INTEGRATIONS_URL && INTEGRATIONS_SECRET) {
      try {
        await fetch(`${INTEGRATIONS_URL}/mcp/servers/${server._id}/stop`, {
          method: 'POST',
          headers: { 'X-Gateway-Secret': INTEGRATIONS_SECRET },
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Best effort
      }
    }

    res.json({ success: true });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Uninstall MCP server error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update MCP server config
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const server = await McpServer.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const { config, enabled, runtime } = req.body;
    if (config !== undefined) server.config = { ...server.config, ...config };
    if (enabled !== undefined) server.enabled = enabled;
    if (runtime !== undefined) server.runtime = runtime;

    await server.save();
    res.json({ server });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Update MCP server error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start MCP server (server-side only)
router.post('/:id/start', authenticateToken, async (req, res) => {
  try {
    const server = await McpServer.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (server.runtime === 'local') {
      return res.status(400).json({ error: 'Local MCP servers are managed by the client app' });
    }

    if (!INTEGRATIONS_URL || !INTEGRATIONS_SECRET) {
      return res.status(503).json({ error: 'Integrations service not configured' });
    }

    const response = await fetch(`${INTEGRATIONS_URL}/mcp/servers/${server._id}/start`, {
      method: 'POST',
      headers: {
        'X-Gateway-Secret': INTEGRATIONS_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        oxyUserId: req.userId,
        config: server.config,
        transport: server.transport,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await response.json();

    if (response.ok) {
      server.status = 'running';
      if (data.tools) server.tools = data.tools;
      if (data.resources) server.resources = data.resources;
      await server.save();
    } else {
      server.status = 'error';
      server.statusMessage = data.error || 'Failed to start';
      await server.save();
    }

    res.status(response.status).json({ server, ...data });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Start MCP server error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stop MCP server
router.post('/:id/stop', authenticateToken, async (req, res) => {
  try {
    const server = await McpServer.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (server.runtime === 'local') {
      return res.status(400).json({ error: 'Local MCP servers are managed by the client app' });
    }

    if (INTEGRATIONS_URL && INTEGRATIONS_SECRET) {
      try {
        await fetch(`${INTEGRATIONS_URL}/mcp/servers/${server._id}/stop`, {
          method: 'POST',
          headers: { 'X-Gateway-Secret': INTEGRATIONS_SECRET },
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Continue even if integrations fails
      }
    }

    server.status = 'stopped';
    await server.save();

    res.json({ server });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Stop MCP server error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List tools from MCP server
router.get('/:id/tools', authenticateToken, async (req, res) => {
  try {
    const server = await McpServer.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    res.json({ tools: server.tools, resources: server.resources });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'List MCP tools error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check / status
router.get('/:id/status', authenticateToken, async (req, res) => {
  try {
    const server = await McpServer.findOne({
      _id: req.params.id,
      oxyUserId: new mongoose.Types.ObjectId(req.userId),
    });

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    res.json({
      status: server.status,
      statusMessage: server.statusMessage,
      runtime: server.runtime,
      enabled: server.enabled,
      toolCount: server.tools.length,
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'MCP status error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
