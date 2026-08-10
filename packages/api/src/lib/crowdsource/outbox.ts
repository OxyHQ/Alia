import { randomUUID } from 'crypto';
import {
  claimModerationOutboxEvent,
  completeModerationOutboxEvent,
  failModerationOutboxEvent,
  renewModerationOutboxEvent,
  type ModerationOutboxEvent,
} from '../../db/moderation/outboxRepository.js';
import { log } from '../logger.js';

/**
 * Draining the moderation outbox: claiming, completing and failing events.
 *
 * The ROWS belong to `db/moderation/outboxRepository.ts`; what is left here is
 * the loop and the two policies that are not the database's business — how long
 * to keep retrying, and when a failure means the payload will never work.
 *
 * At-least-once: handlers MUST make every downstream effect idempotent using the
 * event id, because an expired lease is reclaimable and a worker can die
 * mid-delivery.
 *
 * What is unusual here is where retrying STOPS. A delivery failure the SDK marks
 * as not retryable is a defect in the payload, not a blip — see
 * {@link isRetryableDeliveryError}.
 */

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 500;
const MIN_LEASE_RENEW_INTERVAL_MS = 250;

/**
 * Attempts after which a retryable failure is treated as permanent.
 *
 * Generous: a retryable failure means CrowdSource might still accept this exact
 * payload, and with the repository's six-hour backoff ceiling this is several
 * days of trying. A report that has not landed by then needs a human, not another
 * attempt.
 */
const MAX_RETRYABLE_ATTEMPTS = 25;

/**
 * A failure that says whether trying the same payload again could ever work.
 *
 * Every error `@oxyhq/crowdsource` throws carries `retryable`, which is the only
 * thing a delivery worker needs from it. Anything else — a bug in this code, a
 * database error — is treated as retryable, because assuming a defect is
 * permanent is how a recoverable outage becomes lost moderation work.
 */
export function isRetryableDeliveryError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'retryable' in error) {
    const retryable: unknown = (error as { retryable: unknown }).retryable;
    if (typeof retryable === 'boolean') return retryable;
  }
  return true;
}

export type ModerationOutboxHandler = (event: ModerationOutboxEvent) => Promise<void>;

interface LeaseHeartbeatResult {
  lost: boolean;
  error?: unknown;
}

function startLeaseHeartbeat(options: {
  eventId: string;
  leaseOwner: string;
  leaseMs: number;
}): { stop: () => Promise<LeaseHeartbeatResult> } {
  const renewIntervalMs = Math.max(
    MIN_LEASE_RENEW_INTERVAL_MS,
    Math.floor(options.leaseMs / 3),
  );
  let stopped = false;
  let lost = false;
  let renewalError: unknown;
  let renewalInFlight: Promise<void> | null = null;

  const renew = (): void => {
    if (stopped || lost || renewalInFlight) return;
    const renewal = renewModerationOutboxEvent(
      options.eventId,
      options.leaseOwner,
      options.leaseMs,
    )
      .then((stillOwner) => {
        if (!stillOwner) lost = true;
      })
      .catch((error: unknown) => {
        lost = true;
        renewalError = error;
      })
      .finally(() => {
        if (renewalInFlight === renewal) renewalInFlight = null;
      });
    renewalInFlight = renewal;
  };

  const timer = setInterval(renew, renewIntervalMs);
  timer.unref?.();

  return {
    async stop(): Promise<LeaseHeartbeatResult> {
      stopped = true;
      clearInterval(timer);
      await renewalInFlight;
      return { lost, error: renewalError };
    },
  };
}

export interface ModerationDispatchResult {
  processed: number;
  failed: number;
  deadLettered: number;
}

/** Drain up to `batchSize` due events. Bounded, at-least-once, lease-protected. */
export async function dispatchModerationOutbox(options: {
  handler: ModerationOutboxHandler;
  leaseOwner?: string;
  batchSize?: number;
  leaseMs?: number;
  signal?: AbortSignal;
}): Promise<ModerationDispatchResult> {
  const leaseOwner = options.leaseOwner ?? `moderation:${process.pid}:${randomUUID()}`;
  const batchSize = Math.min(
    Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE),
    MAX_BATCH_SIZE,
  );
  const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  let processed = 0;
  let failed = 0;
  let deadLettered = 0;

  for (let index = 0; index < batchSize; index += 1) {
    // Shutdown stops claiming new work but lets the event already in flight reach
    // a durable state.
    if (options.signal?.aborted) break;

    const event = await claimModerationOutboxEvent({ leaseOwner, leaseMs });
    if (!event) break;

    const heartbeat = startLeaseHeartbeat({ eventId: event.id, leaseOwner, leaseMs });
    let deliveryError: unknown;
    try {
      await options.handler(event);
    } catch (error: unknown) {
      deliveryError = error;
    }

    // No completion/failure transition may race an owner-checked renewal.
    const heartbeatResult = await heartbeat.stop();
    if (heartbeatResult.lost) {
      failed += 1;
      log.general.warn(
        {
          eventId: event.id,
          kind: event.kind,
          attempts: event.attempts,
          error:
            heartbeatResult.error instanceof Error
              ? heartbeatResult.error.message
              : heartbeatResult.error
                ? String(heartbeatResult.error)
                : 'owner or lease expiry changed',
        },
        '[CrowdSource] outbox event lease lost during delivery',
      );
      continue;
    }

    if (deliveryError) {
      failed += 1;
      const message =
        deliveryError instanceof Error ? deliveryError.message : String(deliveryError);
      const terminal =
        !isRetryableDeliveryError(deliveryError) || event.attempts >= MAX_RETRYABLE_ATTEMPTS;
      const outcome = await failModerationOutboxEvent(event, leaseOwner, message, terminal);
      const context = {
        eventId: event.id,
        kind: event.kind,
        attempts: event.attempts,
        error: message,
      };
      // A dead letter is moderation work that will not happen without a human, so
      // it must not be discoverable only by reading a warn-level log line.
      if (outcome.deadLettered) {
        deadLettered += 1;
        log.general.error(context, '[CrowdSource] outbox event dead-lettered');
      } else {
        log.general.warn(context, '[CrowdSource] outbox event delivery failed, will retry');
      }
      if (!outcome.released) {
        log.general.warn(
          { eventId: event.id, kind: event.kind },
          '[CrowdSource] lease lost before failure release',
        );
      }
      continue;
    }

    const completed = await completeModerationOutboxEvent(event.id, leaseOwner);
    if (!completed) {
      failed += 1;
      log.general.warn(
        { eventId: event.id, kind: event.kind, attempts: event.attempts },
        '[CrowdSource] lease lost before completion',
      );
      continue;
    }
    processed += 1;
  }

  return { processed, failed, deadLettered };
}
