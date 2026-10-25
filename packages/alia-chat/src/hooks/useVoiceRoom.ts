/**
 * A voice call: speech to speech through Alia's `/v1/voice/session`
 * (ADR 0017).
 *
 * Alia holds the realtime session with Kaana — instructions, memory, tools
 * (run in Alia, never here), the transcript stored in the conversation, credits
 * and typed errors. Turn detection and barge-in are the model's, on the server.
 * This hook captures and plays PCM through the platform's audio engine
 * (`lib/voice-audio-engine*`) and exposes a state it can prove (`callState`,
 * see `VoiceCallState`), with `roomState` / `agentState` as the coarse
 * projections the call bar, the ambient field and the sound effects read.
 *
 * Nothing is recognized on the device: there is no browser or OS speech
 * recognizer anywhere in a call.
 */

import { bindAudioSession } from '../lib/audio-session-binding';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';
import type { AgentState, RoomState, VoiceCallState, VoiceMessage } from '../types';
import { VOICE_ERROR_MESSAGES, type VoiceErrorCode } from '../lib/speech-messages';
import { defaultSpeechLanguage } from '../lib/speech-language';
import { createVoiceAudioEngine } from '../lib/voice-audio-engine';
import type { VoiceAudioEngine } from '../lib/voice-audio-engine-types';
import { VoiceCall, type VoiceCallSnapshot, type VoiceSocketFactory } from '../lib/voice-call';
import { VoiceLevelChannel, type VoiceLevelSource } from '../lib/voice-levels';
import type { ProductVoice, VoiceCloseReason } from '../lib/voice-protocol';
import { ALIA_API_URL } from '../lib/origins';
import { useAppAssertionToken } from '../runtime/app-assertion';

export interface UseVoiceRoomOptions {
  apiUrl?: string;
  /**
   * The conversation the call is stored in. Omitted, every call starts a
   * conversation of its own (a fresh id per `connect`).
   */
  conversationId?: string;
  /** The agent this call talks to; omitted, Alia. */
  agentId?: string;
  /** Which of the product's two voices answers. */
  voicePreference?: ProductVoice;
  /** Bearer for the call; defaults to the surrounding Oxy session's. */
  accessToken?: string;
  /** Language spoken (BCP-47). Defaults to the platform's. */
  lang?: string;
  /** Alia stored messages of the call: refresh the thread. */
  onMessagesSaved?: (conversationId: string, messageIds: readonly string[]) => void;
  /** Test seams: the device's audio and the socket. */
  createAudioEngine?: () => VoiceAudioEngine;
  openSocket?: VoiceSocketFactory;
}

const IDLE: VoiceCallSnapshot = {
  state: { kind: 'idle' },
  messages: [],
  isMuted: false,
  endingSoonMs: null,
  model: null,
};

const openWebSocket: VoiceSocketFactory = (url) =>
  new WebSocket(url) as unknown as ReturnType<VoiceSocketFactory>;

function newConversationId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The coarse connection state the bar and the wave read. */
export function roomStateOf(state: VoiceCallState): RoomState {
  switch (state.kind) {
    case 'idle':
    case 'ended':
      return 'disconnected';
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'error':
      return 'error';
    default:
      return 'connected';
  }
}

/** Who has the turn, coarsely. */
export function agentStateOf(state: VoiceCallState): AgentState {
  switch (state.kind) {
    case 'listening':
    case 'user-speaking':
      return 'listening';
    case 'thinking':
    case 'using-tool':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    default:
      return 'idle';
  }
}

export function useVoiceRoom(options: UseVoiceRoomOptions = {}) {
  const { oxyServices } = useOxy();
  const getAppAssertion = useAppAssertionToken();
  const levels = useMemo(() => new VoiceLevelChannel(), []);
  const [snapshot, setSnapshot] = useState<VoiceCallSnapshot>(IDLE);
  const callRef = useRef<VoiceCall | null>(null);
  const sessionBindingRef = useRef<ReturnType<typeof bindAudioSession> | null>(null);
  const mountedRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const connect = useCallback(async () => {
    const live = callRef.current?.snapshot().state.kind;
    if (live !== undefined && live !== 'ended' && live !== 'error') return;
    const current = optionsRef.current;
    sessionBindingRef.current?.dispose();
    const apiUrl = current.apiUrl || ALIA_API_URL;
    const binding = current.accessToken
      ? null
      : bindAudioSession(oxyServices, apiUrl, () => callRef.current?.hangUp());
    sessionBindingRef.current = binding;
    const call = new VoiceCall({
      apiUrl,
      getToken: binding?.getToken ?? (() => optionsRef.current.accessToken ?? null),
      getAppAssertion,
      conversationId: current.conversationId ?? newConversationId(),
      ...(current.agentId === undefined ? {} : { agentId: current.agentId }),
      voice: current.voicePreference ?? 'female',
      locale: current.lang ?? defaultSpeechLanguage(),
      createEngine: current.createAudioEngine ?? createVoiceAudioEngine,
      openSocket: current.openSocket ?? openWebSocket,
      levels,
      onChange: (next) => {
        if (callRef.current !== call) return;
        if (next.state.kind === 'ended' || next.state.kind === 'error') binding?.dispose();
        if (mountedRef.current) setSnapshot(next);
      },
      onMessagesSaved: (conversationId, ids) =>
        optionsRef.current.onMessagesSaved?.(conversationId, ids),
    });
    callRef.current = call;
    await call.start();
  }, [oxyServices, getAppAssertion, levels]);

  /** Hang up and forget the call: the room is back to `disconnected`. */
  const disconnect = useCallback(() => {
    const call = callRef.current;
    callRef.current = null;
    sessionBindingRef.current?.dispose();
    sessionBindingRef.current = null;
    call?.hangUp();
    levels.reset();
    if (mountedRef.current) setSnapshot(IDLE);
  }, [levels]);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (call === null) return;
    call.setMuted(!call.snapshot().isMuted);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const call = callRef.current;
      callRef.current = null;
      sessionBindingRef.current?.dispose();
      sessionBindingRef.current = null;
      call?.hangUp();
    };
  }, []);

  const { state } = snapshot;
  const roomState = roomStateOf(state);
  const errorCode: VoiceErrorCode | null = state.kind === 'error' ? state.code : null;
  const endedReason: VoiceCloseReason | null = state.kind === 'ended' ? state.reason : null;
  const room: VoiceLevelSource = levels;

  return {
    /** The call's live levels, for `useAudioLevelMonitor`. */
    room,
    /** The honest state machine (ADR 0017 §4). */
    callState: state,
    roomState,
    agentState: agentStateOf(state),
    isMuted: snapshot.isMuted,
    /** Why the call failed, in English. */
    error: errorCode === null ? null : VOICE_ERROR_MESSAGES[errorCode],
    /** The same, as a code an app can translate. */
    errorCode,
    /** Why the call ended without failing; `call-moved-elsewhere` is one. */
    endedReason,
    /** Milliseconds left once the server warned the call is about to end. */
    endingSoonMs: snapshot.endingSoonMs,
    /** The model serving the call (its name may be shown; the operator never is). */
    model: snapshot.model,
    /** The live transcript, both sides. The stored one is the conversation's. */
    messages: snapshot.messages as VoiceMessage[],
    currentSpeaker:
      state.kind === 'speaking'
        ? ('primary' as const)
        : state.kind === 'user-speaking'
          ? ('user' as const)
          : null,
    connect,
    disconnect,
    toggleMute,
    isConnected: roomState === 'connected',
  };
}
