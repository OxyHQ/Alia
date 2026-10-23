/**
 * `GET /agents/:id/primary-tool-options` — the app tools the agent editor may
 * make active from an agent's first step (`domain/agent-primary-tools.ts`):
 * those of every app the agent reaches, on its owner's grants or on the
 * ceiling for whoever uses it. The list itself is saved with
 * `PATCH /agents/:id` (`primaryTools`), which checks it against the same
 * catalogues.
 *
 * For whoever operates the agent — the same `account:act_as` the save needs.
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from '../../db/index.js';
import { MAX_AGENT_PRIMARY_TOOLS } from '../../domain/agent-primary-tools.js';
import { loadAgentForActor, refusalMessage, refusalStatus } from '../../lib/agent-account.js';
import { listPrimaryToolOptions } from '../../lib/agent-primary-tools.js';
import { log } from '../../lib/logger.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = Router();

router.get('/:id/primary-tool-options', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id || !req.accessToken) return res.status(401).json({ error: 'Unauthorized' });
    const loaded = await loadAgentForActor(getDb(), {
      agentId: String(req.params.id),
      oxyUserId: req.user.id,
      accessToken: req.accessToken,
      cache: true,
    });
    if (!loaded.ok) {
      return res
        .status(loaded.refusal === 'agent_not_found' ? 404 : refusalStatus(loaded.refusal))
        .json({
          error:
            loaded.refusal === 'agent_not_found'
              ? 'Agent not found'
              : refusalMessage(loaded.refusal),
        });
    }
    let apps: Awaited<ReturnType<typeof listPrimaryToolOptions>>;
    try {
      apps = await listPrimaryToolOptions();
    } catch (error: unknown) {
      log.agents.warn({ err: error }, 'Could not read what the agent reaches for its tool options');
      return res.status(503).json({ error: 'The app catalogues could not be read. Try again.' });
    }
    res.json({
      primaryTools: loaded.agent.primaryTools,
      max: MAX_AGENT_PRIMARY_TOOLS,
      apps,
    });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error reading the primary tool options');
    res.status(500).json({ error: 'Failed to read the primary tool options' });
  }
});

export default router;
