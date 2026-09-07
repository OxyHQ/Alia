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
  const socketRef = useRef<Socket | null>(null);

  /**
   * Which generation is current. Incremented by anything that supersedes work
   * already in flight — `stop()`, a new `generateAudio`, unmount.
   *
   * This replaces a shared `abortRef` boolean and a shared `pollTimerRef`, and
   * both were races rather than tidiness:
   *
   *  * `generateAudio` called `stop()` (setting `abortRef` true) and then
   *    immediately set it back to `false`. The previous job's abort checker
   *    runs on a 200 ms interval, so it read `false`, never rejected, kept its
   *    socket listener, and when it eventually resolved the OLD invocation
   *    carried on past `await waitForResult` and played its audio over the new
   *    one.
   *  * `pollTimerRef` was one handle for every concurrent wait. A second call
   *    overwrote the first's handle; the first's cleanup then cleared the
   *    SECOND's polling fallback, so if that job's socket event was missed it
   *    hung until its three-minute deadline.
   *
   * A counter answers "is this still the current work?" for each invocation
   * separately, which a single boolean and a single handle cannot.
   */
  const generationRef = useRef(0);

  const releasePlayer = useCallback(() => {
    try {
      playerRef.current?.remove();
    } catch {
      // Player may already be released by the native side; nothing to clean up.
    }
    playerRef.current = null;
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    releasePlayer();
    setState('idle');
    setActiveMessageId(null);
    setError(null);
  }, [releasePlayer]);

  // Manage shared socket connection for real-time job updates
  useEffect(() => {
    if (!isAuthenticated || !userId) return;

    const socket = getSharedSocket(config.apiUrl);

    /**
     * A NAMED handler, removed in the cleanup.
     *
     * The socket is shared and reference-counted, so it outlives this hook.
     * Registering an anonymous `connect` listener and never `off`-ing it meant
     * one more listener on the same socket for every mount of every component
     * using this hook — they accumulate for the life of the process, and each
     * one re-emits `subscribe-notifications` on every reconnect.
     * `use-show-progress.ts` is the shape this follows: `off` the handler, then
     * release the reference.
     */
    const onConnect = () => {
      // Server derives the room from the authenticated user; arg is ignored.
      socket.emit('subscribe-notifications');
    };
    socket.on('connect', onConnect);
    if (socket.connected) {
      socket.emit('subscribe-notifications');
    }

    socketRef.current = socket;

    return () => {
      socket.off('connect', onConnect);
      socketRef.current = null;
      releaseSharedSocket();
    };
  }, [isAuthenticated, userId]);

  // Clean up player on unmount. Bumping the generation is what stops every
  // in-flight wait: each one owns its own timer and drops it when it sees it
  // has been superseded.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      try { playerRef.current?.remove(); } catch { /* player may already be released on unmount */ }
    };
  }, []);

  /**
   * Wait for job completion via Socket.IO push, with polling fallback.
   * Socket events arrive instantly; polling kicks in as a safety net.
   */
  const waitForResult = useCallback(async (jobId: string, generation: number): Promise<string> => {
    const deadline = Date.now() + MAX_POLL_DURATION_MS;
    /** Superseded by a later generation — this invocation's work is stale. */
    const isStale = () => generationRef.current !== generation;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let abortChecker: ReturnType<typeof setInterval> | null = null;
      // Local to THIS wait, so two concurrent waits cannot clear each other's
      // polling fallback.
      let pollTimer: ReturnType<typeof setTimeout> | null = null;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const cleanup = () => {
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
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
        if (settled || isStale()) return;
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

        if (!settled && !isStale()) {
          pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      };

      // Start first poll after a short delay (give socket a chance to deliver first)
      pollTimer = setTimeout(poll, POLL_INTERVAL_MS);

      // Check periodically whether this work has been superseded
      abortChecker = setInterval(() => {
        if (isStale() || settled) {
          clearInterval(abortChecker!);
          abortChecker = null;
          if (isStale()) {
            settle(() => reject(new Error('Cancelled')));
          }
        }
      }, 200);
    });
  }, []);

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

    // Claim a generation for THIS request. Anything already in flight is
    // superseded by the increment and will drop its own work. Declared outside
    // the `try` so the `catch` can tell a real failure from a superseded one.
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    try {
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
      const audioUrl = await waitForResult(jobId, generation);

      if (generationRef.current !== generation) return;

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
      // Superseded or cancelled — the newer request owns the UI now.
      if (generationRef.current !== generation) return;
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
