import { useMemo } from 'react';
import {
  useSharedValue,
  useDerivedValue,
  useAnimatedReaction,
  withTiming,
  withRepeat,
  withSequence,
  cancelAnimation,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';
import { useSTTStore } from './useSpeechToText';
import type { AgentState } from '../types';

export type AmbientWaveMode = 'voice' | 'tts' | 'stt' | 'thinking' | 'idle';

export interface AmbientWaveVoice {
  isActive: boolean;
  isConnected: boolean;
  agentState: AgentState;
  waveAmplitude: SharedValue<number>;
}

export interface UseAmbientWaveOptions {
  /** Live voice-call amplitude + state (present only while a call is being set up / active). */
  voice?: AmbientWaveVoice;
  /** Whether TTS ("read aloud") is currently playing. */
  isTTSPlaying: boolean;
  /** Simulated TTS amplitude SharedValue (glides to 0 when not playing). */
  ttsWaveAmplitude: SharedValue<number>;
  /** Text-chat generation in flight (thinking or streaming) — gentle wave motion. */
  isGenerating?: boolean;
}

export interface UseAmbientWaveResult {
  /** Combined amplitude — max of idle breath, voice, TTS, and STT sources. */
  waveAmplitude: SharedValue<number>;
  /** Palette-driving state for the visualizer. */
  agentState: AgentState;
  /** Overlay opacity target — subtle at idle, prominent while there is speech. */
  intensity: number;
  /** Semantic label for the active source. */
  mode: AmbientWaveMode;
}

const IDLE_INTENSITY = 0.13;
const THINKING_INTENSITY = 0.2;
const ACTIVE_INTENSITY = 0.35;

/**
 * Combines every wave-amplitude source into one always-on ambient signal for a
 * single persistent overlay. Idle chat breathes subtly; a voice call, TTS
 * playback, or STT recording intensify it. Because every source glides to 0 when
 * inactive, `max(idleBreath, voice, tts, stt)` gives seamless cross-mode handoffs
 * with no remounts.
 *
 * All animation starts are imperative (via `useAnimatedReaction`) so they tick on
 * reanimated-web; the combiner is a pure-read `useDerivedValue`. Effect-free — no
 * React `useEffect`.
 */
export function useAmbientWave({ voice, isTTSPlaying, ttsWaveAmplitude, isGenerating }: UseAmbientWaveOptions): UseAmbientWaveResult {
  // ── Idle breath: subtle 0.04↔0.09 swell (~7s), started once on mount ──
  const idleBreath = useSharedValue(0.04);
  useAnimatedReaction(
    () => true,
    (_current, previous) => {
      if (previous !== null) return; // fire only on the initial run
      idleBreath.value = withRepeat(
        withSequence(
          withTiming(0.09, { duration: 3500, easing: Easing.inOut(Easing.sin) }),
          withTiming(0.04, { duration: 3500, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
      );
    },
    [],
  );

  // ── STT metering smoothing (floor 0.08, fast attack / slow decay, →0 on stop) ──
  const sttIsRecording = useSTTStore((s) => s.isRecording);
  const sttMetering = useSTTStore((s) => s.metering);
  const stt = useSharedValue(0);
  useAnimatedReaction(
    () => (sttIsRecording ? Math.max(0.08, sttMetering) : -1),
    (target) => {
      if (target < 0) {
        stt.value = withTiming(0, { duration: 300 });
        return;
      }
      const duration = target > stt.value ? 60 : 200;
      stt.value = withTiming(target, { duration, easing: Easing.bezier(0.33, 1, 0.68, 1) });
    },
    [sttIsRecording, sttMetering],
  );

  // ── Thinking/generating motion (text chat, no voice) — gentle oscillation ──
  const thinkingAmp = useSharedValue(0);
  useAnimatedReaction(
    () => isGenerating ?? false,
    (generating, previous) => {
      if (generating === previous) return;
      if (generating) {
        thinkingAmp.value = withRepeat(
          withSequence(
            withTiming(0.18, { duration: 1200, easing: Easing.inOut(Easing.sin) }),
            withTiming(0.08, { duration: 1200, easing: Easing.inOut(Easing.sin) }),
          ),
          -1,
        );
      } else {
        cancelAnimation(thinkingAmp);
        thinkingAmp.value = withTiming(0, { duration: 300 });
      }
    },
    [isGenerating],
  );

  // ── Combined amplitude — pure reads only (ticks on web) ──
  const voiceAmplitude = voice?.waveAmplitude;
  const waveAmplitude = useDerivedValue(
    () => Math.max(idleBreath.value, voiceAmplitude ? voiceAmplitude.value : 0, ttsWaveAmplitude.value, stt.value, thinkingAmp.value),
    [voiceAmplitude, ttsWaveAmplitude],
  );

  // ── Mode → palette state + overlay intensity (plain derived) ──
  return useMemo<UseAmbientWaveResult>(() => {
    if (voice?.isActive && voice.isConnected) {
      return { waveAmplitude, agentState: voice.agentState, intensity: ACTIVE_INTENSITY, mode: 'voice' };
    }
    if (isTTSPlaying) {
      return { waveAmplitude, agentState: 'speaking', intensity: ACTIVE_INTENSITY, mode: 'tts' };
    }
    if (sttIsRecording) {
      return { waveAmplitude, agentState: 'listening', intensity: ACTIVE_INTENSITY, mode: 'stt' };
    }
    if (isGenerating) {
      return { waveAmplitude, agentState: 'thinking', intensity: THINKING_INTENSITY, mode: 'thinking' };
    }
    return { waveAmplitude, agentState: 'idle', intensity: IDLE_INTENSITY, mode: 'idle' };
  }, [waveAmplitude, voice?.isActive, voice?.isConnected, voice?.agentState, isTTSPlaying, sttIsRecording, isGenerating]);
}
