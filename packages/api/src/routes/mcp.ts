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
// No authenticateToken: identity is recovered from the single-use state.
router.get('/oauth/callback', async (req, res) => {
  const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
  const { code, state } = req.query;

  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  // Atomically consume the state to prevent replay.
  const stateDoc = await McpOAuthState.findOneAndDelete({ state });
  if (!stateDoc || Date.now() - stateDoc.createdAt.getTime() > MCP_OAUTH_STATE_TTL_SECONDS * 1000) {
    return res.status(400).json({ error: 'Invalid or expired state' });
  }

  const { oxyUserId, serverId } = stateDoc;

  if (!INTEGRATIONS_URL || !INTEGRATIONS_SECRET) {
    return res.redirect(`${appUrl}/settings/connectors?error=not_configured&server=${serverId}`);
  }

  try {
    const server = await McpServer.findOne({
      _id: serverId,
      oxyUserId: new mongoose.Types.ObjectId(oxyUserId),
    });

    if (!server) {
      return res.redirect(`${appUrl}/settings/connectors?error=server_not_found`);
    }

    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
    const callbackUrl = `${apiBaseUrl}/mcp/oauth/callback`;

    const response = await fetch(`${INTEGRATIONS_URL}/mcp/servers/${serverId}/oauth/finish`, {
      method: 'POST',
      headers: {
        'X-Gateway-Secret': INTEGRATIONS_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        oxyUserId,
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
      return res.redirect(`${appUrl}/settings/connectors?error=oauth_failed&server=${serverId}`);
    }

    server.status = 'running';
    // Durably mark this connector as OAuth-authenticated so a later normal
    // /:id/start reattaches the SDK OAuthClientProvider (integrations rebuilds
    // it from config.requiresOAuth) instead of connecting unauthenticated.
    server.config.requiresOAuth = true;
    if (data.tools) server.tools = data.tools;
    if (data.resources) server.resources = data.resources;
    await server.save();

    res.redirect(`${appUrl}/settings/connectors?connected=${serverId}`);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'MCP OAuth callback error');
    res.redirect(`${appUrl}/settings/connectors?error=internal&server=${serverId}`);
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
