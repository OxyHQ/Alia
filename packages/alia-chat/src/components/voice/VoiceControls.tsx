/**
 * Bottom voice control bar that replaces the composer when voice mode is active.
 * Contains status text and Bloom's mute/end call controls.
 */

import { CallControls } from '@oxy.so/bloom/call-ui';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
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
  labels: labelOverrides,
}: VoiceControlsProps) {
  const labels = { ...VOICE_CONTROLS_LABELS, ...labelOverrides };
  const statusText = getStatusText(roomState, agentState, isMuted, labels);

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
        <CallControls
          muted={isMuted}
          onMutedChange={onToggleMute}
          onEndCall={onEnd}
          // TODO(bloom): `CallControls` draws its captions for a dark call stage, so on the
          // chat's light surface they vanish. The buttons keep their accessible names.
          labels={{ mute: labels.mute, unmute: labels.unmute, endCall: labels.end }}
        />
      ) : null}

      {roomState === 'connecting' ? <Loading accessibilityLabel={labels.connecting} /> : null}
    </View>
  );
}
