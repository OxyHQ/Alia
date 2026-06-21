/**
 * Hook to listen for real-time show generation progress via Socket.IO.
 * Piggybacks on the existing notification socket in use-notification-setup.ts
 * by creating a minimal listener that reuses the same connection pattern.
 *
 * NOTE: This is intentionally thin — the actual socket connection is managed
 * by use-notification-setup. This hook just registers the show:progress listener.
 */

import { useEffect } from 'react';
import { io as socketIO } from 'socket.io-client';
import { useOxy } from '@oxyhq/services';
import { useShowStore, type ShowProgress } from '@/lib/stores/show-store';
import config from '@/lib/config';

let sharedSocket: ReturnType<typeof socketIO> | null = null;
let refCount = 0;

function getSharedSocket(apiUrl: string): ReturnType<typeof socketIO> {
  if (!sharedSocket) {
    sharedSocket = socketIO(apiUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
  }
  refCount++;
  return sharedSocket;
}

function releaseSharedSocket() {
  refCount--;
  if (refCount <= 0 && sharedSocket) {
    sharedSocket.disconnect();
    sharedSocket = null;
    refCount = 0;
  }
}

export function useShowProgress() {
  const { user, isAuthenticated } = useOxy();
  const userId = user?.id;
  const updateProgress = useShowStore(s => s.updateProgress);
  const fetchShow = useShowStore(s => s.fetchShow);

  useEffect(() => {
    if (!isAuthenticated || !userId) return;

    const socket = getSharedSocket(config.apiUrl);

    socket.on('connect', () => {
      socket.emit('subscribe-notifications', userId);
    });

    // If already connected, subscribe immediately
    if (socket.connected) {
      socket.emit('subscribe-notifications', userId);
    }

    const handler = (data: ShowProgress) => {
      updateProgress(data);
      if (data.status === 'completed' || data.status === 'failed') {
        fetchShow(data.showId);
      }
    };

    socket.on('show:progress', handler);

    return () => {
      socket.off('show:progress', handler);
      releaseSharedSocket();
    };
  }, [isAuthenticated, userId, updateProgress, fetchShow]);
}
