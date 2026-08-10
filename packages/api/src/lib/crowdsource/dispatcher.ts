import type { ModerationOutboxEvent } from '../../db/moderation/outboxRepository.js';
import { crowdSourceConfig } from './config.js';
import { applyDecisionOutboxEvent } from './decision-worker.js';
import { deliverReportOutboxEvent } from './delivery-worker.js';
import { dispatchModerationOutbox } from './outbox.js';
import { log } from '../logger.js';

/**
 * The loop that drains the moderation outbox.
 *
 * A bounded interval, one batch in flight at a time, and an abort signal that
 * stops claiming new work but lets the event already being handled reach a durable
 * state.
 *
 * It is NOT leader-gated, and that is a property of the claim rather than an
 * oversight. Every event is taken under a lease with an owner check, so N tasks
 * draining the same collection simply share the work — and a task dying
 * mid-delivery has its lease expire and its event reclaimed, which a single leader
 * would not give us.
 *
 * `CROWDSOURCE_ENABLED` gates the LOOP, never the durable record. Reports taken
 * while the integration is off keep their outbox rows and deliver when it is
 * switched on; running the loop instead would count attempts against a deployment
 * that has nowhere to send anything and dead-letter the backlog it was supposed to
 * preserve.
 */

/** Route an event to the worker that owns its kind. */
export async function handleModerationOutboxEvent(
  event: ModerationOutboxEvent,
): Promise<void> {
  switch (event.kind) {
    case 'report.submit':
      await deliverReportOutboxEvent(event);
      return;
    case 'decision.apply':
      await applyDecisionOutboxEvent(event);
      return;
  }
}

export class ModerationOutboxDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private running = false;

  /**
   * Begin draining.
   *
   * **There is no topology precondition any more, and its removal was mandatory
   * rather than tidying.** Under Mongo this gated on `assertTransactionalTopology()`,
   * because a standalone `mongod` accepted every other write Alia made and failed
   * only where a report and its outbox event had to commit together. Postgres has
   * no such mode: transactions are not a deployment option.
   *
   * Leaving the check in place across the port would have been the quiet failure
   * it was written to prevent. It read `mongoose.connection.db`, which is absent
   * now, so it would have answered "cannot run transactions" on every boot — the
   * dispatcher would never have started, reports would have queued in Postgres,
   * and the only sign would have been one error line naming a database this
   * service no longer uses.
   *
   * `CROWDSOURCE_ENABLED` still gates the LOOP and never the durable record.
   */
  start(): void {
    if (this.running) return;
    const config = crowdSourceConfig();
    if (!config.enabled) {
      log.general.info('[CrowdSource] outbox dispatcher not started: integration disabled');
      return;
    }
    this.beginTicking();
  }

  private beginTicking(): void {
    const config = crowdSourceConfig();
    this.running = true;
    this.abortController = new AbortController();
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, config.outboxPollIntervalMs);
    this.timer.unref?.();
    log.general.info(
      {
        intervalMs: config.outboxPollIntervalMs,
        batchSize: config.outboxBatchSize,
        enforcementMode: config.enforcementMode,
      },
      '[CrowdSource] outbox dispatcher started',
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    const controller = this.abortController;
    controller?.abort();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    if (this.abortController === controller) {
      this.abortController = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.inFlight) return this.inFlight;
    const work = dispatchModerationOutbox({
      handler: handleModerationOutboxEvent,
      batchSize: crowdSourceConfig().outboxBatchSize,
      signal: this.abortController?.signal,
    })
      .then(({ processed, failed, deadLettered }) => {
        if (processed > 0 || failed > 0) {
          log.general.info(
            { processed, failed, deadLettered },
            '[CrowdSource] outbox batch complete',
          );
        }
      })
      .catch((error: unknown) => {
        // Claim/database failures happen outside the per-event retry block. Keep
        // the interval alive and avoid an unhandled rejection.
        log.general.error(
          { error: error instanceof Error ? error.message : String(error) },
          '[CrowdSource] outbox tick failed',
        );
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
    return work;
  }
}

export const moderationOutboxDispatcher = new ModerationOutboxDispatcher();
