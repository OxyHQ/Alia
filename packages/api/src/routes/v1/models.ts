import { Router } from 'express';
import { log } from '../../lib/logger.js';
import {
  getAliaModel,
  getDefaultModelForCategory,
  getAvailableModels,
  type ModelCategory,
  type AliaModelWithAvailability,
} from '../../lib/chat-core.js';
import { isAliasVisible } from '../../lib/product-modes.js';

const router = Router();

function getRequiredPlan(creditMultiplier: number): string | null {
  if (creditMultiplier <= 1.0) return null;
  if (creditMultiplier <= 2.0) return 'Go';
  return 'Pro';
}

/**
 * Who owns what these identifiers name — which is not Alia (#139 workstream 4,
 * ADR 0002, ADR 0003).
 *
 * This field said `alia` for all thirteen, and every one of them routes to a
 * third-party model: `docs/migration/alias-migration-map.json` measured the
 * fan-out and classified all thirteen as routing profiles, none as a concrete
 * model reference. So `owned_by: 'alia'` asserted ownership of weights Alia
 * does not have, which ADR 0002 names as the mistake that made the `alia/*`
 * publisher namespace worth reserving.
 *
 * The publisher would be the true value, and it is not available: the routing
 * table stores a bare provider model id with no publisher segment, so
 * attribution is not recoverable from this repository's data at all — the
 * finding the migration map records rather than works around.
 *
 * Naming the PROVIDER instead would be wrong on the merits, because ADR 0003
 * makes the provider a property of the deployment and not of the model, so it
 * is not an answer to "who owns this" in the first place.
 *
 * Note what is deliberately NOT the reason. `lib/errors/sanitize.ts` rule 2 —
 * route concealment — explicitly does NOT apply to the model catalogue, since
 * *"a caller choosing a model has to know whose model it is"*. Concealment is
 * therefore not what withholds attribution here; the absence of the data is.
 * The day Relay's catalogue supplies a publisher, this field carries it, and no
 * rule has to be relaxed for that to happen.
 *
 * `undisclosed` is what is left once both false answers are removed, and it is
 * the accurate one: a caller is told that ownership is not being claimed here
 * rather than being told the wrong owner. Attribution arrives with Relay's
 * catalogue, which is where model identity moves.
 *
 * `object: 'model'` is deliberately NOT changed alongside it. That value is the
 * one external callers switch on, `docs/migration/compatibility-window.md`
 * section (a) keeps this response shape working through the window, and the
 * truthful type split is served by `GET /catalogue` on a surface with no
 * compatibility promise. Gate 5 records the remaining violation exactly, and it
 * retires with the window rather than by a quiet edit here.
 */
const OWNED_BY = 'undisclosed';

function serializeModel(model: AliaModelWithAvailability, isDefault = false) {
  return {
    id: model.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: OWNED_BY,
    name: model.name,
    description: model.description,
    category: model.category,
    emoji: model.emoji,
    is_default: isDefault,
    is_available: model.isAvailable,
    is_legacy: model.isLegacy,
    required_plan: getRequiredPlan(model.creditMultiplier),
    capabilities: {
      tools: model.supportsTools,
      vision: model.supportsVision,
      max_tokens: model.maxTokens,
    },
    pricing: {
      credit_multiplier: model.creditMultiplier,
    },
  };
}

/**
 * GET /v1/models
 * List available Alia models with live availability status
 *
 * Query params:
 * - category: Filter by category ('general' | 'coding' | 'vision' | 'audio' | 'multimodal' | 'voice')
 * - chat: If 'true', return only the entries the product offers in a picker.
 *   That decision lives in `lib/product-modes.ts` (`VISIBLE_PROFILES`), keyed by
 *   routing profile, and it used to be a `chatVisible` field inside the provider
 *   mapping table. Same five identifiers either way.
 */
router.get('/', async (req, res) => {
  try {
    const category = req.query.category as ModelCategory | undefined;
    const chat = req.query.chat === 'true';

    // Get all models with availability status
    const allModelsWithAvailability = await getAvailableModels();

    let aliaModels = allModelsWithAvailability;
    if (chat) {
      aliaModels = aliaModels.filter(m => isAliasVisible(m.id));
    } else if (category) {
      aliaModels = aliaModels.filter(m => m.category === category);
    }

    const defaultModel = category ? await getDefaultModelForCategory(category) : null;

    const data = aliaModels.map(model =>
      serializeModel(model, model.id === defaultModel?.id)
    );

    // Sort: default first, then by credit multiplier
    data.sort((a, b) => {
      if (a.is_default && !b.is_default) return -1;
      if (!a.is_default && b.is_default) return 1;
      return a.pricing.credit_multiplier - b.pricing.credit_multiplier;
    });

    res.json({
      object: 'list',
      data,
      ...(category && { category }),
      ...(defaultModel && { default_model: defaultModel.id }),
    });
  } catch (e: unknown) {
    log.v1.error({ err: e }, 'Error');
    res.status(500).json({
      error: {
        message: 'An internal error occurred while listing models.',
        type: 'server_error',
        param: null,
        code: null,
      }
    });
  }
});

/**
 * GET /v1/models/:modelId
 * Get a specific Alia model
 */
router.get('/:modelId', async (req, res) => {
  try {
    const model = await getAliaModel(req.params.modelId);

    if (!model) {
      res.status(404).json({
        error: {
          message: `The model '${req.params.modelId}' does not exist.`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found',
        }
      });
      return;
    }

    res.json(serializeModel({ ...model, isAvailable: true, isLegacy: false }));
  } catch (e: unknown) {
    log.v1.error({ err: e }, 'Error');
    res.status(500).json({
      error: {
        message: 'An internal error occurred while retrieving the model.',
        type: 'server_error',
        param: null,
        code: null,
      }
    });
  }
});

export default router;
