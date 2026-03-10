/**
 * Bottom voice control bar that replaces PromptInput when voice mode is active.
 * Contains status text, mute/cohost/end buttons, and "Continue" for cohost rounds.
 */

import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
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
}: VoiceControlsProps) {
  const colors = useAliaColors();
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
          style={styles.continueButton}
        >
          <Text style={styles.continueText}>Continue conversation</Text>
        </Pressable>
      )}

      {roomState === 'connected' && (
        <View style={styles.buttonRow}>
          <View style={styles.buttonWrapper}>
            <Pressable
              onPress={onToggleMute}
              style={[
                styles.button,
                { backgroundColor: isMuted ? '#ef4444' : 'rgba(255,255,255,0.15)' },
              ]}
            >
              <Text style={styles.buttonIcon}>
                {isMuted ? '\u{1F507}' : '\u{1F3A4}'}
              </Text>
            </Pressable>
            <Text style={styles.buttonLabel}>
              {isMuted ? 'Unmute' : 'Mute'}
            </Text>
          </View>

          <View style={styles.buttonWrapper}>
            <Pressable
              onPress={cohostActive ? onDisableCohost : onEnableCohost}
              style={[
                styles.button,
                { backgroundColor: cohostActive ? '#8b5cf6' : 'rgba(255,255,255,0.15)' },
              ]}
            >
              <Text style={styles.buttonIcon}>{'\u{1F465}'}</Text>
            </Pressable>
            <Text style={styles.buttonLabel}>
              {cohostActive ? 'Solo' : 'Cohost'}
            </Text>
          </View>

          <View style={styles.buttonWrapper}>
            <Pressable
              onPress={onEnd}
              style={[styles.button, { backgroundColor: '#ef4444' }]}
            >
              <Text style={styles.endIcon}>{'\u2715'}</Text>
            </Pressable>
            <Text style={styles.buttonLabel}>End</Text>
          </View>
        </View>
      )}

      {roomState === 'connecting' && (
        <ActivityIndicator size="large" color="#38bdf8" />
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
  buttonIcon: {
    fontSize: 24,
  },
  endIcon: {
    fontSize: 24,
    color: '#ffffff',
    fontWeight: '700',
  },
  buttonLabel: {
    color: '#8E8E93',
    fontSize: 12,
  },
  continueButton: {
    marginBottom: 16,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 24,
    backgroundColor: 'rgba(139, 92, 246, 0.3)',
  },
  continueText: {
    color: '#a78bfa',
    fontSize: 14,
    fontWeight: '500',
  },
});
