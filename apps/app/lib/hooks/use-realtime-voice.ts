/**
 * Hook for real-time bidirectional voice conversations.
 *
 * Connects to the /v1/realtime WebSocket endpoint and streams
 * audio bidirectionally using the Realtime API protocol
 * (compatible with OpenAI, Grok, and other providers).
 *
 * Usage:
 *   const { connect, disconnect, toggleMute, voiceState, agentState, isMuted, error } = useRealtimeVoice();
 *   // Call connect() on user gesture, disconnect() to end
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useOxy } from '@oxyhq/services';
import config from '../config';
import { RealtimeClient, type RealtimeState } from '../realtime/realtime-client';
import { AudioPipeline } from '../realtime/audio-pipeline';

export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface VoiceMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  isStreaming: boolean;
}

export function useRealtimeVoice() {
  const [voiceState, setVoiceState] = useState<RealtimeState>('disconnected');
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const currentAiTextRef = useRef<string>('');
  const msgIdRef = useRef(0);
  const { oxyServices } = useOxy();

  const clientRef = useRef<RealtimeClient | null>(null);
  const pipelineRef = useRef<AudioPipeline | null>(null);

  const cleanup = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    pipelineRef.current?.destroy();
    pipelineRef.current = null;
  }, []);

  const connect = useCallback(async () => {
    try {
      setError(null);

      const token = oxyServices.getAccessToken();
      if (!token) {
        setError('Not authenticated');
        return;
      }

      // Create audio pipeline first (requires user gesture for mic permission)
      const pipeline = new AudioPipeline({
        onCapturedAudio: (base64) => {
          clientRef.current?.sendAudio(base64);
        },
      });
      pipelineRef.current = pipeline;
      await pipeline.start();

      // Create and connect the realtime client
      const client = new RealtimeClient(
        { apiUrl: config.apiUrl, token, model: 'alia-v1-voice' },
        {
          onStateChange: (state) => {
            setVoiceState(state);
            if (state === 'connected') setAgentState('listening');
            if (state === 'disconnected' || state === 'error') setAgentState('idle');
          },
          onAudioDelta: (base64) => {
            setAgentState('speaking');
            pipeline.playAudio(base64);
          },
          onTranscriptDelta: (delta) => {
            currentAiTextRef.current += delta;
            const text = currentAiTextRef.current;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant' && last.isStreaming) {
                return [...prev.slice(0, -1), { ...last, content: text }];
              }
              msgIdRef.current++;
              return [...prev, { id: `vm-${msgIdRef.current}`, role: 'assistant', content: text, timestamp: Date.now(), isStreaming: true }];
            });
          },
          onTranscriptDone: (transcript) => {
            currentAiTextRef.current = '';
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant' && last.isStreaming) {
                return [...prev.slice(0, -1), { ...last, content: transcript, isStreaming: false }];
              }
              return prev;
            });
          },
          onUserTranscriptCompleted: (transcript) => {
            if (!transcript.trim()) return;
            msgIdRef.current++;
            setMessages((prev) => [...prev, { id: `vm-${msgIdRef.current}`, role: 'user', content: transcript.trim(), timestamp: Date.now(), isStreaming: false }]);
          },
          onSpeechStarted: () => {
            setAgentState('listening');
            pipeline.clearPlayback(); // Barge-in: stop current response
            // Finalize any in-progress AI transcript
            if (currentAiTextRef.current) {
              const partial = currentAiTextRef.current;
              currentAiTextRef.current = '';
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'assistant' && last.isStreaming) {
                  return [...prev.slice(0, -1), { ...last, content: partial, isStreaming: false }];
                }
                return prev;
              });
            }
          },
          onSpeechStopped: () => {
            setAgentState('thinking');
          },
          onResponseCreated: () => {
            setAgentState('thinking');
          },
          onResponseDone: () => {
            setAgentState('listening');
          },
          onError: (message) => {
            setError(message);
          },
        },
      );
      clientRef.current = client;
      client.connect();
    } catch (e: any) {
      console.error('[useRealtimeVoice] Connection error:', e);
      setError(e.message || 'Failed to connect');
      setVoiceState('error');
      cleanup();
    }
  }, [oxyServices, cleanup]);

  const disconnect = useCallback(() => {
    cleanup();
    setVoiceState('disconnected');
    setAgentState('idle');
    setError(null);
    setIsMuted(false);
    setMessages([]);
    currentAiTextRef.current = '';
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    const next = !isMuted;
    pipelineRef.current?.setMuted(next);
    setIsMuted(next);
  }, [isMuted]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  return {
    voiceState,
    agentState,
    isMuted,
    error,
    messages,
    connect,
    disconnect,
    toggleMute,
    isConnected: voiceState === 'connected',
  };
}
