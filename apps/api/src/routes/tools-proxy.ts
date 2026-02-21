import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
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
  label = 'tools proxy',
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
      log.channels.error({ err: error, label, attempt: attempt + 1 }, 'Tools proxy error');
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
        continue;
      }
      res.status(502).json({ error: `Failed: ${label}` });
    }
  }
}

const authed = [authenticateToken, requireIntegrations] as const;

// Browser proxy
router.post('/browser/session/:sessionId/navigate', ...authed, async (req, res) => {
  await proxyToIntegrations(res, `/browser/session/${req.params.sessionId}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  }, 'browser navigate');
});

router.get('/browser/session/:sessionId/screenshot', ...authed, async (req, res) => {
  await proxyToIntegrations(res, `/browser/session/${req.params.sessionId}/screenshot`, undefined, 'browser screenshot');
});

// Terminal proxy
router.post('/terminal/session/:sessionId/run', ...authed, async (req, res) => {
  await proxyToIntegrations(res, `/terminal/session/${req.params.sessionId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  }, 'terminal run');
});

export default router;
