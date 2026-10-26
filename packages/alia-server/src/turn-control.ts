import type { AliaServerClient } from './client.js';

export interface AliaTurnControlOptions {
  /** Shared with this request's stream; a terminal SSE frame may abort it before Stop is acknowledged. */
  readonly controller: AbortController;
  /** Separate account/owner lifetime fence; never the stream's own signal. */
  readonly lifetimeSignal: AbortSignal;
  readonly conversationId?: string;
}

/**
 * One HTTP generation, created before asynchronous preparation. A tool continuation
 * is another generation and needs a fresh handle. The caller retains ownership of
 * its authenticated transport and must fence account changes through both the controller and lifetimeSignal.
 */
export function createAliaTurnControl(
  client: Pick<AliaServerClient, 'cancelTurn'>,
  options: AliaTurnControlOptions,
) {
  const id = globalThis.crypto.randomUUID();
  let pending: Promise<void> | undefined;
  let finished = false;
  return {
    id,
    /** Acknowledged remote Stop, then detach. Failure leaves the stream available for retry. */
    stop(): Promise<void> {
      if (pending) return pending;
      if (finished || options.controller.signal.aborted) return Promise.resolve();
      pending = client
        .cancelTurn(
          { turnId: id, conversationId: options.conversationId },
          { signal: AbortSignal.any([options.lifetimeSignal, AbortSignal.timeout(10_000)]) },
        )
        .then(() => {
          options.controller.abort();
        })
        .catch((error) => {
          pending = undefined;
          throw error;
        });
      return pending;
    },
    /** Drain an outstanding acknowledgement before disposing the linked transport. */
    async finish(): Promise<void> {
      finished = true;
      await pending?.catch(() => undefined);
    },
  };
}

export type AliaTurnControl = ReturnType<typeof createAliaTurnControl>;
