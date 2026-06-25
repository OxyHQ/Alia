/**
 * Hook for AI audio generation from text prompts.
 *
 * Submits a generation job via POST /v1/audio/generate (returns immediately),
 * then listens for Socket.IO push notification of completion. Falls back to
 * polling GET /v1/audio/jobs/:jobId if the socket event doesn't arrive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { io as socketIO, type Socket } from 'socket.io-client';
import { useOxy } from '@oxyhq/services';
import apiClient, { getSocketToken } from '@/lib/api/client';
import config from '@/lib/config';
import { errorMessage as getErrorMessage } from '../errors/error-utils';

type AudioGenState = 'idle' | 'generating' | 'playing' | 'error';

const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_DURATION_MS = 180_000; // 3 minutes

interface AudioJobUpdate {
  jobId: string;
  status: 'completed' | 'failed';
  audioUrl?: string;
  error?: string;
}

// Shared socket with reference counting (same pattern as use-show-progress.ts)
let sharedSocket: ReturnType<typeof socketIO> | null = null;
let refCount = 0;

function getSharedSocket(apiUrl: string): ReturnType<typeof socketIO> {
  if (!sharedSocket) {
    sharedSocket = socketIO(apiUrl, {
      transports: ['websocket'],
      // Function form so a fresh token is read on every (re)connect.
      auth: (cb) => cb({ token: getSocketToken() }),
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

export function useAudioGen() {
  const { user, isAuthenticated } = useOxy();
  const userId = user?.id;

  const [state, setState] = useState<AudioGenState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const playerRef = useRef<any>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef(false);
  const socketRef = useRef<Socket | null>(null);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const releasePlayer = useCallback(() => {
    try {
      playerRef.current?.remove();
    } catch {}
    playerRef.current = null;
  }, []);

  const stop = useCallback(() => {
    abortRef.current = true;
    clearPollTimer();
    releasePlayer();
    setState('idle');
    setActiveMessageId(null);
    setError(null);
  }, [releasePlayer, clearPollTimer]);

  // Manage shared socket connection for real-time job updates
  useEffect(() => {
    if (!isAuthenticated || !userId) return;

    const socket = getSharedSocket(config.apiUrl);

    socket.on('connect', () => {
      // Server derives the room from the authenticated user; arg is ignored.
      socket.emit('subscribe-notifications');
    });
    if (socket.connected) {
      socket.emit('subscribe-notifications');
    }

    socketRef.current = socket;

    return () => {
      socketRef.current = null;
      releaseSharedSocket();
    };
  }, [isAuthenticated, userId]);

  // Clean up timer and player on unmount
  useEffect(() => {
    return () => {
      abortRef.current = true;
      clearPollTimer();
      try { playerRef.current?.remove(); } catch {}
    };
  }, [clearPollTimer]);

  /**
   * Wait for job completion via Socket.IO push, with polling fallback.
   * Socket events arrive instantly; polling kicks in as a safety net.
   */
  const waitForResult = useCallback(async (jobId: string): Promise<string> => {
    const deadline = Date.now() + MAX_POLL_DURATION_MS;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let abortChecker: ReturnType<typeof setInterval> | null = null;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const cleanup = () => {
        clearPollTimer();
        if (abortChecker) {
          clearInterval(abortChecker);
          abortChecker = null;
        }
        if (socketRef.current) {
          socketRef.current.off('audio:job-update', onSocketUpdate);
        }
      };

      // Socket.IO listener — resolves immediately when server pushes update
      const onSocketUpdate = (data: AudioJobUpdate) => {
        if (data.jobId !== jobId) return;
        if (data.status === 'completed' && data.audioUrl) {
          settle(() => resolve(data.audioUrl!));
        } else if (data.status === 'failed') {
          settle(() => reject(new Error(data.error || 'Generation failed')));
        }
      };

      if (socketRef.current) {
        socketRef.current.on('audio:job-update', onSocketUpdate);
      }

      // Polling fallback — in case socket is disconnected or event is missed
      const poll = async () => {
        if (settled || abortRef.current) return;
        if (Date.now() >= deadline) {
          settle(() => reject(new Error('Generation timed out')));
          return;
        }

        try {
          const { data } = await apiClient.get(`/v1/audio/jobs/${jobId}`);
          if (data.status === 'completed') {
            settle(() => resolve(data.audioUrl));
            return;
          }
          if (data.status === 'failed') {
            settle(() => reject(new Error(data.error || 'Generation failed')));
            return;
          }
        } catch {
          // Transient poll failure — continue
        }

        if (!settled && !abortRef.current) {
          pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        }
      };

      // Start first poll after a short delay (give socket a chance to deliver first)
      pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);

      // Check periodically if user cancelled
      abortChecker = setInterval(() => {
        if (abortRef.current || settled) {
          clearInterval(abortChecker!);
          abortChecker = null;
          if (abortRef.current) {
            settle(() => reject(new Error('Cancelled')));
          }
        }
      }, 200);
    });
  }, [clearPollTimer]);

  const generateAudio = useCallback(async (
    messageId: string,
    prompt: string,
    conversationId?: string,
  ) => {
    // If same message, stop
    if (activeMessageId === messageId && state === 'playing') {
      stop();
      return;
    }

    // Stop any current playback
    if (activeMessageId) {
      stop();
    }

    try {
      abortRef.current = false;
      setActiveMessageId(messageId);
      setState('generating');
      setError(null);

      // Submit generation job — returns immediately with jobId
      const { data: submitData } = await apiClient.post('/v1/audio/generate', {
        prompt,
        seconds_total: 30,
        conversationId,
        messageId,
      });

      const { jobId } = submitData;

      // Wait for completion via socket push + polling fallback
      const audioUrl = await waitForResult(jobId);

      if (abortRef.current) return;

      // Play the generated audio
      releasePlayer();
      const { createAudioPlayer } = await import('expo-audio');
      const player = createAudioPlayer({ uri: audioUrl });
      playerRef.current = player;

      player.addListener('playbackStatusUpdate', (status: any) => {
        if (status.didJustFinish) {
          releasePlayer();
          setState('idle');
          setActiveMessageId(null);
        }
      });

      player.play();
      setState('playing');
    } catch (e: unknown) {
      if (abortRef.current) return; // user cancelled — don't show error
      console.error('[AudioGen] Error:', e);
      const msg = getErrorMessage(e, 'Failed to generate audio');
      setError(msg);
      setState('error');
    }
  }, [activeMessageId, state, stop, releasePlayer, waitForResult]);

  return {
    generateAudio,
    stop,
    state,
    error,
    activeMessageId,
    isGenerating: state === 'generating',
    isPlaying: state === 'playing',
  };
}
