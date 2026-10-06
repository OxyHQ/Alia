/**
 * `GET /agents/:id/oxy-apps` and `PUT /agents/:id/oxy-apps/:appId` — what of
 * its owner's data an agent may use, one level per Oxy app (ADR 0015).
 *
 * Only the agent's OWNER may read or change them: a level is a grant over the
 * owner's account, made with the owner's own bearer, and Oxy refuses anybody
 * else. Somebody who merely operates the bot gets 403 here rather than a list
 * of the owner's levels.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { loadAgentForActor, refusalMessage, refusalStatus } from '../../lib/agent-account.js';
import {
  AgentOxyAppsError,
  listAgentOxyApps,
  setAgentOxyAppLevel,
} from '../../lib/agent-oxy-apps.js';
import { log } from '../../lib/logger.js';
import { OXY_APP_LEVELS } from '../../domain/agent-oxy-app-level.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = Router();

async function ownedAgent(req: Request, res: Response) {
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
    res.status(loaded.refusal === 'agent_not_found' ? 404 : refusalStatus(loaded.refusal))
      .json({ error: loaded.refusal === 'agent_not_found' ? 'Agent not found' : refusalMessage(loaded.refusal) });
    return null;
  }
  if (typeof loaded.agent.applicationId === 'string') {
    res.status(400).json({ error: 'Product-agent policy is managed internally' });
    return null;
  }
  if (loaded.agent.ownerOxyAccountId !== req.user.id) {
    res.status(403).json({ error: 'owner_only', message: 'Only the agent\'s owner can choose what of their data it may use' });
    return null;
  }
  return { agent: loaded.agent, accessToken: req.accessToken };
}

function answer(res: Response, error: unknown) {
  if (error instanceof AgentOxyAppsError) {
    return res.status(error.status).json({ error: error.code, message: error.message });
  }
  log.agents.error({ err: error }, 'Agent Oxy app permissions failed');
  return res.status(500).json({ error: 'Failed to load the agent\'s Oxy app permissions' });
}

router.get('/:id/oxy-apps', authenticateToken, async (req: Request, res: Response) => {
  try {
    const owned = await ownedAgent(req, res);
    if (!owned) return;
    res.json({ apps: await listAgentOxyApps(owned.agent, owned.accessToken) });
  } catch (error: unknown) {
    answer(res, error);
  }
});

const levelSchema = z.object({ level: z.enum(OXY_APP_LEVELS) }).strict();

router.put('/:id/oxy-apps/:appId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const parsed = levelSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_level' });
    const owned = await ownedAgent(req, res);
    if (!owned) return;
    res.json({ app: await setAgentOxyAppLevel(owned.agent, owned.accessToken, String(req.params.appId), parsed.data.level) });
  } catch (error: unknown) {
    answer(res, error);
  }
});

export default router;
