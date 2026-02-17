/**
 * Bottom voice control bar that replaces PromptInput when voice mode is active.
 * Contains status text, mute/cohost/end buttons, and "Continue" for cohost rounds.
 */

import { View, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Mic, MicOff, PhoneOff, Users } from 'lucide-react-native';
import type { RoomState, AgentState } from '@/lib/hooks/use-voice-room';

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
  const statusText = getStatusText(roomState, agentState, isMuted, cohostActive, currentSpeaker);

  return (
    <View style={{ alignItems: 'center', paddingBottom: 24, paddingTop: 16 }}>
      {statusText ? (
        <Text className="text-foreground text-lg font-medium mb-4">
          {statusText}
        </Text>
      ) : null}

      {roundComplete && (
        <Pressable
          onPress={onContinueCohost}
          className="mb-4 px-5 py-2 rounded-full"
          style={{ backgroundColor: 'rgba(139, 92, 246, 0.3)' }}
        >
          <Text className="text-indigo-300 text-sm font-medium">Continue conversation</Text>
        </Pressable>
      )}

      {roomState === 'connected' && (
        <View className="flex-row items-center gap-8">
          <View className="items-center gap-2">
            <Pressable
              onPress={onToggleMute}
              className="w-14 h-14 rounded-full items-center justify-center"
              style={{ backgroundColor: isMuted ? '#ef4444' : 'rgba(255,255,255,0.15)' }}
            >
              {isMuted ? (
                <MicOff size={24} color="white" />
              ) : (
                <Mic size={24} color="white" />
              )}
            </Pressable>
            <Text className="text-muted-foreground text-xs">
              {isMuted ? 'Unmute' : 'Mute'}
            </Text>
          </View>

          <View className="items-center gap-2">
            <Pressable
              onPress={cohostActive ? onDisableCohost : onEnableCohost}
              className="w-14 h-14 rounded-full items-center justify-center"
              style={{ backgroundColor: cohostActive ? '#8b5cf6' : 'rgba(255,255,255,0.15)' }}
            >
              <Users size={24} color="white" />
            </Pressable>
            <Text className="text-muted-foreground text-xs">
              {cohostActive ? 'Solo' : 'Cohost'}
            </Text>
          </View>

          <View className="items-center gap-2">
            <Pressable
              onPress={onEnd}
              className="w-14 h-14 rounded-full items-center justify-center"
              style={{ backgroundColor: '#ef4444' }}
            >
              <PhoneOff size={24} color="white" />
            </Pressable>
            <Text className="text-muted-foreground text-xs">End</Text>
          </View>
        </View>
      )}

      {roomState === 'connecting' && (
        <ActivityIndicator size="large" color="#38bdf8" />
      )}
    </View>
  );
}
