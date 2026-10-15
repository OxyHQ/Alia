/**
 * Bottom voice control bar that replaces the composer when voice mode is active: the status
 * text over Bloom's own `VoiceControls` (microphone and end), the controls of Bloom's voice
 * mode, not a call's.
 */

import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { VoiceControls as BloomVoiceControls, type VoiceState } from '@oxy.so/bloom/voice';
import { View } from 'react-native';
import type { RoomState, AgentState, VoiceCallState } from '../../types';

/** Every word the bar shows or announces. An app in another language passes its own. */
export interface VoiceControlsLabels {
  connecting: string;
  reconnecting: string;
  connected: string;
  listening: string;
  muted: string;
  thinking: string;
  usingTool: string;
  speaking: string;
  mute: string;
  unmute: string;
  end: string;
}

export const VOICE_CONTROLS_LABELS: VoiceControlsLabels = {
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
  connected: 'Connected',
  listening: 'Listening...',
  muted: 'Muted',
  thinking: 'Thinking...',
  usingTool: 'Working on it...',
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
  /**
   * Something the person should know while the call listens — e.g. that the
   * call is about to reach its time limit. Shown in place of "Listening…".
   */
  notice?: string | null;
  /**
   * The call's full state, when the host has it: a tool running reads as such
   * rather than as "Thinking…".
   */
  callState?: VoiceCallState;
  /** Overrides for any of {@link VOICE_CONTROLS_LABELS}. */
  labels?: Partial<VoiceControlsLabels>;
}

function getStatusText(
  roomState: RoomState,
  agentState: AgentState,
  isMuted: boolean,
  notice: string | null,
  labels: VoiceControlsLabels,
  callState: VoiceCallState | undefined,
): string {
  if (roomState === 'connecting') return labels.connecting;
  if (roomState === 'reconnecting') return labels.reconnecting;
  if (roomState === 'connected') {
    if (agentState === 'listening') return isMuted ? labels.muted : (notice ?? labels.listening);
    if (callState?.kind === 'using-tool') return labels.usingTool;
    if (agentState === 'thinking') return labels.thinking;
    if (agentState === 'speaking') return labels.speaking;
    return labels.connected;
  }
  return '';
}

/** What Bloom's voice controls call the call's state: the microphone is only live while it is. */
function voiceStateOf(roomState: RoomState, agentState: AgentState): VoiceState {
  if (roomState === 'error') return 'error';
  if (roomState !== 'connected') return 'idle';
  return agentState === 'idle' ? 'listening' : agentState;
}

export function VoiceControls({
  roomState,
  agentState,
  isMuted,
  onToggleMute,
  onEnd,
  notice = null,
  callState,
  labels: labelOverrides,
}: VoiceControlsProps) {
  const labels = { ...VOICE_CONTROLS_LABELS, ...labelOverrides };
  const statusText = getStatusText(roomState, agentState, isMuted, notice, labels, callState);

  return (
    <View className="items-center gap-4 pb-6 pt-4">
      {statusText ? (
        <Text
          className="text-lg font-medium text-text-primary"
          accessibilityLiveRegion="polite"
          aria-live="polite"
        >
          {statusText}
        </Text>
      ) : null}

      {roomState === 'connected' ? (
        <BloomVoiceControls
          state={voiceStateOf(roomState, agentState)}
          muted={isMuted}
          // Called with nothing: Bloom hands its handlers the next value or the press, and
          // `onToggleMute` / `onEnd` of a session take optional arguments of their own.
          onMutedChange={() => onToggleMute()}
          onEnd={() => onEnd()}
        />
      ) : null}

      {roomState === 'connecting' || roomState === 'reconnecting' ? (
        <Loading
          accessibilityLabel={roomState === 'connecting' ? labels.connecting : labels.reconnecting}
        />
      ) : null}
    </View>
  );
}
