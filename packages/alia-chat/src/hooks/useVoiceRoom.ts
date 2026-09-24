/**
 * A voice conversation, run on the device as a turn loop.
 *
 *   listening ──(the person stops talking)──▶ thinking ──(first sentence)──▶ speaking
 *       ▲                                         │                              │
 *       └──────────(answer spoken, or the person talks over it)──────────────────┘
 *
 * - **Listening** is on-device speech recognition (`lib/speech-recognition*`).
 *   An utterance ends after `endOfUtteranceMs` without a new word.
 * - **Thinking** sends the utterance through the ordinary chat path — a
 *   `VoiceTurnSender`, by default `POST /v1/chat/completions` marked
 *   `responseMode: 'voice'` — and streams the answer into the transcript.
 * - **Speaking** synthesizes the answer through `POST /v1/audio/speech`
 *   sentence by sentence as it streams, so the first sentence plays while the
 *   rest is still being written, and the next clip is fetched while the
 *   current one plays.
 * - **Barge-in:** the microphone stays open while Alia thinks and speaks. When
 *   the person says a few words that are not the answer echoing back, the turn
 *   is aborted — playback stops, the chat request is cancelled — and what they
 *   are saying becomes the next utterance.
 *
 * It replaced a LiveKit room (`POST /v1/voice/token`) whose realtime model and
 * transcription called providers directly; Alia's only inference path is
 * Alia → Oxy → Kaana, which serves chat and speech but no realtime session or
 * transcription. The public shape — `connect` / `disconnect`, `roomState`,
 * `agentState`, `messages`, `toggleMute` — is unchanged, so its consumers did
 * not change with it.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useOxy } from '@oxy.so/services';
import { errorMessage } from '../lib/utils';
import type { RoomState, AgentState, VoiceMessage } from '../types';
import {
  isSpeechRecognitionAvailable,
  requestSpeechRecognitionPermission,
  startSpeechRecognition,
} from '../lib/speech-recognition';
import type { SpeechRecognitionFailure, SpeechRecognitionSession } from '../lib/speech-recognition-types';
import { speechFailureMessage } from '../lib/speech-messages';
import { defaultSpeechLanguage } from '../lib/speech-language';
import { playSpeechClip, requestSpeechClip, type ProductVoice } from '../lib/speech-synthesis';
import { VoiceLevelChannel, type VoiceLevelSource } from '../lib/voice-levels';
import {
  createAliaVoiceTurnSender,
  type VoiceTurnMessage,
  type VoiceTurnSender,
} from '../lib/voice-turn';
import {
  dropEchoPrefix,
  isInterruption,
  stripTitleTags,
  stripTitleTagsPartial,
  takeSpeechChunks,
} from '../lib/voice-text';

const API_URL = process.env.EXPO_PUBLIC_ALIA_API_URL ?? 'https://api.alia.onl';

// ============== OPTIONS ==============

export interface UseVoiceRoomOptions {
  apiUrl?: string;
  /** Which of the product's two voices answers. Sent to `/v1/audio/speech` as is. */
  voicePreference?: ProductVoice;
  /** Bearer for speech synthesis; defaults to the surrounding Oxy session's. */
  accessToken?: string;
  /**
   * Speech model for the answers. Omitted, the request carries no `model` and
   * the server's own speech model answers.
   */
  model?: string;
  /**
   * Chat model (`publisher/model`) the default sender asks for; omitted, the
   * server's default. Ignored when `sendTurn`
   * is given — that sender carries its own conversation's choice.
   */
  chatModel?: string;
  /**
   * The agent this call belongs to, when it is a thread with one.
   *
   * Without it the call is ordinary Alia. Only the default sender reads it; a
   * custom `sendTurn` is already bound to its conversation's agent.
   */
  agentId?: string;
  /** Language to recognize (BCP-47). Defaults to the platform's. */
  lang?: string;
  /**
   * How each turn reaches Alia. Defaults to `createAliaVoiceTurnSender`. The
   * Alia app passes its conversation's own send, so a call's turns are that
   * conversation's turns — persisted and shown like typed ones.
   */
  sendTurn?: VoiceTurnSender;
  /** Silence, in ms, that ends an utterance. */
  endOfUtteranceMs?: number;
  /** Let the person interrupt by talking. On by default. */
  bargeIn?: boolean;
}

// ============== TUNING ==============

