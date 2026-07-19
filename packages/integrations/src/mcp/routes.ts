/**
 * MCP Routes — Integrations Service
 *
 * Called by the API service (not directly by clients).
 * Authentication via X-Gateway-Secret middleware in index.ts.
 */

import { Router, type Router as RouterType } from 'express';
import { errorMessage } from '../shared/utils';
import { createLogger } from '../shared/logger';
import * as manager from './manager';

const logger = createLogger('MCP');

const VALID_TRANSPORTS = new Set(['stdio', 'sse', 'streamable-http']);

const router: RouterType = Router();

/** POST /mcp/servers/:id/start */
router.post('/servers/:id/start', async (req, res) => {
  const serverId = req.params.id;
  const { oxyUserId, config, transport } = req.body;

  if (!oxyUserId || typeof oxyUserId !== 'string') {
    return res.status(400).json({ error: 'oxyUserId must be a non-empty string' });
  }
  if (!transport || !VALID_TRANSPORTS.has(transport)) {
    return res.status(400).json({ error: `transport must be one of: ${[...VALID_TRANSPORTS].join(', ')}` });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ error: 'config must be an object' });
  }
  if (transport === 'stdio' && (!config.command || typeof config.command !== 'string')) {
    return res.status(400).json({ error: 'stdio transport requires config.command as a string' });
  }
  if ((transport === 'streamable-http' || transport === 'sse') && (!config.url || typeof config.url !== 'string')) {
    return res.status(400).json({ error: `${transport} transport requires config.url as a string` });
  }

  try {
    const result = await manager.startServer(serverId, oxyUserId, transport, config);
    res.json({ success: true, tools: result.tools, resources: result.resources });
  } catch (err: unknown) {
    logger.error(`Failed to start server ${serverId}:`, errorMessage(err));
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
  const args = req.body.arguments;

  if (args !== undefined && (typeof args !== 'object' || Array.isArray(args) || args === null)) {
    return res.status(400).json({ error: 'arguments must be an object' });
  }

  try {
    const result = await manager.callTool(serverId, toolName, args ?? {});
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
router.get('/sessions', (_req, res) => {
  res.json({ sessions: manager.listSessions() });
});

export { router as mcpRouter };
