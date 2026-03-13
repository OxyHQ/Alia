/**
 * Hook for AI audio generation from text prompts.
 *
 * Submits a generation job via POST /v1/audio/generate (returns immediately),
 * then polls GET /v1/audio/jobs/:jobId until the audio is ready.
 */

import { useCallback, useRef, useState } from 'react';
import apiClient from '@/lib/api/client';

type AudioGenState = 'idle' | 'generating' | 'playing' | 'error';

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_DURATION_MS = 180_000; // 3 minutes

export function useAudioGen() {
  const [state, setState] = useState<AudioGenState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const playerRef = useRef<any>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef(false);

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

  const pollForResult = useCallback(async (jobId: string): Promise<string> => {
    const deadline = Date.now() + MAX_POLL_DURATION_MS;

    while (Date.now() < deadline) {
      if (abortRef.current) throw new Error('Cancelled');

      await new Promise<void>(resolve => {
        pollTimerRef.current = setTimeout(resolve, POLL_INTERVAL_MS);
      });

      if (abortRef.current) throw new Error('Cancelled');

      const { data } = await apiClient.get(`/v1/audio/jobs/${jobId}`);

      if (data.status === 'completed') return data.audioUrl;
      if (data.status === 'failed') throw new Error(data.error || 'Generation failed');
      // status === 'processing' — continue polling
    }

    throw new Error('Generation timed out');
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

      // Poll until audio is ready
      const audioUrl = await pollForResult(jobId);

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
    } catch (e: any) {
      if (abortRef.current) return; // user cancelled — don't show error
      console.error('[AudioGen] Error:', e);
      const msg = e.response?.data?.error?.message || e.message || 'Failed to generate audio';
      setError(msg);
      setState('error');
    }
  }, [activeMessageId, state, stop, releasePlayer, pollForResult]);

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
