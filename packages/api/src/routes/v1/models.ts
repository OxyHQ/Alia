/**
 * `GET /v1/models` — the compatibility listing, now empty (#139 workstream 4).
 *
 * ## Why it lists nothing
 *
 * It listed thirteen `alia-*` identifiers as `object: 'model'`, and every one of
 * them is a routing profile: `docs/migration/alias-migration-map.json` measured
 * the fan-out and classified all thirteen as profiles, none as a concrete model
 * reference. ADR 0003 invariant 1 forbids serializing a profile as a model, and
 * the honest content of an OpenAI-shaped model list, for a product that owns no
 * models, is nothing.
 *
 * So this is not "the endpoint was emptied". It is the endpoint telling the
 * truth for the first time: **Alia publishes no models.** The `alia/*` publisher
 * namespace is reserved and empty (ADR 0002, `lib/reserved-namespace.ts`), and
 * until a real artifact with an immutable revision and a model card exists there
 * is nothing for this route to name.
 *
 * What replaced it is `GET /catalogue`, which serves routing profiles AS routing
 * profiles, and `GET /catalogue/modes`, which serves the product modes a person
 * actually picks between. Neither is `/v1`, because ADR 0004 freezes this
 * surface at the routes it already has.
 *
 * ## What a caller sees change
 *
 * `GET /v1/models` answers `{"object":"list","data":[]}` with 200. The shape is
 * unchanged, so a client that parses the envelope keeps parsing it; a client
 * that populated a picker from it now shows nothing and should read
 * `GET /catalogue` instead.
 *
 * **Requests are unaffected.** The thirteen aliases still resolve — this route
 * stopped ADVERTISING them, and `internal/providers/lib/alia-models.ts` is
 * untouched — so every already-installed `@alia.onl/sdk` and `@alia-codea/cli`
 * copy keeps working against a surface that no longer lists what it sends.
 * `docs/migration/compatibility-window.md` records that closure, its date, and
 * the evidence behind it.
 *
 * `GET /v1/models/:modelId` is the one place that still answers about an alias,
 * because introspection is not the request path: naming one returns a typed
 * refusal that says what it became, which is more useful than the 404 an empty
 * catalogue would otherwise produce.
 */

import { Router } from 'express';
import { log } from '../../lib/logger.js';
import { profileIdFor } from '../../lib/product-modes.js';

const router = Router();

/**
 * GET /v1/models
 *
 * Empty by construction, not by filtering: there is no source to filter. The
 * `category` and `chat` query parameters are accepted and ignored rather than
 * rejected, because a client that still sends them is asking a question whose
 * answer is the same empty list either way.
 */
router.get('/', (_req, res) => {
  res.json({ object: 'list', data: [] });
});

/**
 * GET /v1/models/:modelId
 *
 * A legacy alias gets a refusal naming the routing profile it became, read from
 * the preset table — the same string `docs/migration/alias-migration-map.json`
 * publishes and `GET /catalogue` serves as `id`. Anything else gets the 404 it
 * always got.
 *
 * A bare 404 for an identifier that worked last week is indistinguishable from a
 * typo or an outage; this is the pattern the removed `/v1/resolve-model` and the
 * `alia_sk_*` credential paths already use, applied to introspection.
 */
router.get('/:modelId', (req, res) => {
  const requested = req.params.modelId;
  const becomes = profileIdFor(requested);

  if (becomes !== null) {
    log.v1.info({ model: requested, becomes }, 'Introspection of a retired alias');
    res.status(410).json({
      error: {
        message:
          `The model '${requested}' is no longer published. It was a routing profile, ` +
          `not a model, and it is now '${becomes}'. List the catalogue at GET /catalogue.`,
        type: 'invalid_request_error',
        param: 'model',
        code: 'model_retired',
      },
    });
    return;
  }

  res.status(404).json({
    error: {
      message: `The model '${requested}' does not exist.`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  });
});

export default router;
