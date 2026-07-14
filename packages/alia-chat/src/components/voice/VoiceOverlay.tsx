/**
 * Subtle wave overlay that renders the AudioWaveVisualizer behind the
 * conversation message list. Always mounted; `intensity` ramps the opacity
 * between a barely-there idle ambient and a prominent speaking state.
 */

import Animated, {
  FadeIn,
  FadeOut,
  useSharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { AudioWaveVisualizer } from './AudioWaveVisualizer';
import type { SharedValue } from 'react-native-reanimated';
import type { AgentState } from '../../types';

interface VoiceOverlayProps {
  waveAmplitude: SharedValue<number>;
  agentState: AgentState;
  /** Overlay opacity target (default 0.35); ramps over 500ms when it changes. */
  intensity?: number;
  isConnected?: boolean;
  primaryColor?: string;
  isDarkMode?: boolean;
}

export function VoiceOverlay({
  waveAmplitude,
  agentState,
  intensity = 0.35,
  isConnected = true,
  primaryColor,
  isDarkMode,
}: VoiceOverlayProps) {
  // Imperative opacity ramp (web-safe): mapper-started style animations don't
  // tick on reanimated-web, so drive a shared value via useAnimatedReaction.
  const opacity = useSharedValue(intensity);
  useAnimatedReaction(
    () => intensity,
    (target, previous) => {
      if (target === previous) return;
      opacity.value = withTiming(target, { duration: 500 });
    },
    [intensity],
  );
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      entering={FadeIn.duration(400)}
      exiting={FadeOut.duration(300)}
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 350,
        zIndex: 5,
        pointerEvents: 'none',
      }}
    >
      <Animated.View style={animatedStyle}>
        <AudioWaveVisualizer
          waveAmplitude={waveAmplitude}
          agentState={agentState}
          isConnected={isConnected}
          primaryColor={primaryColor}
          isDarkMode={isDarkMode}
        />
      </Animated.View>
    </Animated.View>
  );
}
