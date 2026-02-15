import { Router, Request, Response } from 'express';
import { ExternalModel } from '../models/external-model.js';
import { log } from '../lib/logger.js';

const router = Router();

/**
 * GET /external-models
 * List all external models with optional filtering
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { organization, multimodal, has_benchmarks, sort } = req.query;

    const filter: Record<string, any> = {};
    if (organization) filter.organizationId = organization;
    if (multimodal === 'true') filter.multimodal = true;
    if (has_benchmarks === 'true') {
      filter.$or = [
        { 'benchmarks.gpqa': { $ne: null } },
        { 'benchmarks.sweBenchVerified': { $ne: null } },
        { 'benchmarks.mmmu': { $ne: null } },
        { 'benchmarks.mmmlu': { $ne: null } },
      ];
    }

    let sortOption: Record<string, 1 | -1> = { organizationId: 1, name: 1 };
    if (sort === 'gpqa') sortOption = { 'benchmarks.gpqa': -1 };
    else if (sort === 'swe') sortOption = { 'benchmarks.sweBenchVerified': -1 };
    else if (sort === 'mmmlu') sortOption = { 'benchmarks.mmmlu': -1 };
    else if (sort === 'release') sortOption = { releaseDate: -1 };
    else if (sort === 'price') sortOption = { inputPrice: 1 };

    const models = await ExternalModel.find(filter).sort(sortOption).lean();

    res.json({
      models,
      count: models.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
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
    const orgs = await ExternalModel.aggregate([
      {
        $group: {
          _id: '$organizationId',
          name: { $first: '$organization' },
          country: { $first: '$organizationCountry' },
          modelCount: { $sum: 1 },
        },
      },
      { $sort: { modelCount: -1 } },
    ]);

    res.json({ organizations: orgs });
  } catch (error) {
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
    const model = await ExternalModel.findOne({ modelId: req.params.modelId }).lean();
    if (!model) {
      return res.status(404).json({ error: 'Model not found' });
    }
    res.json({ model });
  } catch (error) {
    log.models.error({ err: error }, 'Error');
    res.status(500).json({ error: 'Failed to fetch model' });
  }
});

export default router;
