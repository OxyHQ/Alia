import { useCallback, useEffect, useRef } from 'react';
import type { AudioPlayer, AudioSample, AudioStatus } from 'expo-audio';
import { makeMutable, withTiming } from 'react-native-reanimated';
import { useOxy } from '@oxyhq/services';
import { errorMessage } from '../lib/utils';
import { create } from 'zustand';
import { createAudioLevelMeter } from '../lib/audio-level';
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

// ============== PLAYBACK LEVEL ==============

/** How long the level takes to reach silence once a clip stops sounding. */
const SILENCE_FADE_MS = 300;

/**
 * The live playback level, 0..1, shared by every consumer.
 *
 * At module scope rather than inside the hook because the two ends of it live
 * in different components: the message list calls `readAloud` and therefore
 * owns the player, while the ambient field behind the conversation is rendered
 * somewhere else entirely. Each `useTTS()` call is its own React instance, so a
 * per-instance `useSharedValue` leaves the field reading a value that nothing
 * writes — which is why the animation it replaces had to be driven off the
 * shared playback STATE instead of off the audio. One player, one store, one
 * level.
 */
const ttsWaveAmplitude = makeMutable(0);

/**
 * Silence is a projection of playback state, not an animation of its own.
 *
 * Every platform stops delivering buffers the instant a clip pauses, ends or
 * fails, so nothing would write the level down again and the field would freeze
 * swollen wherever the last syllable left it. Subscribed once, beside the store
 * that owns the transitions, so a transition added later cannot forget it.
 */
useTTSStore.subscribe((state, previous) => {
  if (state.playbackState === 'playing') return;
  if (previous.playbackState !== 'playing') return;
  ttsWaveAmplitude.value = withTiming(0, { duration: SILENCE_FADE_MS });
});

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

  // ============== AUTH ==============

  const getToken = useCallback((): string | null => {
    if (options.accessToken) return options.accessToken;
    return oxyServices.httpService.getAccessToken();
  }, [options.accessToken, oxyServices]);

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
        /**
         * `crossOrigin` is web-only and ignored elsewhere, and it is what makes
         * the waveform readable there: a browser will not let an `AnalyserNode`
         * see a cross-origin media element loaded without CORS, so without this
         * `setAudioSamplingEnabled` below silently declines and the field never
         * moves. Clips are served by `GET /media` on the API host, which is a
         * different origin from the app on every deployment.
         *
         * It costs the clip its CORS headers if the app's origin is not on the
         * API's allowlist — but such an origin cannot load a conversation to
         * read aloud in the first place, since `/media` and `/conversations`
         * share that allowlist. Measured against production 2026-08-26:
         * `Origin: https://alia.onl` is answered
         * `access-control-allow-origin: https://alia.onl`, with `Vary: Origin`.
         */
        const player = createAudioPlayer({ uri: audioUrl }, { crossOrigin: 'anonymous' });
        playerRef.current = player;

        /**
         * The real waveform, which is what the ambient field behind the
         * conversation moves to. Enabled BEFORE `play()`: on web this is what
         * builds the analyser, and the sampling loop only starts if the player
         * is already playing or starts afterwards.
         *
         * It can decline, and declining is not an error. Android routes
         * playback sampling through `android.media.audiofx.Visualizer`, which
         * needs `RECORD_AUDIO` already granted — and asking a person for the
         * microphone so that a background can move would be a worse trade than
         * the background not moving. Where it declines no buffer ever arrives,
         * the level stays at zero and the field simply rests. That is the
         * honest reading of "we cannot hear this", and it is deliberately not
         * papered over with motion that does not come from the audio.
         */
        player.setAudioSamplingEnabled(true);
        const meter = createAudioLevelMeter();
        player.addListener('audioSampleUpdate', (sample: AudioSample) => {
          const frames = sample.channels[0]?.frames;
          if (frames === undefined) return;
          ttsWaveAmplitude.value = meter.push(frames, Date.now());
        });

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
