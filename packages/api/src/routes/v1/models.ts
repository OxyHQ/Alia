/**
 * `GET /v1/models` — the compatibility listing, now empty (#139 workstream 4).
 *
 * ## Why it lists nothing
 *
 * Kaana's thirteen canonical identifiers are routing profiles, not concrete
 * model references. ADR 0003 invariant 1 forbids serializing a profile as a model, and
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
 * Requests name canonical `kaana-*` profiles through the product catalogue;
 * no alias compatibility or translation is retained here.
 */

import { Router } from 'express';
import { log } from '../../lib/logger.js';

const router = Router();

/** The surface that serves what this one used to claim to. */
const CATALOGUE_PATH = '/catalogue';

/**
 * GET /v1/models
 *
 * Empty by construction, not by filtering: there is no source to filter. The
 * `category` and `chat` query parameters are accepted and ignored rather than
 * rejected, because a client that still sends them is asking a question whose
 * answer is the same empty list either way.
 */
router.get('/', (_req, res) => {
  /**
   * Where the catalogue went, in a header a client can follow.
   *
   * An empty list is honest but it is also indistinguishable from an outage to
   * a developer poking the API, and the OpenAI envelope has no field to explain
   * itself in. RFC 8288 `Link` is the mechanism that does, and `alternate` is
   * the accurate relation: `/catalogue` is another listing of the same subject,
   * serving it truthfully.
   *
   * Deliberately NOT `Deprecation`. That header announces the deprecation of
   * THIS ENDPOINT, which is not the decision that was taken — `/v1/*` has its
   * own clock under `docs/migration/compatibility-window.md` section (b), owned
   * by workstream 6. Announcing someone else's sunset from here would set a date
   * this change has no standing to set. The endpoint is not deprecated; it is
   * empty, and those are different claims.
   *
   */
  res.setHeader('Link', `<${CATALOGUE_PATH}>; rel="alternate"`);
  res.json({ object: 'list', data: [] });
});

/**
 * GET /v1/models/:modelId
 *
 * This OpenAI-shaped endpoint publishes no model records, so every individual
 * model lookup returns the same ordinary 404. Routing profiles are listed by
 * `GET /catalogue` instead.
 */
router.get('/:modelId', (req, res) => {
  const requested = req.params.modelId;
  log.v1.info({ model: requested }, 'Unknown model introspection request');
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
