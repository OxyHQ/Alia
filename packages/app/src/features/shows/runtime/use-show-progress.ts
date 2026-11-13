/**
 * Real-time episode progress: `show.progress` on the account's ONE realtime connection, the one
 * the runtime provider holds (`@gemies/sdk/runtime`). This hook only listens; it opens nothing.
 */

import { useRealtimeEvent } from '@gemies/sdk/runtime';
import { useShowStore, type ShowProgress } from '@/features/shows/runtime/show-store';

export function useShowProgress() {
  const updateProgress = useShowStore((s) => s.updateProgress);
  const fetchOneSeries = useShowStore((s) => s.fetchOneSeries);

  // `show.progress` on the account's realtime connection (`docs/realtime.mdx`).
  useRealtimeEvent('show.progress', (frame) => {
    const progress = frame.data as ShowProgress;
    updateProgress(progress);
    /**
     * A finished episode is refetched rather than patched from the event.
     *
     * The event carries a status and a percentage; what changed is the whole
     * episode — its Syra id, its duration, what it cost, and its recap. The
     * series read returns all of it, and it is the same read the screen does
     * on mount, so there is one shape rather than two.
     */
    if (progress.status === 'completed' || progress.status === 'failed') {
      void fetchOneSeries(progress.seriesId);
    }
  });
}
