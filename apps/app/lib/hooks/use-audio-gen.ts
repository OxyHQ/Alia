/**
 * Hook for AI audio generation from text prompts.
 *
 * Uses the /v1/audio/generate endpoint (Stable Audio via DO async-invoke)
 * to generate audio/music/sounds, then plays them inline.
 */

import { useCallback, useRef, useState } from 'react';
import apiClient from '@/lib/api/client';

type AudioGenState = 'idle' | 'generating' | 'playing' | 'error';

export function useAudioGen() {
  const [state, setState] = useState<AudioGenState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const playerRef = useRef<any>(null);

  const releasePlayer = useCallback(() => {
    try {
      playerRef.current?.remove();
    } catch {}
    playerRef.current = null;
  }, []);

  const stop = useCallback(() => {
    releasePlayer();
    setState('idle');
    setActiveMessageId(null);
    setError(null);
  }, [releasePlayer]);

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
      setActiveMessageId(messageId);
      setState('generating');
      setError(null);

      const response = await apiClient.post('/v1/audio/generate', {
        prompt,
        seconds_total: 30,
        conversationId,
        messageId,
      });

      const { audioUrl } = response.data;

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
      console.error('[AudioGen] Error:', e);
      const msg = e.response?.data?.error?.message || e.message || 'Failed to generate audio';
      setError(msg);
      setState('error');
    }
  }, [activeMessageId, state, stop, releasePlayer]);

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
