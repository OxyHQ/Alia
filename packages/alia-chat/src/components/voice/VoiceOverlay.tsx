/**
 * Subtle voice mode overlay that renders the AudioWaveVisualizer
 * behind the conversation message list. Preserves the normal chat theme
 * with waves at reduced opacity for a seamless visual experience.
 */

import { View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { AudioWaveVisualizer } from './AudioWaveVisualizer';
import type { SharedValue } from 'react-native-reanimated';
import type { AgentState } from '../../types';

interface VoiceOverlayProps {
  waveAmplitude: SharedValue<number>;
  agentState: AgentState;
  isConnected: boolean;
  primaryColor?: string;
  isDarkMode?: boolean;
}

export function VoiceOverlay({ waveAmplitude, agentState, isConnected, primaryColor, isDarkMode }: VoiceOverlayProps) {
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
      <View style={{ opacity: 0.35 }}>
        <AudioWaveVisualizer
          waveAmplitude={waveAmplitude}
          agentState={agentState}
          isConnected={isConnected}
          primaryColor={primaryColor}
          isDarkMode={isDarkMode}
        />
      </View>
    </Animated.View>
  );
}
