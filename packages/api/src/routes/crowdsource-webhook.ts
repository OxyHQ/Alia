import { Router, type NextFunction, type Request, type Response } from 'express';
import { crowdsourceWebhooks } from '@oxyhq/crowdsource-express';
import { crowdSourceConfig } from '../lib/crowdsource/config.js';
import {
  recordDecisionEvent,
  recordIgnoredEvent,
} from '../lib/crowdsource/inbound-service.js';
import { processedEventStore } from '../lib/crowdsource/event-store.js';
import { log } from '../lib/logger.js';
import { recordMetric } from '../lib/observability/index.js';

/**
 * `POST /webhooks/crowdsource` — where decisions come back.
 *
 * ## The mount is part of the correctness
 *
 * This router MUST be mounted before `express.json()` in `index.ts`. The signature
 * covers `timestamp + "." + rawBody` — the bytes that arrived — and once a JSON
 * parser has run, those bytes are gone.
 *
 * Alia's parser happens to keep a Buffer copy on `req.rawBody`, which
 * `@oxyhq/crowdsource-express` would accept, so mounting late would appear to work
 * — and that is exactly why the guard below exists rather than a comment. The
 * `verify` hook that populates `req.rawBody` is there for the provider HMAC and
 * belongs to another feature entirely; the day somebody removes or narrows it,
 * webhook verification would start signing over a re-serialisation with nothing
 * failing. Reading the stream ourselves depends on nothing.
 *
 * ## What this handler does and does not do
 *
 * It records and returns. §10.8 asks a receiver to answer 2xx quickly and queue
 * the processing, and the reason is not latency: applying a decision means reading
 * catalog rows, planning enforcement and writing several collections, and a
 * receiver that did all that inline would time out under a burst and be retried
 * while the first attempt was still running. So the event and a durable
 * `decision.apply` outbox row commit in ONE transaction, and the dispatcher does
 * the work.
 *
 * Nothing here is authenticated by Oxy. The HMAC IS the authentication (§10.8),
 * and an Oxy session must never satisfy this route — it is not a user endpoint.
 */

/**
 * Refuses to run if a body parser got here first.
 *
 * The invariant this protects is a MOUNT ORDER, which no type can express and no
 * unit test of this file alone would notice. Answering 500 rather than falling
 * back is the point: a receiver that verified a signature over bytes it
 * reconstructed would be worse than one that plainly refuses, because it would
 * keep accepting deliveries and nobody would ever look.
 */
export function assertRawBody(req: Request, res: Response, next: NextFunction): void {
  if (typeof req.body !== 'undefined') {
    log.general.error(
      { bodyType: typeof req.body },
      '[CrowdSource] webhook route is mounted AFTER a body parser; refusing to verify',
    );
    res.status(500).json({
      error: 'The CrowdSource webhook route is misconfigured on this deployment.',
    });
    return;
  }
  next();
}

/**
 * One string field out of an event payload this version does not know.
 *
 * `WebhookEventEnvelope.data` is deliberately OPAQUE in the contract: an
 * unrecognised event's payload is whatever a newer CrowdSource decided to send,
 * and property access on it does not compile. That is the contract being honest
 * rather than an obstacle, so this reads the key defensively instead of asserting
 * a shape nobody has verified. Anything that is not a string is treated as absent,
 * which is the only safe reading of a field this deployment has never seen.
 */
function stringField(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' ? value : undefined;
}

export function createCrowdSourceWebhookRoutes(): Router {
  const router = Router();

  const secret = crowdSourceConfig().webhookSecret;
  if (!secret) {
    /**
     * Not mounted, rather than mounted and permissive.
     *
     * A route that answers anything at all without a secret is a route that will
     * one day be reasoned about as if it verified something. An unconfigured
     * deployment 404s here, which is indistinguishable from not having the feature
     * — which is exactly what it is.
     */
    log.general.info('[CrowdSource] webhook route not mounted: no CROWDSOURCE_WEBHOOK_SECRET');
    return router;
  }

  const previousSecret = crowdSourceConfig().webhookPreviousSecret;

  router.post(
    '/crowdsource',
    assertRawBody,
    crowdsourceWebhooks({
      secret,
      ...(previousSecret === undefined ? {} : { previousSecret }),
      // Shared across ECS tasks: the in-process default would dedupe only the
      // instance that happened to receive both copies of a redelivery.
      store: processedEventStore(),
      on: {
        /**
         * A decision, provisional or final. Both are queued: a provisional
         * decision is real (§9.6) and Alia records it; what it may ACT on is
         * decided by the enforcement mode, not by discarding the event here.
         */
        'case.decided': async (event) => {
          await recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
        /**
         * A later revision replacing an earlier one (§10.6). The SAME path: the
         * decision worker compares revisions and the enforcement service reverses
         * what the superseded revision did. A correction is not a special case
         * with its own code — it is an ordinary decision that supersedes another,
         * and giving it a separate path is how a restore ends up not being
         * idempotent.
         */
        'decision.corrected': async (event) => {
          await recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
        /**
         * An appeal's outcome carries a decision too, and it is the current answer
         * for the case, so it takes the same path.
         */
        'appeal.decided': async (event) => {
          await recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
      },
      /**
       * Every other event type — including one this version of the contracts
       * package has never heard of (§10.11).
       *
       * Recorded rather than dropped. `case.created`, `case.escalated` and
       * `case.closed` carry no decision and nothing to enforce, but "did
       * CrowdSource tell us about this case, and when" is the first question asked
       * when a report appears stuck, and the answer has to exist somewhere.
       */
      onUnhandled: async (event) => {
        await recordIgnoredEvent({
          eventId: event.id,
          type: event.type,
          caseId: stringField(event.data, 'caseId'),
        });
      },
      /**
       * A refusal reason and nothing else — never a body, a header or a signature
       * (§10.8's last line). It is a bounded label, so it can be a metric.
       */
      onRejected: (rejection) => {
        recordMetric({
          name: 'crowdsource_webhook_rejected_total',
          value: 1,
          labels: { rejection },
        });
        log.general.warn({ rejection }, '[CrowdSource] webhook delivery refused');
      },
    }),
  );

  return router;
}
