/**
 * Hook for real-time voice conversations via LiveKit rooms.
 *
 * Connects to a LiveKit room (created by POST /v1/voice/token),
 * publishes the user's microphone, and receives agent audio + data
 * messages (transcripts, state, cohost events) over WebRTC.
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
import type { RoomState, AgentState, VoiceMessage, VoiceToolInvocation } from '../types';

const API_URL = process.env.EXPO_PUBLIC_ALIA_API_URL ?? 'https://api.alia.onl';

/** On web, audio tracks must be attached to a DOM element to play.
 *  On native (React Native), the WebRTC layer plays them automatically. */
const hasDOM = typeof document !== 'undefined';

// ============== OPTIONS ==============

export interface UseVoiceRoomOptions {
  apiUrl?: string;
  voicePreference?: 'male' | 'female';
  accessToken?: string;
}

// ============== TITLE TAG UTILITIES ==============

const TAG = String.raw`ALIA_TITLE|TITLE|TÍTULO|TITRE|TITOLO|TITEL|ЗАГОЛОВОК`;

const TITLE_STRIP_RE = new RegExp(
  String.raw`\[(${TAG})\].*?\[\/\1\]|<(${TAG})>.*?<\/\2>`, 'gi',
);

const TITLE_PARTIAL_RE = new RegExp(
  String.raw`\[(${TAG})\].*?(\[\/\1\])?$|<(${TAG})>.*?(<\/\3>)?$`, 'si',
);

function stripTitleTags(content: string): string {
  return content.replace(TITLE_STRIP_RE, '').trim();
}

function stripTitleTagsPartial(content: string): string {
  return content.replace(TITLE_STRIP_RE, '').replace(TITLE_PARTIAL_RE, '').trim();
}

// ============== INTERNAL DATA MESSAGE TYPES ==============

interface AgentStateMsg { type: 'agent.state'; state: 'listening' | 'thinking' | 'speaking'; speaker: 'primary' | 'cohost' }
interface TranscriptDeltaMsg { type: 'transcript.delta'; delta: string; speaker: 'primary' | 'cohost' }
interface TranscriptDoneMsg { type: 'transcript.done'; transcript: string; speaker: 'primary' | 'cohost' }
interface TranscriptUserMsg { type: 'transcript.user'; transcript: string }
interface CohostEnabledMsg { type: 'cohost.enabled' }
interface CohostDisabledMsg { type: 'cohost.disabled' }
interface CohostTurnMsg { type: 'cohost.turn_changed'; speaker: 'primary' | 'cohost' | 'user' }
interface CohostRoundMsg { type: 'cohost.round_complete'; turns: number }
interface ToolCallMsg { type: 'tool.call'; toolName: string; callId: string; args?: any; speaker: 'primary' | 'cohost' }
interface ToolResultMsg { type: 'tool.result'; callId: string; speaker: 'primary' | 'cohost' }
interface SessionEndedMsg { type: 'session.ended'; reason: string }
interface ErrorMsg { type: 'error'; code: string; message: string }

type AgentDataMessage =
  | AgentStateMsg | TranscriptDeltaMsg | TranscriptDoneMsg | TranscriptUserMsg
  | CohostEnabledMsg | CohostDisabledMsg | CohostTurnMsg | CohostRoundMsg
  | ToolCallMsg | ToolResultMsg | SessionEndedMsg | ErrorMsg;

// ============== HOOK ==============

