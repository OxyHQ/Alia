/**
 * Hook to listen for real-time show generation progress via Socket.IO.
 * Updates the show store with progress events from the server.
 */

import { useEffect } from 'react';
import { io as socketIO } from 'socket.io-client';
import { useOxy } from '@oxyhq/services';
import { useShowStore, type ShowProgress } from '@/lib/stores/show-store';
import config from '@/lib/config';

export function useShowProgress() {
  const { user, isAuthenticated } = useOxy();
  const userId = user?.id;
  const updateProgress = useShowStore(s => s.updateProgress);
  const fetchShow = useShowStore(s => s.fetchShow);

  useEffect(() => {
    if (!isAuthenticated || !userId) return;

    const socket = socketIO(config.apiUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socket.on('connect', () => {
      socket.emit('subscribe-notifications', userId);
    });

    socket.on('show:progress', (data: ShowProgress) => {
      updateProgress(data);

      // When completed, fetch full show data
      if (data.status === 'completed' || data.status === 'failed') {
        fetchShow(data.showId);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [isAuthenticated, userId, updateProgress, fetchShow]);
}
