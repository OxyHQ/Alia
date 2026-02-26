import { useCallback, useEffect, useRef } from 'react';
import { createAudioPlayer, AudioPlayer } from 'expo-audio';
import {
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import { useOxy } from '@oxyhq/services';
import { useTTSStore } from '@/lib/stores/tts-store';
import { useUserDataStore } from '@/lib/stores/user-data-store';
import config from '@/lib/config';

export function useTTS() {
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

  const voicePref = useUserDataStore(s => s.memory?.preferences?.voice);
  const tonePref = useUserDataStore(s => s.memory?.preferences?.tone);
  const playerRef = useRef<AudioPlayer | null>(null);

  // Simulated wave amplitude for visualization
  const ttsWaveAmplitude = useSharedValue(0);

  // Animate wave when playing
  useEffect(() => {
    if (playbackState === 'playing') {
      ttsWaveAmplitude.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: 800, easing: Easing.inOut(Easing.sine) }),
          withTiming(0.2, { duration: 600, easing: Easing.inOut(Easing.sine) }),
          withTiming(0.6, { duration: 700, easing: Easing.inOut(Easing.sine) }),
          withTiming(0.15, { duration: 500, easing: Easing.inOut(Easing.sine) }),
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

  const playFromUrl = useCallback((audioUrl: string, messageId: string) => {
    releasePlayer();

    const player = createAudioPlayer({ uri: audioUrl });
    playerRef.current = player;

    player.addListener('playbackStatusUpdate', (status) => {
      if (status.didJustFinish) {
        releasePlayer();
        reset();
      }
    });

    player.play();
    setPlaybackState('playing');
  }, [releasePlayer, reset, setPlaybackState]);

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
      const token = oxyServices.getAccessToken();
      if (!token) {
        throw new Error('Not authenticated');
      }

      const response = await fetch(`${config.apiUrl}/v1/audio/speech`, {
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
  }, [activeMessageId, playbackState, oxyServices, getTTSVoice, getTTSSpeed, stop, playFromUrl, setActiveMessage, setPlaybackState, setError]);

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
