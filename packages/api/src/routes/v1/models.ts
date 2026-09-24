/**
 * `GET /v1/models` — the catalogue in OpenAI's shape (ADR 0012).
 *
 * The same list as `GET /catalogue` (chat-usable models from Oxy's catalogue),
 * so a stock OpenAI SDK can list and pick a `publisher/model`. The richer
 * entry — capabilities, effort levels, prices, featured and default — is
 * `/catalogue`'s, linked from here.
 */

import { Router } from 'express';
import { log } from '../../lib/logger.js';
import { listChatModels } from '../../lib/models/catalogue.js';
import { toOpenAIModel } from '../../lib/models/wire.js';

const router = Router();

const CATALOGUE_PATH = '/catalogue';

function modelNotFound(requested: string) {
  return {
    error: {
      message: `The model '${requested}' does not exist.`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  };
}

router.get('/', async (_req, res) => {
  res.setHeader('Link', `<${CATALOGUE_PATH}>; rel="alternate"`);
  try {
    res.json({ object: 'list', data: (await listChatModels()).map(toOpenAIModel) });
  } catch (err: unknown) {
    log.v1.error({ err }, 'Model list unavailable');
    res.status(503).json({
      error: {
        message: 'The model catalogue is unavailable right now. Please try again.',
        type: 'server_error',
        param: null,
        code: 'catalogue_unavailable',
      },
    });
  }
});

// A model id is `publisher/model`: two path segments.
router.get('/:publisher/:model', async (req, res) => {
  const requested = `${req.params.publisher}/${req.params.model}`;
  try {
    const model = (await listChatModels()).find((entry) => entry.id === requested);
    if (model === undefined) return res.status(404).json(modelNotFound(requested));
    return res.json(toOpenAIModel(model));
  } catch (err: unknown) {
    log.v1.error({ err }, 'Model lookup unavailable');
    return res.status(503).json({
      error: { message: 'The model catalogue is unavailable right now.', type: 'server_error', param: null, code: 'catalogue_unavailable' },
    });
  }
});

router.get('/:modelId', (req, res) => {
  res.status(404).json(modelNotFound(req.params.modelId));
});

export default router;
