import { internalAccount } from '../shared/internal-auth';
/**
 * MCP Routes — Integrations Service
 *
 * Called by the API service (not directly by clients).
 * Exact Alia API workload and internal account context verified in index.ts.
 */

import { Router, type Router as RouterType } from 'express';
import { errorMessage } from '../shared/utils';
import { createLogger } from '../shared/logger';
import * as manager from './manager';

const logger = createLogger('MCP');

const VALID_TRANSPORTS = new Set(['stdio', 'sse', 'streamable-http']);

/**
 * The OAuth fields of a config, checked here because they reach the vendor: a
 * pre-registered client is an object with a string id (and maybe a secret), and
 * a scope is a string. Anything else is refused rather than half-used.
 */
function oauthConfigError(config: Record<string, unknown>): string | null {
  const client = config.oauthClient;
  if (client !== undefined) {
    if (!client || typeof client !== 'object' || Array.isArray(client)) {
      return 'config.oauthClient must be an object';
    }
    const { clientId, clientSecret } = client as Record<string, unknown>;
    if (typeof clientId !== 'string' || !clientId) {
      return 'config.oauthClient.clientId must be a non-empty string';
    }
    if (clientSecret !== undefined && typeof clientSecret !== 'string') {
      return 'config.oauthClient.clientSecret must be a string';
    }
  }
  if (config.oauthScope !== undefined && typeof config.oauthScope !== 'string') {
    return 'config.oauthScope must be a string';
  }
  const revocation = config.oauthRevocation;
  if (revocation !== undefined) {
    const { url, clientAuth } = (revocation ?? {}) as Record<string, unknown>;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return 'config.oauthRevocation.url must be an https URL';
    }
    if (clientAuth !== 'basic' && clientAuth !== 'body') {
      return 'config.oauthRevocation.clientAuth must be basic or body';
    }
  }
  return null;
}

const router: RouterType = Router();
router.use((req, res, next) => {
  const accountId = internalAccount(req);
  if (!accountId) {
    res.status(401).json({ error: 'Internal account context required' });
    return;
  }
  if (req.body && typeof req.body === 'object') req.body.oxyUserId = accountId;
  const match = /^\/servers\/([^/]+)/.exec(req.path);
  if (match) {
    const session = manager.getSession(decodeURIComponent(match[1]));
    if (session && session.oxyUserId !== accountId) {
      res.status(404).json({ error: 'Server session not found' });
      return;
    }
  }
  next();
});

/** POST /mcp/servers/:id/start */
router.post('/servers/:id/start', async (req, res) => {
  const serverId = req.params.id;
  const { oxyUserId, config, transport } = req.body;

  if (!oxyUserId || typeof oxyUserId !== 'string') {
    return res.status(400).json({ error: 'oxyUserId must be a non-empty string' });
  }
  if (!transport || !VALID_TRANSPORTS.has(transport)) {
    return res
      .status(400)
      .json({ error: `transport must be one of: ${[...VALID_TRANSPORTS].join(', ')}` });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ error: 'config must be an object' });
  }
  if (transport === 'stdio' && (!config.command || typeof config.command !== 'string')) {
    return res.status(400).json({ error: 'stdio transport requires config.command as a string' });
  }
  if (
    (transport === 'streamable-http' || transport === 'sse') &&
    (!config.url || typeof config.url !== 'string')
  ) {
    return res
      .status(400)
      .json({ error: `${transport} transport requires config.url as a string` });
  }
  const startOAuthError = oauthConfigError(config);
  if (startOAuthError) return res.status(400).json({ error: startOAuthError });

  try {
    const result = await manager.startServer(serverId, oxyUserId, transport, config);
    res.json({ success: true, tools: result.tools, resources: result.resources });
  } catch (err: unknown) {
    logger.error(`Failed to start server ${serverId}:`, errorMessage(err));
    res.status(500).json({ error: errorMessage(err) });
  }
});

/** POST /mcp/servers/:id/oauth/start */
router.post('/servers/:id/oauth/start', async (req, res) => {
  const serverId = req.params.id;
  const { oxyUserId, config, transport, stateToken, callbackUrl } = req.body;

  if (!oxyUserId || typeof oxyUserId !== 'string') {
    return res.status(400).json({ error: 'oxyUserId must be a non-empty string' });
  }
  if (transport !== 'sse' && transport !== 'streamable-http') {
    return res.status(400).json({ error: 'OAuth requires an sse or streamable-http transport' });
  }
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    typeof config.url !== 'string'
  ) {
    return res.status(400).json({ error: 'config must be an object with a url string' });
  }
  const configError = oauthConfigError(config);
  if (configError) return res.status(400).json({ error: configError });
  if (!stateToken || typeof stateToken !== 'string') {
    return res.status(400).json({ error: 'stateToken must be a non-empty string' });
  }
  if (!callbackUrl || typeof callbackUrl !== 'string') {
    return res.status(400).json({ error: 'callbackUrl must be a non-empty string' });
  }

  try {
    const result = await manager.startOAuth(
      serverId,
      oxyUserId,
      transport,
      config,
      stateToken,
      callbackUrl,
    );
    res.json({ authorizationUrl: result.authorizationUrl });
  } catch (err: unknown) {
    logger.error(`Failed to start OAuth for server ${serverId}:`, errorMessage(err));
    res.status(500).json({ error: errorMessage(err) });
  }
});

