import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import {
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';
import { useOxy } from '@oxyhq/services';
import { useTTSStore, type TTSPlaybackState } from '@/lib/stores/tts-store';
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
  const trackPlayerReady = useRef(false);
  const currentFileUri = useRef<string | null>(null);

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

  const ensurePlayer = useCallback(async () => {
    if (Platform.OS === 'web') return;
    if (trackPlayerReady.current) return;

    const { initTrackPlayer } = await import('@/lib/services/track-player-init');
    await initTrackPlayer();
    trackPlayerReady.current = true;
  }, []);

  const getTTSVoice = useCallback(() => {
    return voicePref === 'male' ? 'echo' : 'nova';
  }, [voicePref]);

  const cleanupTempFile = useCallback(async () => {
    if (!currentFileUri.current || Platform.OS === 'web') return;
    try {
      const FileSystem = await import('expo-file-system');
      const info = await FileSystem.getInfoAsync(currentFileUri.current);
      if (info.exists) {
        await FileSystem.deleteAsync(currentFileUri.current, { idempotent: true });
      }
    } catch {}
    currentFileUri.current = null;
  }, []);

  const stop = useCallback(async () => {
    try {
      if (Platform.OS === 'web') {
        const Speech = await import('expo-speech');
        Speech.stop();
      } else {
        const TrackPlayer = (await import('react-native-track-player')).default;
        await TrackPlayer.reset();
      }
    } catch {}
    await cleanupTempFile();
    reset();
  }, [reset, cleanupTempFile]);

  const readAloud = useCallback(async (messageId: string, text: string) => {
    // If same message is playing, toggle pause/play
    if (activeMessageId === messageId) {
      if (playbackState === 'playing') {
        if (Platform.OS === 'web') {
          const Speech = await import('expo-speech');
          Speech.stop();
          reset();
        } else {
          const TrackPlayer = (await import('react-native-track-player')).default;
          await TrackPlayer.pause();
          setPlaybackState('paused');
        }
        return;
      }
      if (playbackState === 'paused') {
        const TrackPlayer = (await import('react-native-track-player')).default;
        await TrackPlayer.play();
        setPlaybackState('playing');
        return;
      }
    }

    // Stop any current playback
    if (activeMessageId) {
      await stop();
    }

    try {
      setActiveMessage(messageId);
      setPlaybackState('loading');

      // Web fallback: use expo-speech (free, on-device)
      if (Platform.OS === 'web') {
        const Speech = await import('expo-speech');
        Speech.speak(text, {
          onDone: () => reset(),
          onError: () => reset(),
        });
        setPlaybackState('playing');
        return;
      }

      await ensurePlayer();

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
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error?.message || errData.error || 'TTS failed');
      }

      // Write audio to temp file for TrackPlayer
      const FileSystem = await import('expo-file-system');
      const blob = await response.blob();
      const base64 = await blobToBase64(blob);
      const fileUri = FileSystem.cacheDirectory + `tts-${messageId}-${Date.now()}.mp3`;
      await FileSystem.writeAsStringAsync(fileUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      currentFileUri.current = fileUri;

      // Load and play via TrackPlayer
      const TrackPlayer = (await import('react-native-track-player')).default;
      await TrackPlayer.reset();
      await TrackPlayer.add({
        id: messageId,
        url: fileUri,
        title: 'Alia',
        artist: 'Read Aloud',
      });
      await TrackPlayer.play();
      setPlaybackState('playing');
    } catch (e: any) {
      console.error('[TTS] Error:', e);
      setError(e.message || 'Failed to read aloud');
    }
  }, [activeMessageId, playbackState, oxyServices, getTTSVoice, ensurePlayer, stop, reset, setActiveMessage, setPlaybackState, setError]);

  // Listen for TrackPlayer events
  useEffect(() => {
    if (Platform.OS === 'web') return;

    let subscriptions: Array<{ remove: () => void }> = [];

    (async () => {
      try {
        const TrackPlayer = (await import('react-native-track-player')).default;
        const { Event } = await import('react-native-track-player');

        subscriptions.push(
          TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => {
            cleanupTempFile();
            reset();
          }),
          TrackPlayer.addEventListener(Event.PlaybackState, (data: any) => {
            const state = data.state;
            if (state === 'paused' || state === 'pause') setPlaybackState('paused');
            if (state === 'playing' || state === 'play') setPlaybackState('playing');
          }),
        );
      } catch {}
    })();

    return () => {
      for (const sub of subscriptions) {
        try { sub.remove(); } catch {}
      }
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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip the data URL prefix (e.g. "data:audio/mpeg;base64,")
      const base64 = result.split(',')[1] || result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
