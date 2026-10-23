import type { OxyServices } from '@oxy.so/core';

/** Bind an audio operation to core's session context while allowing token rotation. */
export function bindAudioSession(
  oxy: Pick<OxyServices, 'createLinkedClient'>,
  baseURL: string,
  onInvalidated: () => void,
) {
  const linked = oxy.createLinkedClient({ baseURL });
  const epoch = linked.client.getSessionEpoch();
  let disposed = false;
  const current = () => !disposed && linked.client.getSessionEpoch() === epoch;
  const unsubscribe = linked.client.addTokenChangeListener(() => {
    if (!current()) onInvalidated();
  });
  return {
    fetch: linked.fetch,
    getToken: (target: string, options?: { signal?: AbortSignal }) =>
      current() ? linked.getAccessToken(target, options) : Promise.resolve(null),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      linked.dispose();
    },
  };
}
