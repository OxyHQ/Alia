/** Postgres outbox worker: recoverable leases, persisted decisions and canonical reply identities. */
import { getDb } from '../../../db/index.js';
import {
  claimReactionEvents,
  renewReactionEventLease,
  finishReactionEvent,
  retryReactionEvent,
  expireConversationActivities,
  type ReactionEvent,
} from '../../../db/chat/reactionRepository.js';
import { log } from '../../logger.js';
import { runReactionEvent } from './runtime.js';
import type { ReactionOutcome } from './engine.js';
import { publishRoomEvent } from '../room/bus.js';

export interface ReactionDispatcherDeps {
  claim(): Promise<ReactionEvent[]>;
  renew(event: ReactionEvent): Promise<boolean>;
  process(event: ReactionEvent, leaseValid: () => boolean): Promise<ReactionOutcome>;
  finish(event: ReactionEvent, outcome: Exclude<ReactionOutcome, 'deferred'>): Promise<unknown>;
  retry(event: ReactionEvent, delayMs: number, deferred?: boolean): Promise<unknown>;
  failed(event: ReactionEvent): Promise<void>;
}

const dependencies = (): ReactionDispatcherDeps => ({
  claim: async () => {
    await expireConversationActivities(getDb());
    return claimReactionEvents(getDb(), { limit: 2, leaseMs: 60_000 });
  },
  renew: (event) =>
    event.leaseToken
      ? renewReactionEventLease(getDb(), event.id, event.leaseToken)
      : Promise.resolve(false),
  process: runReactionEvent,
  finish: (event, outcome) => finishReactionEvent(getDb(), event.id, event.leaseToken!, outcome),
  retry: (event, delay, deferred) =>
    retryReactionEvent(getDb(), event.id, event.leaseToken!, delay, { deferred }),
  failed: (event) =>
    publishRoomEvent({
      userId: event.userId,
      conversationId: event.conversationId,
      chainId: event.id,
      event: 'group.idle',
      data: { reason: 'error' },
    }),
});

export class ReactionDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  constructor(private readonly deps: ReactionDispatcherDeps = dependencies()) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 2_000);
    this.timer.unref?.();
    void this.tick();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const work = this.drain()
      .catch(() => {
        // Database/model exceptions can contain private values. Log only the operation.
        log.agents.warn('Reaction outbox dispatch failed; durable work remains pending');
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
    return work;
  }
  private async drain(): Promise<void> {
    const events = await this.deps.claim();
    const outcomes = await Promise.allSettled(events.map((event) => this.deliver(event)));
    if (outcomes.some((outcome) => outcome.status === 'rejected'))
      throw new Error('Reaction delivery could not be settled');
  }
  private async deliver(event: ReactionEvent): Promise<void> {
    let valid = true;
    let renewing: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = this.deps
        .renew(event)
        .then(
          (owned) => {
            valid &&= owned;
          },
          () => {
            valid = false;
          },
        )
        .finally(() => {
          renewing = null;
        });
    }, 10_000);
    timer.unref?.();
    try {
      const outcome = await this.deps.process(event, () => valid);
      if (!valid) return;
      if (outcome === 'deferred') await this.deps.retry(event, 2_000, true);
      else await this.deps.finish(event, outcome);
    } catch {
      if (!valid) return;
      if (event.attempts >= 3) {
        await this.deps.failed(event);
        await this.deps.finish(event, 'failed');
      } else await this.deps.retry(event, 2_000 * event.attempts);
    } finally {
      clearInterval(timer);
      await renewing;
    }
  }
}

export const reactionDispatcher = new ReactionDispatcher();
