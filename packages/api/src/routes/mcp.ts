import express from 'express';
import crypto from 'crypto';
import { authenticateToken } from '../middleware/auth.js';
import { getDb } from '../db/index.js';
import {
  deleteMcpServerForUser,
  findMcpServerByName,
  findMcpServerForUser,
  installMcpServer,
  listMcpServersForUser,
  serializeMcpServer,
  setMcpServerStatus,
  toMcpServerConfig,
  updateMcpServer,
  type McpServerConfig,
} from '../db/integrations/mcpServerRepository.js';
import {
  createMcpOAuthState,
  deleteMcpOAuthState,
  deleteMcpOAuthStateByToken,
  findLiveMcpOAuthState,
} from '../db/integrations/mcpOAuthStateRepository.js';
import type {
  McpServerResource,
  McpServerRuntime,
  McpServerTool,
  McpServerTransport,
} from '../db/schema/integrations.js';
import { MCP_REGISTRY } from '../lib/mcp-registry.js';
import { log } from '../lib/logger.js';

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
router.post('/:id/oauth/start', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const db = getDb();
    const server = await findMcpServerForUser(db, req.params.id, req.userId!);

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
    await createMcpOAuthState(db, {
      state,
      oxyUserId: req.userId!,
      serverId: server.id,
    });

    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:4150';
    const callbackUrl = `${apiBaseUrl}/mcp/oauth/callback`;

    const response = await fetch(`${INTEGRATIONS_URL}/mcp/servers/${server.id}/oauth/start`, {
      method: 'POST',
      headers: {
        'X-Gateway-Secret': INTEGRATIONS_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        oxyUserId: req.userId,
        config: toMcpServerConfig(server),
        transport: server.transport,
        stateToken: state,
        callbackUrl,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await response.json();

    if (!response.ok) {
      // The state row is short-lived (TTL), so a failed start self-cleans.
      await deleteMcpOAuthStateByToken(db, state);
      return res.status(response.status).json({ error: data.error || 'Failed to start OAuth' });
    }

    if (!data.authorizationUrl || typeof data.authorizationUrl !== 'string') {
      await deleteMcpOAuthStateByToken(db, state);
      return res.status(502).json({ error: 'OAuth authorization URL was not returned' });
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
  const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:4150';
  const { code, state } = req.query;

  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    return res.redirect(`${appUrl}/settings/connectors?error=oauth_invalid`);
  }

  // Validate the state exists and is unexpired WITHOUT consuming it — the
  // authenticated /oauth/complete call consumes it after verifying the caller.
  // The expiry lives in the repository, so this reader and the one below cannot
  // disagree about how old is too old.
  const stateRow = await findLiveMcpOAuthState(getDb(), state);
  if (!stateRow) {
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

    const db = getDb();
    const stateRow = await findLiveMcpOAuthState(db, state);
    if (!stateRow) {
      return res.status(400).json({ error: 'Invalid or expired state' });
    }

    // CSRF binding: the state must have been issued to the authenticated caller.
    // Whoever holds the code (the browser that got the callback) can only finish
    // the link into their OWN account, never someone else's.
    if (stateRow.oxyUserId !== req.userId) {
      return res.status(403).json({ error: 'State was not issued to this account' });
    }

    // Consume the state (single-use) now that the caller is verified.
    await deleteMcpOAuthState(db, stateRow.id);

    if (!INTEGRATIONS_URL || !INTEGRATIONS_SECRET) {
      return res.status(503).json({ error: 'Integrations service not configured' });
    }

    const server = await findMcpServerForUser(db, stateRow.serverId, req.userId!);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:4150';
    const callbackUrl = `${apiBaseUrl}/mcp/oauth/callback`;

    const response = await fetch(`${INTEGRATIONS_URL}/mcp/servers/${server.id}/oauth/finish`, {
      method: 'POST',
      headers: {
        'X-Gateway-Secret': INTEGRATIONS_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        oxyUserId: req.userId,
        config: toMcpServerConfig(server),
        transport: server.transport,
        code,
        callbackUrl,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      await setMcpServerStatus(db, server.id, req.userId!, {
        status: 'error',
        statusMessage: data.error || 'OAuth connection failed',
      });
      return res.status(response.status === 200 ? 502 : response.status).json({
        error: data.error || 'OAuth connection failed',
      });
    }

    const connected = await setMcpServerStatus(db, server.id, req.userId!, {
      status: 'running',
      // Durably mark this connector as OAuth-authenticated so a later normal
      // /:id/start reattaches the SDK OAuthClientProvider (integrations rebuilds
      // it from config.requiresOAuth) instead of connecting unauthenticated.
      requiresOAuth: true,
      ...(data.tools ? { tools: data.tools as McpServerTool[] } : {}),
      ...(data.resources ? { resources: data.resources as McpServerResource[] } : {}),
    });
    if (!connected) {
      return res.status(404).json({ error: 'Server not found' });
    }

    res.json({ server: serializeMcpServer(connected) });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'MCP OAuth complete error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List user's installed MCP servers
router.get('/installed', authenticateToken, async (req, res) => {
  try {
    const servers = await listMcpServersForUser(getDb(), req.userId!);
    res.json({ servers: servers.map(serializeMcpServer) });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'List MCP servers error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Install MCP server
router.post('/install', authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const { registryId, name, displayName, description, icon, transport, runtime, config, env } = req.body;

    let serverConfig: {
      name?: string;
      displayName?: string;
      description?: string;
      icon?: string;
      transport?: McpServerTransport;
      runtime?: McpServerRuntime;
      config?: McpServerConfig;
    } = { name, displayName, description, icon, transport, runtime, config };

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
          // stdio entries leave these undefined, and `installMcpServer` turns an
          // undefined into a NULL column, which `toMcpServerConfig` reads back as
          // an absent key — the round trip Mongoose gave for free.
          url: registryEntry.url,
          requiresOAuth: registryEntry.requiresOAuth,
          ...(env && typeof env === 'object' && !Array.isArray(env) ? { env } : {}),
          ...config,
        },
      };
    }

    if (!serverConfig.name || !serverConfig.displayName || !serverConfig.transport) {
      return res.status(400).json({ error: 'name, displayName, and transport are required' });
    }

    const server = await installMcpServer(db, {
      oxyUserId: req.userId!,
      name: serverConfig.name,
      displayName: serverConfig.displayName,
      description: serverConfig.description,
      icon: serverConfig.icon,
      source: registryId ? 'registry' : 'custom',
      registryId,
      transport: serverConfig.transport,
      runtime: serverConfig.runtime ?? 'server',
      config: serverConfig.config ?? {},
    });

    if (!server) {
      // The name is taken, which `mcp_servers_oxy_user_name_key` decided rather
      // than a read-then-write race. Registry installs are idempotent: the
      // Connect flow calls /install to "ensure the connector exists" before
      // starting OAuth, so an already-installed registry connector must return
      // the existing server (200) rather than 409 — otherwise Connect fails.
      // Custom installs keep the 409 (the user explicitly named a new server).
      if (registryId) {
        const existing = await findMcpServerByName(db, req.userId!, registryId);
        if (existing) {
          return res.status(200).json({ server: serializeMcpServer(existing) });
        }
      }
      return res.status(409).json({ error: 'MCP server with this name is already installed' });
    }

    res.status(201).json({ server: serializeMcpServer(server) });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Install MCP server error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Uninstall MCP server
router.delete('/:id', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const server = await deleteMcpServerForUser(getDb(), req.params.id, req.userId!);

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Stop in integrations if running
    if (server.status === 'running' && server.runtime === 'server' && INTEGRATIONS_URL && INTEGRATIONS_SECRET) {
      try {
        await fetch(`${INTEGRATIONS_URL}/mcp/servers/${server.id}/stop`, {
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
router.patch('/:id', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const { config, enabled, runtime } = req.body;
    const server = await updateMcpServer(getDb(), req.params.id, req.userId!, {
      config,
      enabled,
      runtime,
    });

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    res.json({ server: serializeMcpServer(server) });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Update MCP server error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start MCP server (server-side only)
router.post('/:id/start', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const db = getDb();
    const server = await findMcpServerForUser(db, req.params.id, req.userId!);

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (server.runtime === 'local') {
      return res.status(400).json({ error: 'Local MCP servers are managed by the client app' });
    }

    if (!INTEGRATIONS_URL || !INTEGRATIONS_SECRET) {
      return res.status(503).json({ error: 'Integrations service not configured' });
    }

    const response = await fetch(`${INTEGRATIONS_URL}/mcp/servers/${server.id}/start`, {
      method: 'POST',
      headers: {
        'X-Gateway-Secret': INTEGRATIONS_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        oxyUserId: req.userId,
        config: toMcpServerConfig(server),
        transport: server.transport,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await response.json();

    const updated = response.ok
      ? await setMcpServerStatus(db, server.id, req.userId!, {
          status: 'running',
          ...(data.tools ? { tools: data.tools as McpServerTool[] } : {}),
          ...(data.resources ? { resources: data.resources as McpServerResource[] } : {}),
        })
      : await setMcpServerStatus(db, server.id, req.userId!, {
          status: 'error',
          statusMessage: data.error || 'Failed to start',
        });

    if (!updated) {
      return res.status(404).json({ error: 'Server not found' });
    }

    res.status(response.status).json({ server: serializeMcpServer(updated), ...data });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Start MCP server error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stop MCP server
router.post('/:id/stop', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const db = getDb();
    const server = await findMcpServerForUser(db, req.params.id, req.userId!);

    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    if (server.runtime === 'local') {
      return res.status(400).json({ error: 'Local MCP servers are managed by the client app' });
    }

    if (INTEGRATIONS_URL && INTEGRATIONS_SECRET) {
      try {
        await fetch(`${INTEGRATIONS_URL}/mcp/servers/${server.id}/stop`, {
          method: 'POST',
          headers: { 'X-Gateway-Secret': INTEGRATIONS_SECRET },
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Continue even if integrations fails
      }
    }

    const stopped = await setMcpServerStatus(db, server.id, req.userId!, { status: 'stopped' });
    if (!stopped) {
      return res.status(404).json({ error: 'Server not found' });
    }

    res.json({ server: serializeMcpServer(stopped) });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Stop MCP server error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List tools from MCP server
router.get('/:id/tools', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const server = await findMcpServerForUser(getDb(), req.params.id, req.userId!);

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
router.get('/:id/status', authenticateToken, async (req: express.Request<{ id: string }>, res) => {
  try {
    const server = await findMcpServerForUser(getDb(), req.params.id, req.userId!);

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
