import type { OxyServices } from '@oxy.so/core';
import { createRandomUuid } from './random-uuid';
import { awaitTurnPreparation } from './turn-preparation';

type LinkedClient = ReturnType<OxyServices['createLinkedClient']>;

/** One client turn, created before any asynchronous preparation or metadata. */
export function createChatTurnControl(
  linked: LinkedClient,
  headers: Promise<Record<string, string>>,
  conversationId: string | undefined,
  controller: AbortController,
) {
  // A host can reject before Stop is pressed. Observe that rejection immediately;
  // awaiting the original promise below still reports the failure to Stop.
  void headers.catch(() => undefined);
  const id = createRandomUuid();
  let stopping: Promise<void> | undefined;
  let ended = false;
  const epoch = linked.client.getSessionEpoch();
  const current = () => linked.client.getSessionEpoch() === epoch;
  const unsubscribe = linked.client.addTokenChangeListener(() => {
    if (!current()) controller.abort(new Error('The conversation account changed'));
  });
  return {
    id,
    /** Only a deliberate Stop invokes this. View teardown merely aborts its transport. */
    stop(): Promise<void> {
      if (stopping) return stopping;
      if (ended || controller.signal.aborted) return Promise.resolve();
      stopping = (async () => {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
        const assertionHeaders = await awaitTurnPreparation(headers, signal);
        signal.throwIfAborted();
        controller.signal.throwIfAborted();
        if (!current()) throw new Error('The conversation account changed');
        const response = await linked.client.requestAuthenticatedResponse({
          url: `/v1/chat/turns/${id}/cancel`,
          method: 'POST',
          headers: { ...assertionHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(conversationId ? { conversationId } : {}) }),
          // The cancelled chat signal must NOT cancel its own control request.
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Generation could not be stopped. Try again.');
        }
        await response.body?.cancel();
        controller.abort();
      })().catch((error) => {
        stopping = undefined;
        throw error;
      });
      return stopping;
    },
    async finish() {
      ended = true;
      // The stream can close before the replica answering Stop sends its acknowledgement.
      await stopping?.catch(() => undefined);
      unsubscribe();
      linked.dispose();
    },
  };
}

/** Public lifecycle handle for hosts that render their own Stop control. */
export type AliaChatTurnControl = ReturnType<typeof createChatTurnControl>;
