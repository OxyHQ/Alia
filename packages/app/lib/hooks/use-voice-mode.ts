/**
 * Orchestration hook that bridges voice mode (LiveKit WebRTC) with the
 * text-based conversation. Adapts VoiceMessage objects into the unified
 * Message type and merges them into the shared message array so that
 * ChatInterface renders both text and voice messages seamlessly.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useVoiceRoom, type VoiceMessage, type RoomState, type AgentState } from '@/lib/hooks/use-voice-room';
import { useAudioLevelMonitor, useAudioLevels } from '@alia.onl/sdk/voice';
import { toast } from '@/components/sonner';
import type { Message } from '@/lib/hooks/use-conversations';

interface UseVoiceModeOptions {
  chatMessages: Message[];
  setMessages: (msgs: Message[] | ((prev: Message[]) => Message[])) => void;
  conversationId?: string;
  onDeactivate?: () => void;
}

/** Adapt a VoiceMessage into the canonical Message type. */
function adaptVoiceMessage(vm: VoiceMessage): Message {
  return {
    id: vm.id,
    role: vm.role,
    content: vm.content,
    source: 'voice',
    speaker: vm.speaker,
    isStreaming: vm.isStreaming,
    toolInvocations: vm.toolInvocations,
  };
}

export function useVoiceMode({ chatMessages, setMessages, conversationId, onDeactivate }: UseVoiceModeOptions) {
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const queryClient = useQueryClient();

  // Index in the messages array where voice messages start
  const voiceStartIndexRef = useRef<number>(0);
  // Snapshot of text messages when voice mode starts (to prevent overwrites)
  const textSnapshotRef = useRef<Message[]>([]);

  const voiceRoom = useVoiceRoom();
  const { captureLevel, playbackLevel } = useAudioLevelMonitor(voiceRoom.room, voiceRoom.isConnected);
  const { waveAmplitude } = useAudioLevels({
    captureLevel,
    playbackLevel,
    agentState: voiceRoom.agentState,
    isConnected: voiceRoom.isConnected,
  });

  // Merge voice messages into the shared messages array
  useEffect(() => {
    if (!isVoiceActive) return;

    const adapted = voiceRoom.messages.map(adaptVoiceMessage);
    setMessages([...textSnapshotRef.current, ...adapted]);
  }, [voiceRoom.messages, isVoiceActive, setMessages]);

  // Auto-deactivate on error or connection failure
  useEffect(() => {
    if (!isVoiceActive) return;
    if (voiceRoom.error) {
      toast.error(voiceRoom.error);
      deactivateVoice();
    } else if (voiceRoom.roomState === 'error') {
      toast.error('Voice connection failed');
      deactivateVoice();
    }
  }, [voiceRoom.error, voiceRoom.roomState, isVoiceActive]);

  // Auto-deactivate on unexpected disconnection
  useEffect(() => {
    if (!isVoiceActive) return;
    if (voiceRoom.roomState === 'disconnected' && voiceStartIndexRef.current > 0) {
      // Room disconnected while voice was active (network drop, session ended, etc.)
      deactivateVoice();
    }
  }, [voiceRoom.roomState, isVoiceActive]);

  const activateVoice = useCallback(() => {
    if (isVoiceActive || voiceRoom.roomState === 'connecting') return;

    voiceStartIndexRef.current = chatMessages.length;
    textSnapshotRef.current = [...chatMessages];
    setIsVoiceActive(true);
    voiceRoom.connect();
  }, [isVoiceActive, voiceRoom.roomState, chatMessages, voiceRoom]);

  const deactivateVoice = useCallback(() => {
    voiceRoom.disconnect();
    setIsVoiceActive(false);
    voiceStartIndexRef.current = 0;
    textSnapshotRef.current = [];

    // Invalidate credits since voice sessions consume credits
    queryClient.invalidateQueries({ queryKey: queryKeys.credits.info });

    // Trigger conversation save so voice transcripts are persisted
    onDeactivate?.();
  }, [voiceRoom, queryClient, onDeactivate]);

  return {
    // Voice state
    isVoiceActive,
    activateVoice,
    deactivateVoice,

    // Voice room state (for controls & overlay)
    roomState: voiceRoom.roomState,
    agentState: voiceRoom.agentState,
    isMuted: voiceRoom.isMuted,
    cohostActive: voiceRoom.cohostActive,
    currentSpeaker: voiceRoom.currentSpeaker,
    roundComplete: voiceRoom.roundComplete,
    isConnected: voiceRoom.isConnected,
    room: voiceRoom.room,

    // Voice room controls
    toggleMute: voiceRoom.toggleMute,
    enableCohost: voiceRoom.enableCohost,
    disableCohost: voiceRoom.disableCohost,
    continueCohost: voiceRoom.continueCohost,

    // Audio visualization
    waveAmplitude,
    captureLevel,
    playbackLevel,
  };
}
