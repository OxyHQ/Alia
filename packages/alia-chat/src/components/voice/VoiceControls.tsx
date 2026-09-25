/**
 * Bottom voice control bar that replaces the composer when voice mode is active.
 * Contains status text and mute/end buttons.
 */

import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import Mic from 'lucide-react-native/icons/mic';
import MicOff from 'lucide-react-native/icons/mic-off';
import PhoneOff from 'lucide-react-native/icons/phone-off';
import type { RoomState, AgentState } from '../../types';

/** Every word the bar shows or announces. An app in another language passes its own. */
export interface VoiceControlsLabels {
  connecting: string;
  connected: string;
  listening: string;
  muted: string;
  thinking: string;
  speaking: string;
  mute: string;
  unmute: string;
  end: string;
}

export const VOICE_CONTROLS_LABELS: VoiceControlsLabels = {
  connecting: 'Connecting...',
  connected: 'Connected',
  listening: 'Listening...',
  muted: 'Muted',
  thinking: 'Thinking...',
  speaking: 'Speaking...',
  mute: 'Mute',
  unmute: 'Unmute',
  end: 'End',
};

export interface VoiceControlsProps {
  roomState: RoomState;
  agentState: AgentState;
  isMuted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
  /** Override theme primary color (resolved hex/hsl value, not CSS var) */
  primaryColor?: string;
  /** Overrides for any of {@link VOICE_CONTROLS_LABELS}. */
  labels?: Partial<VoiceControlsLabels>;
}

function getStatusText(
  roomState: RoomState,
  agentState: AgentState,
  isMuted: boolean,
  labels: VoiceControlsLabels,
): string {
  if (roomState === 'connecting') return labels.connecting;
  if (roomState === 'connected') {
    if (agentState === 'listening') return isMuted ? labels.muted : labels.listening;
    if (agentState === 'thinking') return labels.thinking;
    if (agentState === 'speaking') return labels.speaking;
    return labels.connected;
  }
  return '';
}

export function VoiceControls({
  roomState,
  agentState,
  isMuted,
  onToggleMute,
  onEnd,
  primaryColor,
  labels: labelOverrides,
}: VoiceControlsProps) {
  const labels = { ...VOICE_CONTROLS_LABELS, ...labelOverrides };
  const statusText = getStatusText(roomState, agentState, isMuted, labels);

  return (
    <View style={styles.container}>
      {statusText ? (
        <Text className="text-lg font-medium mb-4 text-foreground" accessibilityLiveRegion="polite" aria-live="polite">
          {statusText}
        </Text>
      ) : null}

      {roomState === 'connected' && (
        <View style={styles.buttonRow}>
          <View style={styles.buttonWrapper}>
            <Pressable
              onPress={onToggleMute}
              accessibilityRole="button"
              accessibilityLabel={labels.mute}
              accessibilityState={{ selected: isMuted }}
              aria-pressed={isMuted}
              className={isMuted ? undefined : 'bg-muted'}
              style={[styles.button, isMuted ? { backgroundColor: '#ef4444' } : undefined]}
            >
              {isMuted ? (
                <MicOff size={24} color="white" />
              ) : (
                <Mic size={24} color="white" />
              )}
            </Pressable>
            <Text className="text-xs text-muted-foreground">
              {isMuted ? labels.unmute : labels.mute}
            </Text>
          </View>

          <View style={styles.buttonWrapper}>
            <Pressable
              onPress={onEnd}
              accessibilityRole="button"
              accessibilityLabel={labels.end}
              style={[styles.button, { backgroundColor: '#ef4444' }]}
            >
              <PhoneOff size={24} color="white" />
            </Pressable>
            <Text className="text-xs text-muted-foreground">{labels.end}</Text>
          </View>
        </View>
      )}

      {roomState === 'connecting' && (
        <ActivityIndicator size="large" className="text-muted-foreground" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingBottom: 24,
    paddingTop: 16,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 32,
  },
  buttonWrapper: {
    alignItems: 'center',
    gap: 8,
  },
  button: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
