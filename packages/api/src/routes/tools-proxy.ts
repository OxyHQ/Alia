import { integrationsFetch } from '../lib/integrations-client.js';
import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { log } from '../lib/logger.js';

const router = express.Router();

const INTEGRATIONS_URL = process.env.INTEGRATIONS_URL;

const requireIntegrations = (
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void => {
  if (!INTEGRATIONS_URL) {
    res.status(503).json({ error: 'Integrations service not configured' });
    return;
  }
  next();
};

// Client-chosen session identifiers must be simple opaque slugs so they cannot
// be used to forge the `userId:` namespace prefix or smuggle path separators.
const CLIENT_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Bind the client-chosen session id to the authenticated user. The effective
 * key sent to the integrations service is `${userId}:${clientSessionId}`, so a
 * user can only ever address their OWN terminal/browser sessions — never one
 * created by another user. The authoritative user id is also forwarded as a
 * header for the integrations service to re-verify the namespace.
 */
function scopeSession(
  req: express.Request,
  res: express.Response,
): { scopedSessionId: string; userId: string } | null {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const clientSessionId = req.params.sessionId;
  if (typeof clientSessionId !== 'string' || !CLIENT_SESSION_ID.test(clientSessionId)) {
    res.status(400).json({ error: 'Invalid session id' });
    return null;
  }
  return { scopedSessionId: `${userId}:${clientSessionId}`, userId };
}

async function proxyToIntegrations(
  res: express.Response,
  path: string,
  userId: string,
  options?: RequestInit,
  label = 'tools proxy',
) {
  try {
    const response = await integrationsFetch(userId, path, {
      ...options,
      signal: AbortSignal.timeout(15_000),
    });
    res.status(response.status).json(await response.json());
  } catch {
    log.channels.warn({ label }, 'Integrations request failed');
    res.status(502).json({ error: `Failed: ${label}` });
  }
}

const authed = [authenticateToken, requireIntegrations] as const;

// Browser proxy
router.post('/browser/session/:sessionId/navigate', ...authed, async (req, res) => {
  const scope = scopeSession(req, res);
  if (!scope) return;
  await proxyToIntegrations(
    res,
    `/browser/session/${scope.scopedSessionId}/navigate`,
    scope.userId,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    },
    'browser navigate',
  );
});

router.get('/browser/session/:sessionId/screenshot', ...authed, async (req, res) => {
  const scope = scopeSession(req, res);
  if (!scope) return;
  await proxyToIntegrations(
    res,
    `/browser/session/${scope.scopedSessionId}/screenshot`,
    scope.userId,
    undefined,
    'browser screenshot',
  );
});

// Terminal proxy
router.post('/terminal/session/:sessionId/run', ...authed, async (req, res) => {
  const scope = scopeSession(req, res);
  if (!scope) return;
  await proxyToIntegrations(
    res,
    `/terminal/session/${scope.scopedSessionId}/run`,
    scope.userId,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    },
    'terminal run',
  );
});

export default router;
