import { useCallback, useEffect, useRef } from 'react';
import type { AudioPlayer, AudioStatus } from 'expo-audio';
import {
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';
import { useOxy } from '@oxyhq/services';
import { errorMessage } from '../lib/utils';
import { create } from 'zustand';
import { PREFERRED_VOICE_MODEL_ID } from '../lib/config';

const API_URL = process.env.EXPO_PUBLIC_ALIA_API_URL ?? 'https://api.alia.onl';

// ============== OPTIONS ==============

export interface UseTTSOptions {
  apiUrl?: string;
  accessToken?: string;
  voice?: 'male' | 'female';
  tone?: 'brief' | 'chill' | 'default';
  /**
   * Speech model. Defaults to the build's `PREFERRED_VOICE_MODEL_ID`.
   *
   * Not checked against `GET /catalogue`: that surface describes what a chat
   * picker may offer and its resolver filters to `chat_visible` entries, so
   * passing a voice identifier through it would substitute a chat model that
   * cannot speak. See `lib/config.ts`.
   */
  model?: string;
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
  const voiceModel = options.model ?? PREFERRED_VOICE_MODEL_ID;
  const tonePref = options.tone ?? 'default';

  const { oxyServices } = useOxy();
  // Per-field selectors: subscribing to the whole store re-renders every
  // consumer on any playback transition. Actions are static store refs, so
  // selecting them individually never triggers a re-render.
  const activeMessageId = useTTSStore((s) => s.activeMessageId);
  const playbackState = useTTSStore((s) => s.playbackState);
  const error = useTTSStore((s) => s.error);
  const setActiveMessage = useTTSStore((s) => s.setActiveMessage);
  const setPlaybackState = useTTSStore((s) => s.setPlaybackState);
  const setError = useTTSStore((s) => s.setError);
  const reset = useTTSStore((s) => s.reset);

  const playerRef = useRef<AudioPlayer | null>(null);

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
    } catch {
      // Best-effort teardown — the player may already be removed.
    }
    playerRef.current = null;
  }, []);

  const stop = useCallback(() => {
    releasePlayer();
    reset();
  }, [reset, releasePlayer]);

  /**
   * Play a stored clip.
   *
   * `onUnplayable` is how a caller says "I can make this again". Stored audio
   * is not permanent — `tts/` objects age out — and a link to something that is
   * gone fails in the player, not at the request, so the only place to notice
   * is here. Without a fallback the failure is reported; with one, the caller
   * gets to rebuild rather than the person getting an error about a button they
   * pressed twice.
   */
  const playFromUrl = useCallback((
    audioUrl: string,
    _messageId: string,
    onUnplayable?: () => void,
  ) => {
    releasePlayer();

    (async () => {
      try {
        const { createAudioPlayer } = await import('expo-audio');
        const player = createAudioPlayer({ uri: audioUrl });
        playerRef.current = player;

        player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
          if (status.error) {
            releasePlayer();
            if (onUnplayable) {
              onUnplayable();
              return;
            }
            setError(status.error);
            return;
          }
          if (status.didJustFinish) {
            releasePlayer();
            reset();
          }
        });

        player.play();
        setPlaybackState('playing');
      } catch {
        if (onUnplayable) {
          onUnplayable();
          return;
        }
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
    // Read volatile playback state at call time (not via closure) so this
    // callback's identity survives every playback transition. It is passed to
    // memoized message rows — an unstable identity re-renders all of them.
    const { activeMessageId, playbackState } = useTTSStore.getState();

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

      /**
       * Ask the server to make it, and play what comes back.
       *
       * Hoisted out of the cached branch below so a clip that has aged out of
       * storage can fall back to it. `playFromUrl` is called WITHOUT a fallback
       * here: a freshly made clip that will not play is a real failure, and
       * retrying it would be a loop.
       */
      const synthesize = async () => {
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
            model: voiceModel,
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
      };

      /**
       * A stored clip plays straight away, and is remade if it has gone.
       *
       * The row keeps its key long after a `tts/` object ages out of storage,
       * so the link is signed, valid, and points at nothing — a failure only
       * the player ever sees. Remaking it is cheaper than keeping every clip
       * forever, and the person notices nothing.
       */
      if (audioUrl) {
        playFromUrl(audioUrl, messageId, () => {
          void synthesize().catch((e: unknown) => setError(errorMessage(e, 'Failed to read aloud')));
        });
        return;
      }

      await synthesize();
    } catch (e: unknown) {
      console.error('[TTS] Error:', e);
      setError(errorMessage(e, 'Failed to read aloud'));
    }
  }, [getToken, apiUrl, getTTSVoice, getTTSSpeed, stop, playFromUrl, setActiveMessage, setPlaybackState, setError]);

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
