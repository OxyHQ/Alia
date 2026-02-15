import { useEffect, useRef } from 'react';
import { View, Pressable, Modal, ActivityIndicator, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { Mic, MicOff, X, PhoneOff } from 'lucide-react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useRealtimeVoice, type AgentState } from '@/lib/hooks/use-realtime-voice';
import { useAudioLevels } from './voice-chat/use-audio-levels';
import { AudioWaveVisualizer } from './voice-chat/audio-wave-visualizer';
import { toast } from '@/components/sonner';

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

const CLOSE_BTN_MARGIN = 16;

export function VoiceChat({ visible, onClose }: VoiceChatProps) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const {
    voiceState,
    agentState,
    isMuted,
    error,
    messages,
    connect,
    disconnect,
    toggleMute,
    captureLevel,
    playbackLevel,
  } = useRealtimeVoice();

  const { waveAmplitude } = useAudioLevels({
    captureLevel,
    playbackLevel,
    agentState,
    isConnected: voiceState === 'connected',
  });

  const prevVisibleRef = useRef(visible);
  const scrollViewRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (visible && !prevVisibleRef.current) connect();
    else if (!visible && prevVisibleRef.current) disconnect();
    prevVisibleRef.current = visible;
  }, [visible, connect, disconnect]);

  // Auto-close on fatal errors (insufficient credits, auth failures)
  useEffect(() => {
    if (!error || !visible) return;
    const lower = error.toLowerCase();
    if (lower.includes('insufficient') || lower.includes('credit') || lower.includes('unauthorized') || lower.includes('not authenticated')) {
      toast.error(error);
      disconnect();
      onClose();
    }
  }, [error, visible, disconnect, onClose]);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 50);
    }
  }, [messages]);

  const handleClose = () => {
    disconnect();
    queryClient.invalidateQueries({ queryKey: ['credits'] });
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
      <View className="flex-1 bg-black/90">
        {/* Close button — top-right corner, equal margin from safe area and right edge */}
        <Pressable
          onPress={handleClose}
          className="absolute w-10 h-10 rounded-full items-center justify-center z-10"
          style={{
            top: insets.top + CLOSE_BTN_MARGIN,
            right: CLOSE_BTN_MARGIN,
            backgroundColor: 'rgba(255,255,255,0.12)',
          }}
        >
          <X size={20} color="white" />
        </Pressable>

        {/* Transcript area */}
        <ScrollView
          ref={scrollViewRef}
          className="flex-1 px-6"
          contentContainerStyle={{ paddingVertical: 16 }}
          showsVerticalScrollIndicator={false}
        >
          {messages.map((msg) => (
            <View
              key={msg.id}
              className={`mb-3 max-w-[85%] ${
                msg.role === 'user' ? 'self-end' : 'self-start'
              }`}
            >
              <Text
                className={`text-base ${
                  msg.role === 'user'
                    ? 'text-white/60'
                    : msg.isStreaming
                      ? 'text-white/90'
                      : 'text-white'
                }`}
              >
                {msg.content}
                {msg.isStreaming ? '\u258C' : ''}
              </Text>
            </View>
          ))}
        </ScrollView>

        {/* Bottom: ambient glow + controls */}
        <View style={{ position: 'relative', overflow: 'visible' }}>
          {/* Full-width ambient glow background */}
          <View
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              overflow: 'visible',
            }}
          >
            <AudioWaveVisualizer
              waveAmplitude={waveAmplitude}
              agentState={agentState}
              isConnected={voiceState === 'connected'}
            />
          </View>

          {/* Controls overlaid on glow */}
          <View style={{ alignItems: 'center', paddingBottom: 48, paddingTop: 24, zIndex: 1 }}>
            {/* Status text */}
            <Text className="text-white text-lg font-medium mb-6">
              {statusText}
            </Text>

            {/* Controls */}
            {voiceState === 'connected' && (
              <View className="flex-row items-center gap-10">
                <View className="items-center gap-2">
                  <Pressable
                    onPress={toggleMute}
                    className="w-14 h-14 rounded-full items-center justify-center"
                    style={{ backgroundColor: isMuted ? '#ef4444' : 'rgba(255,255,255,0.15)' }}
                  >
                    {isMuted ? (
                      <MicOff size={24} color="white" />
                    ) : (
                      <Mic size={24} color="white" />
                    )}
                  </Pressable>
                  <Text className="text-white/70 text-xs">
                    {isMuted ? 'Unmute' : 'Mute'}
                  </Text>
                </View>
                <View className="items-center gap-2">
                  <Pressable
                    onPress={handleClose}
                    className="w-14 h-14 rounded-full items-center justify-center"
                    style={{ backgroundColor: '#ef4444' }}
                  >
                    <PhoneOff size={24} color="white" />
                  </Pressable>
                  <Text className="text-white/70 text-xs">End</Text>
                </View>
              </View>
            )}

            {voiceState === 'connecting' && (
              <ActivityIndicator size="large" color="#38bdf8" />
            )}

            {voiceState === 'error' && (
              <Pressable
                onPress={connect}
                className="mt-4 px-6 py-3 bg-indigo-500 rounded-full"
              >
                <Text className="text-white font-medium">Retry</Text>
              </Pressable>
            )}

            {error ? (
              <Text className="text-red-400 text-sm mt-4">{error}</Text>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}
