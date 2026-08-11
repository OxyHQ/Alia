import { Router, Request, Response } from 'express';
import {
  findExternalModel,
  listExternalModels,
  listExternalOrganizations,
} from '../db/providers/externalModelRepository.js';
import { getDb } from '../db/index.js';
import { log } from '../lib/logger.js';

const router = Router();

/**
 * GET /external-models
 * List all external models with optional filtering
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { organization, multimodal, has_benchmarks, sort } = req.query;

    const sortKey =
      sort === 'gpqa' || sort === 'swe' || sort === 'mmmlu' || sort === 'release' || sort === 'price'
        ? sort
        : 'default';

    const models = await listExternalModels(getDb(), {
      organizationId: typeof organization === 'string' ? organization : undefined,
      multimodal: multimodal === 'true' ? true : undefined,
      hasBenchmarks: has_benchmarks === 'true' ? true : undefined,
      sort: sortKey,
    });

    res.json({
      models,
      count: models.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error');
    res.status(500).json({ error: 'Failed to fetch external models' });
  }
});

/**
 * GET /external-models/organizations
 * List all organizations
 */
router.get('/organizations', async (_req: Request, res: Response) => {
  try {
    const orgs = await listExternalOrganizations(getDb());

    res.json({ organizations: orgs });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error');
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

/**
 * GET /external-models/:modelId
 * Get a specific external model
 */
router.get('/:modelId', async (req: Request, res: Response) => {
  try {
    const model = await findExternalModel(getDb(), String(req.params.modelId));
    if (!model) {
      return res.status(404).json({ error: 'Model not found' });
    }
    res.json({ model });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error');
    res.status(500).json({ error: 'Failed to fetch model' });
  }
});

export default router;
