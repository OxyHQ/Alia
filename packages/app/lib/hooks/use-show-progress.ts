/**
 * Real-time episode progress, on the SHARED notifications socket.
 *
 * The version this replaces documented exactly this — *"the actual socket
 * connection is managed by use-notification-setup"* — and then built a second
 * refcounted singleton of its own. A signed-in user on the shows screen held
 * two websockets to the same server, in the same room, so every emit arrived
 * twice and which socket a listener landed on depended on mount order.
 *
 * `lib/api/notifications-socket.ts` is the one connection now. This hook adds a
 * listener and takes it away again; the connection belongs to whoever still
 * holds a reference.
 */

import { useEffect } from 'react';
import { useOxy } from '@oxyhq/services';
import { acquireNotificationsSocket } from '@/lib/api/notifications-socket';
import { useShowStore, type ShowProgress } from '@/lib/stores/show-store';

export function useShowProgress() {
  const { user, isAuthenticated } = useOxy();
  const userId = user?.id;
  const updateProgress = useShowStore((s) => s.updateProgress);
  const fetchOneSeries = useShowStore((s) => s.fetchOneSeries);

  useEffect(() => {
    if (!isAuthenticated || !userId) return;

    const { socket, release } = acquireNotificationsSocket();

    const onProgress = (progress: ShowProgress) => {
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
    };

    socket.on('show:progress', onProgress);

    return () => {
      socket.off('show:progress', onProgress);
      release();
    };
  }, [isAuthenticated, userId, updateProgress, fetchOneSeries]);
}
