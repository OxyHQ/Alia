import { useEffect, useRef } from 'react';
import { View, Pressable, Modal, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Mic, MicOff, X, PhoneOff } from 'lucide-react-native';
import { useRealtimeVoice, type AgentState } from '@/lib/hooks/use-realtime-voice';

interface VoiceChatProps {
  visible: boolean;
  onClose: () => void;
  conversationId?: string;
}

const AGENT_COLORS: Record<AgentState, string> = {
  idle: '#6b7280',
  listening: '#22c55e',
  thinking: '#eab308',
  speaking: '#6366f1',
};

export function VoiceChat({ visible, onClose }: VoiceChatProps) {
  const {
    voiceState,
    agentState,
    isMuted,
    error,
    connect,
    disconnect,
    toggleMute,
  } = useRealtimeVoice();

  const prevVisibleRef = useRef(visible);

  useEffect(() => {
    if (visible && !prevVisibleRef.current) connect();
    else if (!visible && prevVisibleRef.current) disconnect();
    prevVisibleRef.current = visible;
  }, [visible, connect, disconnect]);

  const handleClose = () => {
    disconnect();
    onClose();
  };

  const statusText = (() => {
    if (voiceState === 'connecting') return 'Connecting...';
    if (voiceState === 'error') return 'Connection failed';
    if (voiceState === 'connected') {
      if (agentState === 'listening') return isMuted ? 'Muted' : 'Listening...';
      if (agentState === 'thinking') return 'Thinking...';
      if (agentState === 'speaking') return 'Speaking...';
      return 'Connected';
    }
    return 'Tap to connect';
  })();

  const pulseColor =
    voiceState !== 'connected'
      ? '#6b7280'
      : isMuted && agentState === 'listening'
        ? '#6b7280'
        : AGENT_COLORS[agentState];

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View className="flex-1 bg-black/90 items-center justify-center">
        <Pressable onPress={handleClose} className="absolute top-14 right-6 p-2">
          <X size={24} color="white" />
        </Pressable>

        <Text className="text-white text-lg font-medium mb-8">{statusText}</Text>

        {/* Pulse indicator */}
        <View
          className="w-32 h-32 rounded-full items-center justify-center mb-8"
          style={{ backgroundColor: pulseColor + '30' }}
        >
          <View
            className="w-24 h-24 rounded-full items-center justify-center"
            style={{ backgroundColor: pulseColor + '60' }}
          >
            <View
              className="w-16 h-16 rounded-full items-center justify-center"
              style={{ backgroundColor: pulseColor }}
            >
              {voiceState === 'connecting' ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Mic size={28} color="white" />
              )}
            </View>
          </View>
        </View>

        {/* Controls */}
        {voiceState === 'connected' && (
          <View className="flex-row items-center gap-8">
            <Pressable
              onPress={toggleMute}
              className="w-14 h-14 rounded-full items-center justify-center"
              style={{ backgroundColor: isMuted ? '#ef4444' : '#374151' }}
            >
              {isMuted ? <MicOff size={24} color="white" /> : <Mic size={24} color="white" />}
            </Pressable>
            <Pressable
              onPress={handleClose}
              className="w-14 h-14 rounded-full bg-red-500 items-center justify-center"
            >
              <PhoneOff size={24} color="white" />
            </Pressable>
          </View>
        )}

        {voiceState === 'error' && (
          <Pressable onPress={connect} className="mt-4 px-6 py-3 bg-indigo-500 rounded-full">
            <Text className="text-white font-medium">Retry</Text>
          </Pressable>
        )}

        {error ? <Text className="text-red-400 text-sm mt-4">{error}</Text> : null}
      </View>
    </Modal>
  );
}