export function useVoiceRoom(options: UseVoiceRoomOptions = {}) {
  const apiUrl = options.apiUrl || API_URL;
  const voicePref = options.voicePreference ?? 'female';

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
  const sessionPrefixRef = useRef(`vm-${Date.now().toString(36)}`);

  // Per-speaker streaming transcript refs
  const primaryTextRef = useRef('');
  const cohostTextRef = useRef('');

  const { oxyServices } = useOxy();

  // ============== AUTH ==============

  const getToken = useCallback((): string | null => {
    if (options.accessToken) return options.accessToken;
    return oxyServices.httpService.getAccessToken();
  }, [options.accessToken, oxyServices]);

  // ============== CLEANUP ==============

  const cleanup = useCallback(() => {
    if (roomRef.current) {
      // On web, detach all remote audio tracks before disconnecting
      if (hasDOM) {
        roomRef.current.remoteParticipants.forEach((p) => {
          p.trackPublications.forEach((pub) => {
            pub.track?.detach();
          });
        });
      }
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
          // Always update agentState so both primary and cohost drive wave animation
          setAgentState(msg.state);
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
              id: `${sessionPrefixRef.current}-${msgIdRef.current}`,
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
          const transcript = msg.transcript.trim();
          setMessages(prev => {
            const last = prev[prev.length - 1];
            // Update existing user message instead of creating duplicates
            if (last && last.role === 'user') {
              return [...prev.slice(0, -1), { ...last, content: transcript }];
            }
            msgIdRef.current++;
            return [...prev, {
              id: `${sessionPrefixRef.current}-${msgIdRef.current}`,
              role: 'user',
              content: transcript,
              timestamp: Date.now(),
              isStreaming: false,
            }];
          });
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

        case 'tool.call': {
          const tool: VoiceToolInvocation = { toolCallId: msg.callId, toolName: msg.toolName, state: 'call', args: msg.args };
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.speaker === msg.speaker) {
              return [...prev.slice(0, -1), {
                ...last,
                toolInvocations: [...(last.toolInvocations || []), tool],
              }];
            }
            msgIdRef.current++;
            return [...prev, {
              id: `${sessionPrefixRef.current}-${msgIdRef.current}`,
              role: 'assistant' as const,
              speaker: msg.speaker,
              content: '',
              timestamp: Date.now(),
              isStreaming: true,
              toolInvocations: [tool],
            }];
          });
          break;
        }

        case 'tool.result': {
          setMessages(prev => prev.map(m => {
            if (!m.toolInvocations) return m;
            const updated = m.toolInvocations.map(t =>
              t.toolCallId === msg.callId ? { ...t, state: 'result' as const } : t
            );
            return { ...m, toolInvocations: updated };
          }));
          break;
        }

        case 'session.ended': {
          cleanup();
          setRoomState('disconnected');
          setAgentState('idle');
          const reason = msg.reason;
          setError(
            reason === 'user_silent' ? 'Call ended due to inactivity'
            : reason === 'user_unresponsive' ? 'Call ended — no response'
            : reason === 'max_duration_exceeded' ? 'Voice minutes limit reached. Upgrade for more.'
            : reason === 'credits_exhausted' ? 'Not enough credits to continue. Add more or upgrade your plan.'
            : 'Voice session ended'
          );
          break;
        }

        case 'error':
          setError(msg.message);
          break;
      }
    } catch {
      // Ignore non-JSON data
    }
  }, [cleanup]);

  // ============== CONNECT ==============

  const connect = useCallback(async () => {
    try {
      setError(null);
      setRoomState('connecting');

      // Guard: WebRTC must be available (requires registerGlobals on RN)
      if (typeof globalThis.RTCPeerConnection === 'undefined') {
        setError('Voice is not available on this device');
        setRoomState('error');
        return;
      }

      const token = getToken();
      if (!token) {
        setError('Not authenticated');
        setRoomState('error');
        return;
      }

      // Request session creation from backend
      const resp = await fetch(`${apiUrl}/v1/voice/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: 'alia-v1-voice',
          voice: voicePref === 'male' ? 'echo' : 'nova',
        }),
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

      // Event: remote audio tracks (agent speaking)
      // On web, must attach to a DOM element to play. On native, WebRTC plays audio automatically.
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === Track.Kind.Audio && hasDOM) {
          track.attach();
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (hasDOM && track.kind === Track.Kind.Audio) {
          track.detach();
        }
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
  }, [getToken, cleanup, handleDataMessage, apiUrl, voicePref]);

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