/** POST /mcp/servers/:id/oauth/finish */
router.post('/servers/:id/oauth/finish', async (req, res) => {
  const serverId = req.params.id;
  const { oxyUserId, config, transport, code, callbackUrl } = req.body;

  if (!oxyUserId || typeof oxyUserId !== 'string') {
    return res.status(400).json({ error: 'oxyUserId must be a non-empty string' });
  }
  if (transport !== 'sse' && transport !== 'streamable-http') {
    return res.status(400).json({ error: 'OAuth requires an sse or streamable-http transport' });
  }
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    typeof config.url !== 'string'
  ) {
    return res.status(400).json({ error: 'config must be an object with a url string' });
  }
  const configError = oauthConfigError(config);
  if (configError) return res.status(400).json({ error: configError });
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'code must be a non-empty string' });
  }
  if (!callbackUrl || typeof callbackUrl !== 'string') {
    return res.status(400).json({ error: 'callbackUrl must be a non-empty string' });
  }

  try {
    const result = await manager.finishOAuth(
      serverId,
      oxyUserId,
      transport,
      config,
      code,
      callbackUrl,
    );
    res.json({ success: true, tools: result.tools, resources: result.resources });
  } catch (err: unknown) {
    logger.error(`Failed to finish OAuth for server ${serverId}:`, errorMessage(err));
    res.status(500).json({ error: errorMessage(err) });
  }
});

/**
 * POST /mcp/servers/:id/revoke — the person disconnected the connector: close
 * the session, ask the vendor to revoke the grant, delete the stored tokens.
 */
router.post('/servers/:id/revoke', async (req, res) => {
  const serverId = req.params.id;
  const { oxyUserId, config } = req.body;

  if (!oxyUserId || typeof oxyUserId !== 'string') {
    return res.status(400).json({ error: 'oxyUserId must be a non-empty string' });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ error: 'config must be an object' });
  }
  const configError = oauthConfigError(config);
  if (configError) return res.status(400).json({ error: configError });

  try {
    const result = await manager.revokeAuthorization(serverId, oxyUserId, config);
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    logger.error(`Failed to revoke server ${serverId}:`, errorMessage(err));
    res.status(500).json({ error: errorMessage(err) });
  }
});

/** POST /mcp/servers/:id/stop */
router.post('/servers/:id/stop', async (req, res) => {
  try {
    await manager.stopServer(req.params.id);
    res.json({ success: true });
  } catch (err: unknown) {
    logger.error(`Failed to stop server ${req.params.id}:`, errorMessage(err));
    res.status(500).json({ error: errorMessage(err) });
  }
});

/** POST /mcp/servers/:id/tools/:toolName/call */
router.post('/servers/:id/tools/:toolName/call', async (req, res) => {
  const { id: serverId, toolName } = req.params;
  const { arguments: args, transport, config, oxyUserId } = req.body;

  if (args !== undefined && (typeof args !== 'object' || Array.isArray(args) || args === null)) {
    return res.status(400).json({ error: 'arguments must be an object' });
  }
  const canReconnect =
    typeof oxyUserId === 'string' &&
    VALID_TRANSPORTS.has(transport) &&
    !!config &&
    typeof config === 'object' &&
    !Array.isArray(config);
  if (canReconnect) {
    const configError = oauthConfigError(config);
    if (configError) return res.status(400).json({ error: configError });
  }

  try {
    const result = await manager.callTool(
      serverId,
      toolName,
      args ?? {},
      canReconnect ? { oxyUserId, transport, config } : undefined,
    );
    res.json({ result });
  } catch (err: unknown) {
    logger.error(`Tool call failed (${serverId}/${toolName}):`, errorMessage(err));
    res.status(500).json({ error: errorMessage(err) });
  }
});

/** GET /mcp/servers/:id/tools */
router.get('/servers/:id/tools', (req, res) => {
  const session = manager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Server session not found' });
  res.json({ tools: session.tools, resources: session.resources });
});

/** GET /mcp/servers/:id/status */
router.get('/servers/:id/status', (req, res) => {
  const session = manager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Server session not found' });
  res.json({
    status: session.status,
    statusMessage: session.statusMessage,
    transport: session.transport,
    toolCount: session.tools.length,
    resourceCount: session.resources.length,
    uptime: Date.now() - session.startedAt.getTime(),
  });
});

/** GET /mcp/sessions */
router.get('/sessions', (req, res) => {
  res.json({
    sessions: manager
      .listSessions()
      .filter((session) => session.oxyUserId === internalAccount(req)),
  });
});

export { router as mcpRouter };
