import { useEffect, useState, useCallback, useRef } from 'react';
import { View, Pressable, Modal, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Mic, MicOff, X, PhoneOff } from 'lucide-react-native';
import { useOxy } from '@oxyhq/services';
import config from '@/lib/config';

type VoiceState = 'idle' | 'connecting' | 'connected' | 'error';

interface VoiceChatProps {
  visible: boolean;
  onClose: () => void;
  conversationId?: string;
}

export function VoiceChat({ visible, onClose, conversationId }: VoiceChatProps) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<'listening' | 'thinking' | 'speaking' | 'idle'>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const { oxyServices } = useOxy();
  const roomRef = useRef<any>(null);
  const prevVisibleRef = useRef(visible);

  const connect = useCallback(async () => {
    try {
      setVoiceState('connecting');
      setError(null);

      // Get LiveKit token from our API
      const token = oxyServices.getAccessToken();
      const response = await fetch(`${config.apiUrl}/v1/voice/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ conversationId }),
      });

      if (!response.ok) {
        throw new Error('Failed to get voice token');
      }

      const { token: livekitToken, url, roomName } = await response.json();

      // Dynamic import to avoid issues when LiveKit isn't installed
      const { Room, RoomEvent, Track } = await import('livekit-client');

      const room = new Room();
      roomRef.current = room;

      // Listen for agent state changes via data messages
      room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
        try {
          const message = JSON.parse(new TextDecoder().decode(payload));
          if (message.type === 'agent-state') {
            setAgentState(message.state);
          }
        } catch {
          // Ignore non-JSON data
        }
      });

      // Track agent speaking state
      room.on(RoomEvent.TrackSubscribed, (track: any) => {
        if (track.kind === Track.Kind.Audio) {
          setAgentState('speaking');
          const audioElement = track.attach();
          if (typeof document !== 'undefined') {
            document.body.appendChild(audioElement);
          }
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track: any) => {
        if (track.kind === Track.Kind.Audio) {
          setAgentState('listening');
          track.detach().forEach((el: HTMLElement) => el.remove?.());
        }
      });

      room.on(RoomEvent.Disconnected, () => {
        setVoiceState('idle');
        setAgentState('idle');
      });

      // Connect to LiveKit room
      await room.connect(url, livekitToken);

      // Publish local microphone
      await room.localParticipant.setMicrophoneEnabled(true);

      setVoiceState('connected');
      setAgentState('listening');
    } catch (e: any) {
      console.error('[VoiceChat] Connection error:', e);
      setError(e.message || 'Failed to connect');
      setVoiceState('error');
    }
  }, [oxyServices, conversationId]);

  const disconnect = useCallback(() => {
    if (roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    setVoiceState('idle');
    setAgentState('idle');
    setError(null);
    setIsMuted(false);
  }, []);

  const toggleMute = useCallback(async () => {
    if (roomRef.current) {
      const newMuted = !isMuted;
      await roomRef.current.localParticipant.setMicrophoneEnabled(!newMuted);
      setIsMuted(newMuted);
    }
  }, [isMuted]);

  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      connect();
    } else if (!visible && prevVisibleRef.current) {
      disconnect();
    }
    prevVisibleRef.current = visible;
  }, [visible]);

  const handleClose = () => {
    disconnect();
    onClose();
  };

  const getStateText = () => {
    switch (voiceState) {
      case 'connecting': return 'Connecting...';
      case 'error': return 'Connection failed';
      case 'connected': {
        switch (agentState) {
          case 'listening': return isMuted ? 'Muted' : 'Listening...';
          case 'thinking': return 'Thinking...';
          case 'speaking': return 'Speaking...';
          default: return 'Connected';
        }
      }
      default: return 'Tap to connect';
    }
  };

  const getPulseColor = () => {
    if (voiceState !== 'connected') return '#6b7280';
    switch (agentState) {
      case 'listening': return isMuted ? '#6b7280' : '#22c55e';
      case 'thinking': return '#eab308';
      case 'speaking': return '#6366f1';
      default: return '#6b7280';
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View className="flex-1 bg-black/90 items-center justify-center">
        {/* Close button */}
        <Pressable onPress={handleClose} className="absolute top-14 right-6 p-2">
          <X size={24} color="white" />
        </Pressable>

        {/* Status text */}
        <Text className="text-white text-lg font-medium mb-8">{getStateText()}</Text>

        {/* Agent state indicator */}
        <View
          className="w-32 h-32 rounded-full items-center justify-center mb-8"
          style={{ backgroundColor: getPulseColor() + '30' }}
        >
          <View
            className="w-24 h-24 rounded-full items-center justify-center"
            style={{ backgroundColor: getPulseColor() + '60' }}
          >
            <View
              className="w-16 h-16 rounded-full items-center justify-center"
              style={{ backgroundColor: getPulseColor() }}
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
            {/* Mute button */}
            <Pressable
              onPress={toggleMute}
              className="w-14 h-14 rounded-full items-center justify-center"
              style={{ backgroundColor: isMuted ? '#ef4444' : '#374151' }}
            >
              {isMuted ? (
                <MicOff size={24} color="white" />
              ) : (
                <Mic size={24} color="white" />
              )}
            </Pressable>

            {/* Hang up button */}
            <Pressable
              onPress={handleClose}
              className="w-14 h-14 rounded-full bg-red-500 items-center justify-center"
            >
              <PhoneOff size={24} color="white" />
            </Pressable>
          </View>
        )}

        {/* Reconnect button on error */}
        {voiceState === 'error' && (
          <Pressable
            onPress={connect}
            className="mt-4 px-6 py-3 bg-indigo-500 rounded-full"
          >
            <Text className="text-white font-medium">Retry</Text>
          </Pressable>
        )}

        {/* Error */}
        {error ? (
          <Text className="text-red-400 text-sm mt-4">{error}</Text>
        ) : null}
      </View>
    </Modal>
  );
}
