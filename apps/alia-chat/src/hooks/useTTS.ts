import { useCallback, useEffect, useRef } from 'react';
import {
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import { useOxy } from '@oxyhq/services';
import { create } from 'zustand';

const API_URL = process.env.EXPO_PUBLIC_ALIA_API_URL ?? 'https://api.alia.onl';

// ============== OPTIONS ==============

export interface UseTTSOptions {
  apiUrl?: string;
  accessToken?: string;
  voice?: 'male' | 'female';
  tone?: 'brief' | 'chill' | 'default';
}

// ============== INLINE TTS STORE ==============

type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

interface TTSStore {
  activeMessageId: string | null;
  playbackState: PlaybackState;
  error: string | null;
  setActiveMessage: (id: string | null) => void;
  setPlaybackState: (state: PlaybackState) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const useTTSStore = create<TTSStore>((set) => ({
  activeMessageId: null,
  playbackState: 'idle',
  error: null,
  setActiveMessage: (id) => set({ activeMessageId: id }),
  setPlaybackState: (playbackState) => set({ playbackState }),
  setError: (error) => set({ error, playbackState: error ? 'error' : 'idle' }),
  reset: () => set({ activeMessageId: null, playbackState: 'idle', error: null }),
}));

// ============== HOOK ==============

export function useTTS(options: UseTTSOptions = {}) {
  const apiUrl = options.apiUrl || API_URL;
  const voicePref = options.voice ?? 'female';
  const tonePref = options.tone ?? 'default';

  const { oxyServices } = useOxy();
  const {
    activeMessageId,
    playbackState,
    error,
    setActiveMessage,
    setPlaybackState,
    setError,
    reset,
  } = useTTSStore();

  const playerRef = useRef<any>(null);

  // Simulated wave amplitude for visualization
  const ttsWaveAmplitude = useSharedValue(0);

  // ============== AUTH ==============

  const getToken = useCallback((): string | null => {
    if (options.accessToken) return options.accessToken;
    return oxyServices.httpService.getAccessToken();
  }, [options.accessToken, oxyServices]);

  // Animate wave when playing
  useEffect(() => {
    if (playbackState === 'playing') {
      ttsWaveAmplitude.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: 800, easing: Easing.inOut(Easing.sin) }),
          withTiming(0.2, { duration: 600, easing: Easing.inOut(Easing.sin) }),
          withTiming(0.6, { duration: 700, easing: Easing.inOut(Easing.sin) }),
          withTiming(0.15, { duration: 500, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
      );
    } else {
      cancelAnimation(ttsWaveAmplitude);
      ttsWaveAmplitude.value = withTiming(0, { duration: 300 });
    }
  }, [playbackState]);

  const getTTSVoice = useCallback(() => {
    return voicePref === 'male' ? 'echo' : 'nova';
  }, [voicePref]);

  const getTTSSpeed = useCallback(() => {
    if (tonePref === 'brief') return 1.15;
    if (tonePref === 'chill') return 0.9;
    return 1.0;
  }, [tonePref]);

  const releasePlayer = useCallback(() => {
    try {
      playerRef.current?.remove();
    } catch {}
    playerRef.current = null;
  }, []);

  const stop = useCallback(() => {
    releasePlayer();
    reset();
  }, [reset, releasePlayer]);

  const playFromUrl = useCallback((audioUrl: string, _messageId: string) => {
    releasePlayer();

    (async () => {
      try {
        const { createAudioPlayer } = await import('expo-audio');
        const player = createAudioPlayer({ uri: audioUrl });
        playerRef.current = player;

        player.addListener('playbackStatusUpdate', (status: any) => {
          if (status.didJustFinish) {
            releasePlayer();
            reset();
          }
        });

        player.play();
        setPlaybackState('playing');
      } catch {
        setError('Audio playback not available');
      }
    })();
  }, [releasePlayer, reset, setPlaybackState, setError]);

  const readAloud = useCallback(async (
    messageId: string,
    text: string,
    conversationId?: string,
    audioUrl?: string,
  ) => {
    // If same message is playing, toggle pause/play
    if (activeMessageId === messageId) {
      if (playbackState === 'playing') {
        playerRef.current?.pause();
        setPlaybackState('paused');
        return;
      }
      if (playbackState === 'paused') {
        playerRef.current?.play();
        setPlaybackState('playing');
        return;
      }
    }

    // Stop any current playback
    if (activeMessageId) {
      stop();
    }

    try {
      setActiveMessage(messageId);
      setPlaybackState('loading');

      // If cached audioUrl exists, play directly
      if (audioUrl) {
        playFromUrl(audioUrl, messageId);
        return;
      }

      // Call backend TTS API
      const token = getToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const response = await fetch(`${apiUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: 'alia-v1-voice',
          input: text,
          voice: getTTSVoice(),
          speed: getTTSSpeed(),
          conversationId,
          messageId,
        }),
      });

      if (!response.ok) {
        if (response.status === 504) {
          throw new Error('Request timed out — please try again');
        }
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error?.message || errData.error || 'TTS failed');
      }

      const data = await response.json();
      playFromUrl(data.audioUrl, messageId);
    } catch (e: any) {
      console.error('[TTS] Error:', e);
      setError(e.message || 'Failed to read aloud');
    }
  }, [activeMessageId, playbackState, getToken, apiUrl, getTTSVoice, getTTSSpeed, stop, playFromUrl, setActiveMessage, setPlaybackState, setError]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      releasePlayer();
    };
  }, []);

  return {
    readAloud,
    stop,
    activeMessageId,
    playbackState,
    error,
    ttsWaveAmplitude,
    isPlaying: playbackState === 'playing',
    isPaused: playbackState === 'paused',
    isLoading: playbackState === 'loading',
  };
}
