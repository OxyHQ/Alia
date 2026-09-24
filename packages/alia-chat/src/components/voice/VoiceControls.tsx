/**
 * Bottom voice control bar that replaces the composer when voice mode is active.
 * Contains status text and mute/end buttons.
 */

import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import Mic from 'lucide-react-native/icons/mic';
import MicOff from 'lucide-react-native/icons/mic-off';
import PhoneOff from 'lucide-react-native/icons/phone-off';
import type { RoomState, AgentState } from '../../types';

interface VoiceControlsProps {
  roomState: RoomState;
  agentState: AgentState;
  isMuted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
  /** Override theme primary color (resolved hex/hsl value, not CSS var) */
  primaryColor?: string;
}

function getStatusText(
  roomState: RoomState,
  agentState: AgentState,
  isMuted: boolean,
): string {
  if (roomState === 'connecting') return 'Connecting...';
  if (roomState === 'connected') {
    if (agentState === 'listening') return isMuted ? 'Muted' : 'Listening...';
    if (agentState === 'thinking') return 'Thinking...';
    if (agentState === 'speaking') return 'Speaking...';
    return 'Connected';
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
}: VoiceControlsProps) {
  const statusText = getStatusText(roomState, agentState, isMuted);

  return (
    <View style={styles.container}>
      {statusText ? (
        <Text className="text-lg font-medium mb-4 text-foreground">
          {statusText}
        </Text>
      ) : null}

      {roomState === 'connected' && (
        <View style={styles.buttonRow}>
          <View style={styles.buttonWrapper}>
            <Pressable
              onPress={onToggleMute}
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
              {isMuted ? 'Unmute' : 'Mute'}
            </Text>
          </View>

          <View style={styles.buttonWrapper}>
            <Pressable
              onPress={onEnd}
              style={[styles.button, { backgroundColor: '#ef4444' }]}
            >
              <PhoneOff size={24} color="white" />
            </Pressable>
            <Text className="text-xs text-muted-foreground">End</Text>
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
