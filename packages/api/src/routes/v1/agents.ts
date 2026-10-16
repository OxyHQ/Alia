/**
 * What an embedding app reads about an agent before it opens it
 * (`docs/agent-embedding.md` §1 and §5), under the person's own session.
 *
 * Both routes answer 404 for every agent the person may not use — missing,
 * private, or not confirmable because Oxy could not be asked — exactly as
 * `GET /agents/thread/:username` does: an id is guessable, so any other answer
 * would tell a stranger a private agent exists.
 */

import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getDb } from '../../db/index.js';
import { GATED_FEATURES } from '../../domain/agent-features.js';
import { loadTurnAgent } from '../../lib/agent-account.js';
import type { HydratedAgent } from '../../lib/agent-identity.js';
import { FeatureCheckUnavailableError, readAgentFeatures } from '../../lib/agent-features.js';
import { log } from '../../lib/logger.js';

const router = Router();

async function reachableAgent(req: Request): Promise<HydratedAgent | null> {
  if (!req.user?.id) return null;
  const turnAgent = await loadTurnAgent(getDb(), {
    agentId: String(req.params.id),
    oxyUserId: req.user.id,
    accessToken: req.accessToken,
  });
  return turnAgent.kind === 'agent' ? turnAgent.agent : null;
}

const notFound = (res: Response) => res.status(404).json({ error: 'Agent not found' });

/**
 * The lead participant's identity, for the empty chat and the header: who it
 * is, how it looks, what it says first and offers to send. `greeting` is the
 * agent's tagline — its one line, written by its owner. The system prompt is
 * never here.
 */
router.get('/:id/profile', async (req: Request, res: Response) => {
  try {
    const agent = await reachableAgent(req);
    if (agent === null) return notFound(res);
    res.json({
      id: agent.id,
      name: agent.name,
      handle: agent.handle,
      character: agent.character,
      color: agent.color,
      description: agent.description,
      greeting: agent.tagline,
      starters: agent.starters,
      access: agent.access,
      features: GATED_FEATURES.map((key) => ({
        key,
        gated: agent.featureGates[key] !== undefined,
      })),
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error reading an agent profile');
    res.status(500).json({ error: 'Failed to read the agent' });
  }
});

/**
 * Whether this person may use each gated feature with this agent right now,
 * asked of the app behind each gate (`lib/agent-features.ts`). 503 when an app
 * could not answer: neither "available" nor "locked" would be true.
 */
router.get('/:id/features', async (req: Request, res: Response) => {
  try {
    const agent = await reachableAgent(req);
    if (agent === null || !req.user?.id) return notFound(res);
    const features = await readAgentFeatures(agent, {
      accountId: req.user.id,
      // The person's own bearer only: a service token acting for them is not them,
      // and no lane is authorized without the person (`lib/agent-features.ts`).
      accessToken: req.serviceApp ? undefined : req.accessToken,
      runId: randomUUID(),
    });
    res.json({ features });
  } catch (error: unknown) {
    if (error instanceof FeatureCheckUnavailableError) {
      return res.status(503).json({
        error: {
          code: 'feature_check_unavailable',
          feature: error.feature,
          retryable: true,
          message: 'The app behind this feature could not answer. Try again.',
        },
      });
    }
    log.agents.error({ err: error }, 'Error reading agent features');
    res.status(500).json({ error: 'Failed to read the agent features' });
  }
});

export default router;
