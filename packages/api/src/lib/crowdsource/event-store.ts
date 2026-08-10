import type { ProcessedEventStore } from '@oxyhq/crowdsource-express';
import {
  claimModerationEvent,
  releaseModerationEvent,
} from '../../db/moderation/moderationEventRepository.js';

/**
 * The webhook dedupe store, in Postgres.
 *
 * `@oxyhq/crowdsource-express` defaults to an in-process store and says exactly
 * when that is not enough: two instances behind a load balancer each keep their
 * own, so a redelivery landing on the other instance is not deduplicated. Alia
 * runs several ECS tasks behind one ALB, so this is that case.
 *
 * The claim/release contract is the store's, and it is the right one. A row
 * inserted BEFORE the handler runs means a concurrent redelivery cannot also run
 * it; deleting that row when the handler THROWS means §10.9's retry schedule can
 * still deliver the event later. Recording the id only after success would let two
 * copies run at once; recording it before and never releasing would make a
 * transient failure permanent and lose a decision silently.
 *
 * The claim itself is an `ON CONFLICT DO NOTHING … RETURNING` in the repository,
 * NOT a caught duplicate-key error. Under Mongo, catching code 11000 was the
 * idiomatic spelling; on Postgres it would be wrong twice over — a failed
 * statement aborts the surrounding transaction, and an exception cannot
 * distinguish a duplicate from a dropped connection. Reading the empty result set
 * as the answer keeps a real failure propagating, so the middleware answers
 * non-2xx and the event stays on the sender's retry schedule instead of being
 * retired as "already processed".
 */
export function processedEventStore(): ProcessedEventStore {
  return {
    /** True when this call took the claim. */
    claim: (eventId: string): Promise<boolean> => claimModerationEvent(eventId),
    /** Give the claim back so a redelivery can be processed. */
    release: (eventId: string): Promise<void> => releaseModerationEvent(eventId),
  };
}