const DEFAULT_END_OF_UTTERANCE_MS = 1_100;
/** How long a requested stop may take to deliver the final words. */
const COMMIT_TIMEOUT_MS = 1_500;
/** Words needed before talking over the answer counts as an interruption. */
const BARGE_IN_MIN_WORDS = 2;
/** A recognizer that keeps ending within this of starting is failing, not idling. */
const RAPID_END_MS = 400;
const MAX_RAPID_ENDS = 5;

// ============== INTERNAL STATE ==============

type Phase = 'off' | 'listening' | 'thinking' | 'speaking';

interface ActiveTurn {
  readonly controller: AbortController;
  readonly assistantId: string;
  /** Characters of the answer already handed to the speech queue. */
  consumed: number;
  chunkCount: number;
  /** The answer so far, title tags stripped and whitespace kept (see `stripTitleTags`). */
  text: string;
  /** Everything this turn has said aloud so far, for telling echo from the person. */
  speaking: string;
  readonly clips: Array<{ readonly text: string; clip: Promise<string | null> | null }>;
  closed: boolean;
  /** Wakes the player when a clip is queued or the answer ends. */
  wake: (() => void) | null;
  synthesisFailed: boolean;
}

// ============== HOOK ==============

export function useVoiceRoom(options: UseVoiceRoomOptions = {}) {
  const apiUrl = options.apiUrl || API_URL;
  const voicePref: ProductVoice = options.voicePreference ?? 'female';
  const speechModel = options.model;
  const endOfUtteranceMs = options.endOfUtteranceMs ?? DEFAULT_END_OF_UTTERANCE_MS;
  const bargeIn = options.bargeIn ?? true;

  const [roomState, setRoomState] = useState<RoomState>('disconnected');
  const [agentState, setAgentStateValue] = useState<AgentState>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A turn that failed without ending the call: no answer, or no audio for it. */
  const [turnError, setTurnError] = useState<string | null>(null);
  const [messages, setMessagesState] = useState<VoiceMessage[]>([]);
  const [currentSpeaker, setCurrentSpeaker] = useState<'primary' | 'user' | null>(null);

  const { oxyServices } = useOxy();

  const levels = useMemo(() => new VoiceLevelChannel(), []);

  // Everything the loop reads from callbacks lives in refs: recognizer events
  // arrive outside React, and a value closed over at `connect` would be stale.
  const phaseRef = useRef<Phase>('off');
  const mutedRef = useRef(false);
  const mountedRef = useRef(true);
  const messagesRef = useRef<VoiceMessage[]>([]);
  const sessionRef = useRef<SpeechRecognitionSession | null>(null);
  const heardRef = useRef('');
  const committingRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnRef = useRef<ActiveTurn | null>(null);
  const draftIdRef = useRef<string | null>(null);
  /** What the call had said when the person cut in; this session's echo of it is not theirs. */
  const echoContextRef = useRef('');
  const sessionStartedAtRef = useRef(0);
  const rapidEndsRef = useRef(0);
  const sessionFailedRef = useRef<SpeechRecognitionFailure | null>(null);
  const msgIdRef = useRef(0);
  const sessionPrefixRef = useRef(`vm-${Date.now().toString(36)}`);

  const config = {
    apiUrl,
    voicePref,
    speechModel,
    endOfUtteranceMs,
    bargeIn,
    lang: options.lang ?? defaultSpeechLanguage(),
    accessToken: options.accessToken,
    sendTurn:
      options.sendTurn ??
      createAliaVoiceTurnSender({
        oxyServices,
        apiUrl,
        ...(options.chatModel === undefined ? {} : { model: options.chatModel }),
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
      }),
  };
  const configRef = useRef(config);
  configRef.current = config;

  // ============== STATE HELPERS ==============

  const setAgent = useCallback((phase: Phase) => {
    phaseRef.current = phase;
    if (!mountedRef.current) return;
    setAgentStateValue(phase === 'off' ? 'idle' : phase);
    setCurrentSpeaker(phase === 'thinking' || phase === 'speaking' ? 'primary' : null);
  }, []);

  const updateMessages = useCallback((update: (previous: VoiceMessage[]) => VoiceMessage[]) => {
    messagesRef.current = update(messagesRef.current);
    if (mountedRef.current) setMessagesState(messagesRef.current);
  }, []);

  const nextId = (): string => {
    msgIdRef.current += 1;
    return `${sessionPrefixRef.current}-${msgIdRef.current}`;
  };

  const patchMessage = useCallback((id: string, patch: Partial<VoiceMessage>) => {
    updateMessages((previous) => previous.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  }, [updateMessages]);

  const getToken = useCallback((): string | null => {
    const { accessToken } = configRef.current;
    if (accessToken) return accessToken;
    return oxyServices.httpService.getAccessToken();
  }, [oxyServices]);

  const clearTimers = (): void => {
    if (silenceTimerRef.current !== null) clearTimeout(silenceTimerRef.current);
    if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
    silenceTimerRef.current = null;
    commitTimerRef.current = null;
  };

  // ============== TEARDOWN ==============

  const endTurn = useCallback((turn: ActiveTurn) => {
    turn.controller.abort();
    turn.closed = true;
    turn.wake?.();
    if (turnRef.current === turn) turnRef.current = null;
    const message = messagesRef.current.find((candidate) => candidate.id === turn.assistantId);
    if (message?.isStreaming) {
      if (message.content.trim() === '') {
        updateMessages((previous) => previous.filter((candidate) => candidate.id !== turn.assistantId));
      } else {
        patchMessage(turn.assistantId, { isStreaming: false });
      }
    }
    levels.setPlayback(0);
  }, [levels, patchMessage, updateMessages]);

  const discardDraft = useCallback(() => {
    const draftId = draftIdRef.current;
    draftIdRef.current = null;
    if (draftId !== null) updateMessages((previous) => previous.filter((message) => message.id !== draftId));
  }, [updateMessages]);

  /** Stop everything; the caller decides what state the room is left in. */
  const teardown = useCallback(() => {
    phaseRef.current = 'off';
    clearTimers();
    committingRef.current = false;
    const turn = turnRef.current;
    if (turn !== null) endTurn(turn);
    sessionRef.current?.abort();
    sessionRef.current = null;
    heardRef.current = '';
    levels.reset();
  }, [endTurn, levels]);

  const fail = useCallback((message: string) => {
    teardown();
    discardDraft();
    if (!mountedRef.current) return;
    setError(message);
    setRoomState('error');
    setAgentStateValue('idle');
    setCurrentSpeaker(null);
  }, [discardDraft, teardown]);

  // ============== SPEAKING ==============

  const synthesize = useCallback((turn: ActiveTurn, text: string): Promise<string | null> => {
    const token = getToken();
    if (token === null) {
      turn.synthesisFailed = true;
      return Promise.resolve(null);
    }
    const { apiUrl: url, speechModel: model, voicePref: voice } = configRef.current;
    return requestSpeechClip({ apiUrl: url, token, model, input: text, voice, signal: turn.controller.signal })
      .catch((caught: unknown) => {
        if (!turn.controller.signal.aborted) {
          console.error('[useVoiceRoom] Speech synthesis failed:', caught);
          turn.synthesisFailed = true;
        }
        return null;
      });
  }, [getToken]);

  /** Play the turn's clips in order as they arrive, fetching one ahead. */
  const playTurn = useCallback(async (turn: ActiveTurn): Promise<void> => {
    const signal = turn.controller.signal;
    for (let index = 0; ; index += 1) {
      while (index >= turn.clips.length && !turn.closed) {
        await new Promise<void>((resolve) => {
          turn.wake = resolve;
        });
        turn.wake = null;
      }
      if (signal.aborted || index >= turn.clips.length) return;
      const item = turn.clips[index];
      item.clip ??= synthesize(turn, item.text);
      const next = turn.clips[index + 1];
      if (next !== undefined) next.clip ??= synthesize(turn, next.text);

      const uri = await item.clip;
      if (signal.aborted) return;
      if (uri === null) continue;
      turn.speaking = `${turn.speaking} ${item.text}`;
      setAgent('speaking');
      try {
        await playSpeechClip(uri, { signal, onLevel: (level) => levels.setPlayback(level) });
      } catch (caught: unknown) {
        console.error('[useVoiceRoom] Playback failed:', caught);
        turn.synthesisFailed = true;
      }
    }
  }, [levels, setAgent, synthesize]);

  const queueChunks = useCallback((turn: ActiveTurn, final: boolean) => {
    const pending = turn.text.slice(turn.consumed);
    const { chunks, rest } = takeSpeechChunks(pending, { final, isFirst: turn.chunkCount === 0 });
    turn.consumed = turn.text.length - rest.length;
    for (const text of chunks) {
      turn.chunkCount += 1;
      // The next clip is fetched now if the player is waiting on it; the
      // player fetches the rest one ahead of what it is playing.
      turn.clips.push({ text, clip: null });
    }
    if (chunks.length > 0) turn.wake?.();
  }, []);

  // ============== LISTENING ==============

  // Declared through refs so the recognizer callbacks and the turn runner can
  // call each other without a cycle in their dependency lists.
  const startListeningRef = useRef<() => void>(() => undefined);
  const runTurnRef = useRef<(text: string) => void>(() => undefined);

  const commitUtterance = useCallback(() => {
    const session = sessionRef.current;
    if (session === null || committingRef.current) return;
    committingRef.current = true;
    session.stop();
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      sessionRef.current?.abort();
    }, COMMIT_TIMEOUT_MS);
  }, []);

  const showDraft = useCallback((transcript: string) => {
    const draftId = draftIdRef.current;
    if (draftId !== null) {
      patchMessage(draftId, { content: transcript });
      return;
    }
    const id = nextId();
    draftIdRef.current = id;
    updateMessages((previous) => [
      ...previous,
      { id, role: 'user', content: transcript, timestamp: Date.now(), isStreaming: true },
    ]);
    if (mountedRef.current) setCurrentSpeaker('user');
  }, [patchMessage, updateMessages]);

  const startListening = useCallback(() => {
    if (phaseRef.current === 'off' || mutedRef.current || sessionRef.current !== null) return;
    heardRef.current = '';
    committingRef.current = false;
    sessionFailedRef.current = null;
    echoContextRef.current = '';
    sessionStartedAtRef.current = Date.now();

    sessionRef.current = startSpeechRecognition(
      { lang: configRef.current.lang, echoCancellation: true },
      {
        onResult: ({ transcript }) => {
          if (phaseRef.current === 'off' || committingRef.current) return;

          const turn = turnRef.current;
          if (turn !== null) {
            // Alia is thinking or speaking: this is the person cutting in, or
            // the answer coming back through the microphone.
            heardRef.current = '';
            if (!configRef.current.bargeIn) return;
            if (!isInterruption(transcript, turn.speaking, BARGE_IN_MIN_WORDS)) return;
            echoContextRef.current = turn.speaking;
            endTurn(turn);
            setAgent('listening');
          }

          const utterance = dropEchoPrefix(transcript, echoContextRef.current);
          heardRef.current = utterance;
          if (utterance === '') return;
          showDraft(utterance);
          if (silenceTimerRef.current !== null) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(() => {
            silenceTimerRef.current = null;
            commitUtterance();
          }, configRef.current.endOfUtteranceMs);
        },
        onLevel: (level) => {
          levels.setCapture(mutedRef.current ? 0 : level);
        },
        onError: (failure) => {
          if (failure.code === 'no-speech' || failure.code === 'aborted') return;
          sessionFailedRef.current = failure;
        },
        onEnd: () => {
          sessionRef.current = null;
          clearTimers();
          const committing = committingRef.current;
          committingRef.current = false;
          const heard = heardRef.current.trim();
          heardRef.current = '';
          if (phaseRef.current === 'off') return;

          const failure = sessionFailedRef.current;
          if (failure !== null && failure.code !== 'other') {
            fail(speechFailureMessage(failure) ?? 'Speech recognition failed');
            return;
          }

          // An utterance in progress when the engine ended is still an utterance.
          if ((committing || draftIdRef.current !== null) && heard !== '' && turnRef.current === null) {
            rapidEndsRef.current = 0;
            runTurnRef.current(heard);
            return;
          }

          if (Date.now() - sessionStartedAtRef.current < RAPID_END_MS) {
            rapidEndsRef.current += 1;
            if (rapidEndsRef.current >= MAX_RAPID_ENDS) {
              fail(speechFailureMessage(failure ?? { code: 'other' }) ?? 'Speech recognition failed');
              return;
            }
          } else {
            rapidEndsRef.current = 0;
          }
          startListeningRef.current();
        },
      },
    );
  }, [commitUtterance, endTurn, fail, levels, setAgent, showDraft]);
  startListeningRef.current = startListening;

  // ============== THINKING ==============

  const runTurn = useCallback((text: string) => {
    // Settle the person's words as a message of their own.
    const draftId = draftIdRef.current;
    draftIdRef.current = null;
    if (draftId !== null) {
      patchMessage(draftId, { content: text, isStreaming: false });
    } else {
      updateMessages((previous) => [
        ...previous,
        { id: nextId(), role: 'user', content: text, timestamp: Date.now(), isStreaming: false },
      ]);
    }

    const history: VoiceTurnMessage[] = messagesRef.current
      .filter((message) => message.content.trim() !== '' && message.id !== draftId)
      .map((message) => ({ role: message.role, content: message.content }))
      // The turn itself is `text`, not history.
      .slice(0, draftId === null ? -1 : undefined);

    const assistantId = nextId();
    updateMessages((previous) => [
      ...previous,
      { id: assistantId, role: 'assistant', speaker: 'primary', content: '', timestamp: Date.now(), isStreaming: true },
    ]);

    const turn: ActiveTurn = {
      controller: new AbortController(),
      assistantId,
      consumed: 0,
      chunkCount: 0,
      text: '',
      speaking: '',
      clips: [],
      closed: false,
      wake: null,
      synthesisFailed: false,
    };
    turnRef.current = turn;
    setAgent('thinking');
    if (mountedRef.current) setTurnError(null);

    // The microphone stays open through thinking and speaking, for barge-in.
    startListeningRef.current();

    const playing = playTurn(turn);
    const signal = turn.controller.signal;

    void (async () => {
      let lastText = '';
      try {
        await configRef.current.sendTurn({
          text,
          history,
          signal,
          onText: (answerSoFar) => {
            if (signal.aborted) return;
            lastText = answerSoFar;
            turn.text = stripTitleTagsPartial(answerSoFar, { trim: false });
            patchMessage(assistantId, { content: turn.text.trim() });
            queueChunks(turn, false);
          },
        });
      } catch (caught: unknown) {
        if (signal.aborted) return;
        console.error('[useVoiceRoom] Turn failed:', caught);
        fail(errorMessage(caught, 'Voice request failed'));
        return;
      }
      if (signal.aborted) return;

      turn.text = stripTitleTags(lastText, { trim: false });
      patchMessage(assistantId, { content: turn.text.trim(), isStreaming: false });
      queueChunks(turn, true);
      turn.closed = true;
      turn.wake?.();
      await playing;
      if (signal.aborted || turnRef.current !== turn) return;

      turnRef.current = null;
      levels.setPlayback(0);
      // The session that listened through the answer has heard the answer; a
      // fresh one starts the next utterance clean.
      sessionRef.current?.abort();
      if (turn.text.trim() === '') {
        updateMessages((previous) => previous.filter((message) => message.id !== assistantId));
        if (mountedRef.current) setTurnError('No answer came back — try saying it again');
      } else if (turn.synthesisFailed) {
        if (mountedRef.current) setTurnError('The answer could not be played aloud');
      }
      setAgent('listening');
      startListeningRef.current();
    })();
  }, [fail, levels, patchMessage, playTurn, queueChunks, setAgent, updateMessages]);
  runTurnRef.current = runTurn;

  // ============== CONNECT ==============

  const connect = useCallback(async () => {
    if (phaseRef.current !== 'off') return;
    setError(null);
    setTurnError(null);
    setRoomState('connecting');

    if (!isSpeechRecognitionAvailable()) {
      setError('Voice is not available on this device');
      setRoomState('error');
      return;
    }
    if (getToken() === null) {
      setError('Not authenticated');
      setRoomState('error');
      return;
    }

    const refusal = await requestSpeechRecognitionPermission();
    if (!mountedRef.current) return;
    if (refusal !== null) {
      setError(speechFailureMessage(refusal) ?? 'Microphone permission required');
      setRoomState('error');
      return;
    }

    rapidEndsRef.current = 0;
    setRoomState('connected');
    setAgent('listening');
    startListeningRef.current();
  }, [getToken, setAgent]);

  // ============== DISCONNECT ==============

  const disconnect = useCallback(() => {
    teardown();
    draftIdRef.current = null;
    messagesRef.current = [];
    mutedRef.current = false;
    setRoomState('disconnected');
    setAgentStateValue('idle');
    setError(null);
    setTurnError(null);
    setIsMuted(false);
    setMessagesState([]);
    setCurrentSpeaker(null);
  }, [teardown]);

  // ============== MUTE ==============

  const toggleMute = useCallback(() => {
    if (phaseRef.current === 'off') return;
    const next = !mutedRef.current;
    mutedRef.current = next;
    setIsMuted(next);
    if (next) {
      // What was half-said is dropped, not sent: muting mid-sentence means "not that".
      clearTimers();
      committingRef.current = false;
      heardRef.current = '';
      discardDraft();
      sessionRef.current?.abort();
      levels.setCapture(0);
    } else {
      startListeningRef.current();
    }
  }, [discardDraft, levels]);

  // ============== CLEANUP ON UNMOUNT ==============

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [teardown]);

  const room: VoiceLevelSource = levels;

  return {
    /** The call's live levels, for `useAudioLevelMonitor`. Named for the room it replaced. */
    room,
    roomState,
    agentState,
    isMuted,
    error,
    turnError,
    messages,
    currentSpeaker,
    connect,
    disconnect,
    toggleMute,
    isConnected: roomState === 'connected',
  };
}
