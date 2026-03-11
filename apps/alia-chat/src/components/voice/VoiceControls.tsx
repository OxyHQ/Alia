/**
 * Bottom voice control bar that replaces PromptInput when voice mode is active.
 * Contains status text, mute/cohost/end buttons, and "Continue" for cohost rounds.
 */

import { useMemo } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { Mic, MicOff, PhoneOff, Users } from 'lucide-react-native';
import type { RoomState, AgentState } from '../../types';
import { useAliaColors } from '../../theme';

interface VoiceControlsProps {
  roomState: RoomState;
  agentState: AgentState;
  isMuted: boolean;
  cohostActive: boolean;
  currentSpeaker: 'primary' | 'cohost' | 'user' | null;
  roundComplete: boolean;
  onToggleMute: () => void;
  onEnableCohost: () => void;
  onDisableCohost: () => void;
  onContinueCohost: () => void;
  onEnd: () => void;
  /** Override theme primary color */
  primaryColor?: string;
}

function getStatusText(
  roomState: RoomState,
  agentState: AgentState,
  isMuted: boolean,
  cohostActive: boolean,
  currentSpeaker: string | null,
): string {
  if (roomState === 'connecting') return 'Connecting...';
  if (roomState === 'connected') {
    if (cohostActive && currentSpeaker === 'cohost') return 'Cohost speaking...';
    if (cohostActive && currentSpeaker === 'primary') return 'Alia speaking...';
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
  cohostActive,
  currentSpeaker,
  roundComplete,
  onToggleMute,
  onEnableCohost,
  onDisableCohost,
  onContinueCohost,
  onEnd,
  primaryColor,
}: VoiceControlsProps) {
  const aliaColors = useAliaColors();
  const colors = useMemo(
    () => (primaryColor ? { ...aliaColors, primary: primaryColor } : aliaColors),
    [primaryColor, aliaColors],
  );
  const statusText = getStatusText(roomState, agentState, isMuted, cohostActive, currentSpeaker);

  return (
    <View style={styles.container}>
      {statusText ? (
        <Text style={[styles.statusText, { color: colors.text }]}>
          {statusText}
        </Text>
      ) : null}

      {roundComplete && (
        <Pressable
          onPress={onContinueCohost}
          style={[styles.continueButton, { backgroundColor: colors.primary + '4D' }]}
        >
          <Text style={[styles.continueText, { color: colors.primary }]}>Continue conversation</Text>
        </Pressable>
      )}

      {roomState === 'connected' && (
        <View style={styles.buttonRow}>
          <View style={styles.buttonWrapper}>
            <Pressable
              onPress={onToggleMute}
              style={[
                styles.button,
                { backgroundColor: isMuted ? '#ef4444' : colors.muted },
              ]}
            >
              {isMuted ? (
                <MicOff size={24} color="white" />
              ) : (
                <Mic size={24} color="white" />
              )}
            </Pressable>
            <Text style={[styles.buttonLabel, { color: colors.mutedForeground }]}>
              {isMuted ? 'Unmute' : 'Mute'}
            </Text>
          </View>

          <View style={styles.buttonWrapper}>
            <Pressable
              onPress={cohostActive ? onDisableCohost : onEnableCohost}
              style={[
                styles.button,
                { backgroundColor: cohostActive ? colors.primary : colors.muted },
              ]}
            >
              <Users size={24} color="white" />
            </Pressable>
            <Text style={[styles.buttonLabel, { color: colors.mutedForeground }]}>
              {cohostActive ? 'Solo' : 'Cohost'}
            </Text>
          </View>

          <View style={styles.buttonWrapper}>
            <Pressable
              onPress={onEnd}
              style={[styles.button, { backgroundColor: '#ef4444' }]}
            >
              <PhoneOff size={24} color="white" />
            </Pressable>
            <Text style={[styles.buttonLabel, { color: colors.mutedForeground }]}>End</Text>
          </View>
        </View>
      )}

      {roomState === 'connecting' && (
        <ActivityIndicator size="large" color={colors.mutedForeground} />
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
  statusText: {
    fontSize: 18,
    fontWeight: '500',
    marginBottom: 16,
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
  buttonLabel: {
    fontSize: 12,
  },
  continueButton: {
    marginBottom: 16,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 24,
  },
  continueText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
