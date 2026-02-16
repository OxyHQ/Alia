/**
 * Hook for real-time voice conversations via LiveKit rooms.
 *
 * Connects to a LiveKit room (created by POST /v1/voice/token),
 * publishes the user's microphone, and receives agent audio + data
 * messages (transcripts, state, cohost events) over WebRTC.
 *
 * Replaces the old useRealtimeVoice hook which used a direct WebSocket proxy.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  DisconnectReason,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type DataPublishOptions,
} from 'livekit-client';
import { useOxy } from '@oxyhq/services';
import config from '../config';
import { stripTitleTags, stripTitleTagsPartial } from '../utils/title-tags';

// ============== TYPES ==============

export type RoomState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface VoiceMessage {
  id: string;
  role: 'user' | 'assistant';
  speaker?: 'primary' | 'cohost';
  content: string;
  timestamp: number;
  isStreaming: boolean;
}

// Agent data message types (must match backend AgentDataMessage)
interface AgentStateMsg { type: 'agent.state'; state: 'listening' | 'thinking' | 'speaking'; speaker: 'primary' | 'cohost' }
interface TranscriptDeltaMsg { type: 'transcript.delta'; delta: string; speaker: 'primary' | 'cohost' }
interface TranscriptDoneMsg { type: 'transcript.done'; transcript: string; speaker: 'primary' | 'cohost' }
interface TranscriptUserMsg { type: 'transcript.user'; transcript: string }
interface CohostEnabledMsg { type: 'cohost.enabled' }
interface CohostDisabledMsg { type: 'cohost.disabled' }
interface CohostTurnMsg { type: 'cohost.turn_changed'; speaker: 'primary' | 'cohost' | 'user' }
interface CohostRoundMsg { type: 'cohost.round_complete'; turns: number }
interface SessionEndedMsg { type: 'session.ended'; reason: string }
interface ErrorMsg { type: 'error'; code: string; message: string }

type AgentDataMessage =
  | AgentStateMsg | TranscriptDeltaMsg | TranscriptDoneMsg | TranscriptUserMsg
  | CohostEnabledMsg | CohostDisabledMsg | CohostTurnMsg | CohostRoundMsg
  | SessionEndedMsg | ErrorMsg;

// ============== HOOK ==============

export function useVoiceRoom() {
  const [roomState, setRoomState] = useState<RoomState>('disconnected');
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [cohostActive, setCohostActive] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState<'primary' | 'cohost' | 'user' | null>(null);
  const [roundComplete, setRoundComplete] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const msgIdRef = useRef(0);

  // Per-speaker streaming transcript refs
  const primaryTextRef = useRef('');
  const cohostTextRef = useRef('');

  const { oxyServices } = useOxy();

  // ============== CLEANUP ==============

  const cleanup = useCallback(() => {
    if (roomRef.current) {
      // Detach all remote audio tracks before disconnecting
      roomRef.current.remoteParticipants.forEach((p) => {
        p.trackPublications.forEach((pub) => {
          pub.track?.detach();
        });
      });
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    sessionIdRef.current = null;
    primaryTextRef.current = '';
    cohostTextRef.current = '';
  }, []);

  // ============== DATA MESSAGE HANDLER ==============

  const handleDataMessage = useCallback((payload: Uint8Array) => {
    try {
      const msg: AgentDataMessage = JSON.parse(new TextDecoder().decode(payload));

      switch (msg.type) {
        case 'agent.state': {
          if (msg.speaker === 'primary' || !cohostActive) {
            setAgentState(msg.state);
          }
          setCurrentSpeaker(msg.speaker);
          break;
        }

        case 'transcript.delta': {
          const textRef = msg.speaker === 'cohost' ? cohostTextRef : primaryTextRef;
          textRef.current += msg.delta;
          const text = stripTitleTagsPartial(textRef.current);
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.isStreaming && last.speaker === msg.speaker) {
              return [...prev.slice(0, -1), { ...last, content: text }];
            }
            msgIdRef.current++;
            return [...prev, {
              id: `vm-${msgIdRef.current}`,
              role: 'assistant',
              speaker: msg.speaker,
              content: text,
              timestamp: Date.now(),
              isStreaming: true,
            }];
          });
          break;
        }

        case 'transcript.done': {
          const textRef = msg.speaker === 'cohost' ? cohostTextRef : primaryTextRef;
          textRef.current = '';
          const clean = stripTitleTags(msg.transcript);
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.isStreaming && last.speaker === msg.speaker) {
              return [...prev.slice(0, -1), { ...last, content: clean, isStreaming: false }];
            }
            return prev;
          });
          break;
        }

        case 'transcript.user': {
          if (!msg.transcript.trim()) break;
          msgIdRef.current++;
          setMessages(prev => [...prev, {
            id: `vm-${msgIdRef.current}`,
            role: 'user',
            content: msg.transcript.trim(),
            timestamp: Date.now(),
            isStreaming: false,
          }]);
          break;
        }

        case 'cohost.enabled':
          setCohostActive(true);
          break;

        case 'cohost.disabled':
          setCohostActive(false);
          setCurrentSpeaker(null);
          break;

        case 'cohost.turn_changed':
          setCurrentSpeaker(msg.speaker);
          break;

        case 'cohost.round_complete':
          setRoundComplete(true);
          break;

        case 'session.ended':
          cleanup();
          setRoomState('disconnected');
          setAgentState('idle');
          break;

        case 'error':
          setError(msg.message);
          break;
      }
    } catch {
      // Ignore non-JSON data
    }
  }, [cohostActive, cleanup]);

  // ============== CONNECT ==============

  const connect = useCallback(async () => {
    try {
      setError(null);
      setRoomState('connecting');

      const token = oxyServices.getAccessToken();
      if (!token) {
        setError('Not authenticated');
        setRoomState('error');
        return;
      }

      // Request session creation from backend
      const resp = await fetch(`${config.apiUrl}/v1/voice/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ model: 'alia-v1-voice' }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        const errMsg = body?.error?.message || body?.error || `Voice session failed (${resp.status})`;
        setError(errMsg);
        setRoomState('error');
        return;
      }

      const { token: livekitToken, url, roomName, sessionId } = await resp.json();
      sessionIdRef.current = sessionId;

      // Create LiveKit room and connect
      const room = new Room();
      roomRef.current = room;

      // Event: remote audio tracks (agent speaking) — must attach to play
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === Track.Kind.Audio) {
          track.attach();
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach();
      });

      // Event: data messages from agent
      room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
        handleDataMessage(payload);
      });

      // Event: disconnected
      room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        setRoomState('disconnected');
        setAgentState('idle');
        setCohostActive(false);
      });

      // Connect to the room
      await room.connect(url, livekitToken, { autoSubscribe: true });

      // Enable microphone — audio goes to LiveKit, agent picks it up server-side
      await room.localParticipant.setMicrophoneEnabled(true);

      setRoomState('connected');
      setAgentState('listening');

    } catch (e: any) {
      console.error('[useVoiceRoom] Connection error:', e);
      setError(e.message || 'Failed to connect');
      setRoomState('error');
      cleanup();
    }
  }, [oxyServices, cleanup, handleDataMessage]);

  // ============== DISCONNECT ==============

  const disconnect = useCallback(() => {
    cleanup();
    setRoomState('disconnected');
    setAgentState('idle');
    setError(null);
    setIsMuted(false);
    setMessages([]);
    setCohostActive(false);
    setCurrentSpeaker(null);
    setRoundComplete(false);
  }, [cleanup]);

  // ============== MUTE ==============

  const toggleMute = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const next = !isMuted;
    room.localParticipant.setMicrophoneEnabled(!next);
    setIsMuted(next);
  }, [isMuted]);

  // ============== COHOST CONTROLS ==============

  const sendClientData = useCallback((data: object) => {
    const room = roomRef.current;
    if (!room?.localParticipant) return;
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    room.localParticipant.publishData(encoded, { reliable: true } as DataPublishOptions);
  }, []);

  const enableCohost = useCallback(() => {
    sendClientData({ type: 'cohost.enable' });
  }, [sendClientData]);

  const disableCohost = useCallback(() => {
    sendClientData({ type: 'cohost.disable' });
  }, [sendClientData]);

  const continueCohost = useCallback(() => {
    setRoundComplete(false);
    sendClientData({ type: 'cohost.continue' });
  }, [sendClientData]);

  // ============== CLEANUP ON UNMOUNT ==============

  useEffect(() => cleanup, [cleanup]);

  return {
    room: roomRef.current,
    roomState,
    agentState,
    isMuted,
    error,
    messages,
    cohostActive,
    currentSpeaker,
    roundComplete,
    connect,
    disconnect,
    toggleMute,
    enableCohost,
    disableCohost,
    continueCohost,
    isConnected: roomState === 'connected',
  };
}
