import type { AliaTurnControl } from '@alia.onl/server';

/** One CLI submission, potentially containing several independently controlled tool rounds. */
export function createConversationControl() {
  const lifetime = new AbortController();
  const activity = new AbortController();
  let removeAccountListener: (() => void) | undefined;
  let current: { turn: AliaTurnControl; controller: AbortController } | undefined;
  let stopping = false;
  let acknowledged = false;
  return {
    lifetimeSignal: lifetime.signal,
    activitySignal: activity.signal,
    bindAccount(subscribe: () => () => void): void {
      if (!removeAccountListener && !lifetime.signal.aborted) removeAccountListener = subscribe();
    },
    get stopped() {
      return stopping || lifetime.signal.aborted;
    },
    get stopAcknowledged() {
      return acknowledged;
    },
    get stopRequested() {
      return stopping;
    },
    attach(turn: AliaTurnControl, controller: AbortController): boolean {
      if (stopping || lifetime.signal.aborted) return false;
      current = { turn, controller };
      return true;
    },
    async finish(turn: AliaTurnControl): Promise<void> {
      await turn.finish();
      if (current?.turn === turn) current = undefined;
    },
    /** Stop blocks tools immediately, but only the SDK acknowledgement detaches the stream. */
    async stop(): Promise<void> {
      stopping = true;
      activity.abort();
      if (!lifetime.signal.aborted) {
        await current?.turn.stop();
        if (!lifetime.signal.aborted) acknowledged = true;
      }
    },
    /** Account change, unmount or a broken output pipe is detach, never remote Stop. */
    dispose(): void {
      lifetime.abort();
      activity.abort();
      removeAccountListener?.();
      removeAccountListener = undefined;
      current?.controller.abort();
    },
  };
}
export type ConversationControl = ReturnType<typeof createConversationControl>;
