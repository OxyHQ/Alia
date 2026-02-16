import { useEffect, useRef } from 'react';
import { View, Pressable, Modal, ActivityIndicator, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { Mic, MicOff, X, PhoneOff, Users } from 'lucide-react-native';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useVoiceRoom } from '@/lib/hooks/use-voice-room';
import { useAudioLevels } from './voice-chat/use-audio-levels';
import { AudioWaveVisualizer } from './voice-chat/audio-wave-visualizer';
import { toast } from '@/components/sonner';

interface VoiceChatProps {
  visible: boolean;
  onClose: () => void;
  conversationId?: string;
}

const CLOSE_BTN_MARGIN = 16;

export function VoiceChat({ visible, onClose }: VoiceChatProps) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const {
    roomState,
    agentState,
    isMuted,
    error,
    messages,
    connect,
    disconnect,
    toggleMute,
    cohostActive,
    currentSpeaker,
    roundComplete,
    enableCohost,
    disableCohost,
    continueCohost,
  } = useVoiceRoom();

  const { waveAmplitude } = useAudioLevels({
    captureLevel: 0,
    playbackLevel: 0,
    agentState,
    isConnected: roomState === 'connected',
  });

  const prevVisibleRef = useRef(visible);
  const scrollViewRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (visible && !prevVisibleRef.current) connect();
    else if (!visible && prevVisibleRef.current) disconnect();
    prevVisibleRef.current = visible;
  }, [visible, connect, disconnect]);

  // On any error or connection failure → close modal + toast
  useEffect(() => {
    if (!visible) return;
    if (error) {
      toast.error(error);
      handleClose();
    } else if (roomState === 'error') {
      toast.error('Voice connection failed');
      handleClose();
    }
  }, [error, roomState, visible]);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 50);
    }
  }, [messages]);

  const handleClose = () => {
    disconnect();
    queryClient.invalidateQueries({ queryKey: queryKeys.credits.info });
    onClose();
  };

  const statusText = (() => {
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
  })();

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View className="flex-1 bg-black/90">
        {/* Close button */}
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
              {msg.role === 'assistant' && cohostActive && (
                <Text
                  className="text-xs mb-0.5"
                  style={{ color: msg.speaker === 'cohost' ? '#a78bfa' : '#94a3b8' }}
                >
                  {msg.speaker === 'cohost' ? 'Cohost' : 'Alia'}
                </Text>
              )}
              <Text
                className={`text-base ${
                  msg.role === 'user'
                    ? 'text-white/60'
                    : msg.speaker === 'cohost'
                      ? msg.isStreaming ? 'text-indigo-300/90' : 'text-indigo-300'
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

          {roundComplete && (
            <Pressable
              onPress={continueCohost}
              className="self-center mt-4 px-5 py-2 rounded-full"
              style={{ backgroundColor: 'rgba(139, 92, 246, 0.3)' }}
            >
              <Text className="text-indigo-300 text-sm font-medium">Continue conversation</Text>
            </Pressable>
          )}
        </ScrollView>

        {/* Bottom: ambient glow + controls */}
        <View style={{ position: 'relative', overflow: 'visible' }}>
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
              isConnected={roomState === 'connected'}
            />
          </View>

          <View style={{ alignItems: 'center', paddingBottom: 48, paddingTop: 24, zIndex: 1 }}>
            {statusText ? (
              <Text className="text-white text-lg font-medium mb-6">
                {statusText}
              </Text>
            ) : null}

            {roomState === 'connected' && (
              <View className="flex-row items-center gap-8">
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
                    onPress={cohostActive ? disableCohost : enableCohost}
                    className="w-14 h-14 rounded-full items-center justify-center"
                    style={{ backgroundColor: cohostActive ? '#8b5cf6' : 'rgba(255,255,255,0.15)' }}
                  >
                    <Users size={24} color="white" />
                  </Pressable>
                  <Text className="text-white/70 text-xs">
                    {cohostActive ? 'Solo' : 'Cohost'}
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

            {roomState === 'connecting' && (
              <ActivityIndicator size="large" color="#38bdf8" />
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}
