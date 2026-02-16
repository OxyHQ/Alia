import { useEffect } from 'react';
import { useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import type { AgentState } from '@/lib/hooks/use-voice-room';

interface UseAudioLevelsOptions {
  captureLevel: number;
  playbackLevel: number;
  agentState: AgentState;
  isConnected: boolean;
}

export function useAudioLevels({
  captureLevel,
  playbackLevel,
  agentState,
  isConnected,
}: UseAudioLevelsOptions) {
  const waveAmplitude = useSharedValue(0);

  useEffect(() => {
    if (!isConnected) {
      waveAmplitude.value = withTiming(0, { duration: 300 });
      return;
    }

    const amplifiedPlayback = Math.min(1, playbackLevel * 3);

    let target = 0;
    if (agentState === 'thinking') {
      target = Math.max(0.15, captureLevel);
    } else if (agentState === 'speaking') {
      // 0.4 baseline ensures visible waves while AI speaks
      target = Math.max(0.4, amplifiedPlayback, captureLevel * 0.5);
    } else if (agentState === 'listening') {
      // Subtle pulse while listening; mic level takes over when available
      target = Math.max(0.08, captureLevel, amplifiedPlayback * 0.5);
    } else {
      // Idle — calm, no minimum
      target = Math.max(captureLevel, amplifiedPlayback * 0.5);
    }

    // Fast attack, slower decay for natural VU-meter feel
    const duration = target > waveAmplitude.value ? 60 : 200;
    waveAmplitude.value = withTiming(target, {
      duration,
      easing: Easing.bezier(0.33, 1, 0.68, 1),
    });
  }, [captureLevel, playbackLevel, agentState, isConnected]);

  return { waveAmplitude };
}
