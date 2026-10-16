/**
 * `GET /agents/:id/requester-apps` and `PUT /agents/:id/requester-apps/:appId`
 * — what an agent may do, per Oxy app, for WHOEVER uses it (Alia ADR 0020 §2,
 * Oxy ADR 0042): the person using a public or shared agent gets it on their
 * OWN account, never the owner's.
 *
 * Whoever operates the agent may read and change it; Oxy re-checks that with
 * the caller's own bearer and is the store, so this route keeps no copy.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { loadAgentForActor, refusalMessage, refusalStatus } from '../../lib/agent-account.js';
import { AgentOxyAppsError } from '../../lib/agent-oxy-apps.js';
import {
  listAgentRequesterApps,
  setAgentRequesterAppLevel,
} from '../../lib/agent-requester-apps.js';
import { log } from '../../lib/logger.js';
import { OXY_APP_LEVELS } from '../../domain/agent-oxy-app-level.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = Router();

async function operatedAgent(req: Request, res: Response) {
  if (!req.user?.id || !req.accessToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const loaded = await loadAgentForActor(getDb(), {
    agentId: String(req.params.id),
    oxyUserId: req.user.id,
    accessToken: req.accessToken,
    cache: false,
  });
  if (!loaded.ok) {
    res.status(loaded.refusal === 'agent_not_found' ? 404 : refusalStatus(loaded.refusal)).json({
      error:
        loaded.refusal === 'agent_not_found' ? 'Agent not found' : refusalMessage(loaded.refusal),
    });
    return null;
  }
  return { agent: loaded.agent, accessToken: req.accessToken };
}

function answer(res: Response, error: unknown) {
  if (error instanceof AgentOxyAppsError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  log.agents.error({ err: error }, 'Agent requester app levels failed');
  return res.status(500).json({ error: 'Failed to load what this agent may do for its users' });
}

router.get('/:id/requester-apps', authenticateToken, async (req: Request, res: Response) => {
  try {
    const operated = await operatedAgent(req, res);
    if (!operated) return;
    res.json({ apps: await listAgentRequesterApps(operated.agent, operated.accessToken) });
  } catch (error: unknown) {
    answer(res, error);
  }
});

const levelSchema = z.object({ level: z.enum(OXY_APP_LEVELS) }).strict();

router.put('/:id/requester-apps/:appId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const parsed = levelSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_level' });
    const operated = await operatedAgent(req, res);
    if (!operated) return;
    res.json({
      app: await setAgentRequesterAppLevel(
        operated.agent,
        operated.accessToken,
        String(req.params.appId),
        parsed.data.level,
      ),
    });
  } catch (error: unknown) {
    answer(res, error);
  }
});

export default router;
