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
import { toast } from '@oxy.so/bloom/toast';
import type { Message } from '@/lib/hooks/use-conversations';

interface UseVoiceModeOptions {
  chatMessages: Message[];
  setMessages: (msgs: Message[] | ((prev: Message[]) => Message[])) => void;
  conversationId?: string;
  /**
   * The agent whose thread this is, when there is one.
   *
   * NOT `voiceRoom.agentState`, which is LiveKit's voice-agent connection state
   * and shares nothing with this but the word.
   */
  agentId?: string;
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

export function useVoiceMode({ chatMessages, setMessages, conversationId, agentId, onDeactivate }: UseVoiceModeOptions) {
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const queryClient = useQueryClient();

  // Snapshot of text messages when voice mode starts (to prevent overwrites)
  const textSnapshotRef = useRef<Message[]>([]);
  /**
   * Whether this activation ever reached a room.
   *
   * `disconnected` is not only how a call ENDS, it is also where every call
   * STARTS: `activateVoice` flips `isVoiceActive` and asks the room to connect,
   * and until that connect lands the room still reports `disconnected`. So the
   * unexpected-disconnection effect below needs something to tell "we have not
   * connected yet" from "we were connected and lost it".
   *
   * It used to ask `voiceStartIndexRef.current > 0` — the count of text
   * messages on screen when the call began. That is a fact about the
   * TRANSCRIPT, not about the room, and it reads as zero for a call started
   * from an empty chat, which is the ordinary way to start one. Those calls
   * could never auto-deactivate: the room dropped, the effect declined to act,
   * and the person was left with a live voice UI over a room that was gone.
   *
   * This asks the room instead, so it is right for a call from zero messages
   * and a call from a long history alike.
   */
  const hasConnectedRef = useRef(false);

  const voiceRoom = useVoiceRoom(agentId);
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
    if (voiceRoom.roomState === 'connected') {
      hasConnectedRef.current = true;
      return;
    }
    if (voiceRoom.roomState === 'disconnected' && hasConnectedRef.current) {
      // Room disconnected while voice was active (network drop, session ended, etc.)
      deactivateVoice();
    }
  }, [voiceRoom.roomState, isVoiceActive]);

  const activateVoice = useCallback(() => {
    if (isVoiceActive || voiceRoom.roomState === 'connecting') return;

    hasConnectedRef.current = false;
    textSnapshotRef.current = [...chatMessages];
    setIsVoiceActive(true);
    voiceRoom.connect();
  }, [isVoiceActive, voiceRoom.roomState, chatMessages, voiceRoom]);

  const deactivateVoice = useCallback(() => {
    voiceRoom.disconnect();
    setIsVoiceActive(false);
    hasConnectedRef.current = false;
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
