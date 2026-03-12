/**
 * Hook for AI audio generation from text prompts.
 *
 * Uses the /v1/audio/generate endpoint (Stable Audio via DO async-invoke)
 * to generate audio/music/sounds, then plays them inline.
 */

import { useCallback, useRef, useState } from 'react';
import { useOxy } from '@oxyhq/services';
import config from '@/lib/config';

type AudioGenState = 'idle' | 'generating' | 'playing' | 'error';

export function useAudioGen() {
  const { oxyServices } = useOxy();
  const [state, setState] = useState<AudioGenState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const playerRef = useRef<any>(null);

  const getToken = useCallback((): string | null => {
    return oxyServices.httpService.getAccessToken();
  }, [oxyServices]);

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

      const token = getToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const response = await fetch(`${config.apiUrl}/v1/audio/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          prompt,
          seconds_total: 30,
          conversationId,
          messageId,
        }),
      });

      if (!response.ok) {
        if (response.status === 504) {
          throw new Error('Request timed out — please try again');
        }
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error?.message || errData.error || 'Audio generation failed');
      }

      const data = await response.json();

      // Play the generated audio
      releasePlayer();
      const { createAudioPlayer } = await import('expo-audio');
      const player = createAudioPlayer({ uri: data.audioUrl });
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
      setError(e.message || 'Failed to generate audio');
      setState('error');
    }
  }, [activeMessageId, state, getToken, stop, releasePlayer]);

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
