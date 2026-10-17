/**
 * `GET /agents/:id/feature-gate-options` — what the agent editor may put each
 * of Alia's gateable features behind (ADR 0020 §6): the live catalogues' app
 * features that a gate can name. The gates themselves are saved with
 * `PATCH /agents/:id` (`featureGates`), which checks them against the same
 * catalogues.
 *
 * For whoever operates the agent — the same `account:act_as` the save needs.
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from '../../db/index.js';
import { GATED_FEATURES } from '../../domain/agent-features.js';
import { loadAgentForActor, refusalMessage, refusalStatus } from '../../lib/agent-account.js';
import { listGateableAppFeatures } from '../../lib/agent-features.js';
import { log } from '../../lib/logger.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = Router();

router.get('/:id/feature-gate-options', authenticateToken, async (req: Request, res: Response) => {
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
    let apps: Awaited<ReturnType<typeof listGateableAppFeatures>>;
    try {
      apps = await listGateableAppFeatures();
    } catch (error: unknown) {
      log.agents.warn({ err: error }, 'Could not read the catalogues for the gate options');
      return res.status(503).json({ error: 'The app catalogues could not be read. Try again.' });
    }
    res.json({ features: GATED_FEATURES, gates: loaded.agent.featureGates, apps });
  } catch (error: unknown) {
    log.agents.error({ err: error }, 'Error reading the feature gate options');
    res.status(500).json({ error: 'Failed to read the feature gate options' });
  }
});

export default router;
