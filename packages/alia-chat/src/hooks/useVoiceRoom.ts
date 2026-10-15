/**
 * A voice conversation, run on the device as a turn loop.
 *
 *   listening ──(the person stops talking)──▶ thinking ──(first sentence)──▶ speaking
 *       ▲                                         │                              │
 *       └──────────(answer spoken, or the person talks over it)──────────────────┘
 *
 * - **Listening** is on-device speech recognition (`lib/speech-recognition*`).
 *   An utterance ends after `endOfUtteranceMs` without a new word.
 * - **Listening is only said when it is true.** The call stays `connecting`
 *   until the recognizer reports that it has started, and it is watched while
 *   it listens: a recognizer that does not start, keeps ending without
 *   listening, is cut off by another recognition, or hears loud speech and
 *   returns no word ends the call with a typed code; a microphone that
 *   delivers nothing raises `warningCode` (`no-audio-input`) without ending
 *   it. See TUNING for the thresholds.
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
 * - **A voice that cannot speak ends the call.** When a clip cannot be made
 *   (`synthesisError`, typed from the route's code) or played, the turn stops
 *   speaking, its answer finishes streaming into the transcript, and the call
 *   ends with the reason as `errorCode` — never a call that listens on, mute.
 *
 * It replaced a LiveKit room (`POST /v1/voice/token`) whose realtime model and
 * transcription called providers directly; Alia's only inference path is
 * Alia → Oxy → Kaana, which serves chat and speech but no realtime session or
 * transcription. The public shape — `connect` / `disconnect`, `roomState`,
 * `agentState`, `messages`, `toggleMute` — is unchanged, so its consumers did
 * not change with it.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useOxy } from '@oxy.so/services/ui/client';
import { errorMessage } from '../lib/utils';
import type { RoomState, AgentState, VoiceMessage } from '../types';
import {
  isSpeechRecognitionAvailable,
  chooseSpeechRecognizer,
  requestSpeechRecognitionPermission,
  startSpeechRecognition,
} from '../lib/speech-recognition';
import type {
  SpeechRecognitionFailure,
  SpeechRecognitionSession,
} from '../lib/speech-recognition-types';
import {
  speechFailureCode,
  synthesisFailureCode,
  VOICE_ERROR_MESSAGES,
  type VoiceErrorCode,
} from '../lib/speech-messages';
import { defaultSpeechLanguage } from '../lib/speech-language';
import {
  playSpeechClip,
  requestSpeechClip,
  SpeechClipError,
  type ProductVoice,
} from '../lib/speech-synthesis';
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

// ── Is the recognizer really listening? ──
// The call says "listening" only once a session has started, and every signal
// below already exists: the session's own start/end/results and the
// microphone level (`onLevel`, every ~100ms on both engines; 0..1 is -60..0
// dBFS, `levelFromDbfs`).

/**
 * How long a session may take to report it has started. Chrome and Safari
 * start well inside a second; Android first binds its recognition service, a
 * second or two on a cold device. Past this nothing is hearing the person, and
 * the call ends (`recognizer-not-started`) instead of reading "Listening".
 */
const RECOGNIZER_START_TIMEOUT_MS = 8_000;
/** A session that ends within this of starting, having heard nothing, did not really listen. */
const RAPID_END_MS = 400;
/**
 * Sessions in a row that ended on their own without listening or hearing a
 * word (never started, ended within `RAPID_END_MS`, or ended on an error)
 * before the call stops restarting and ends. A session that listened and
 * timed out on silence (Chrome's `no-speech`) is the person being quiet and
 * does not count.
 */
const MAX_FRUITLESS_SESSIONS = 5;
/**
 * Sessions in a row cut off by another recognition (`interrupted`) before the
 * call ends as `recognizer-aborted`. The first restarts cover a one-off (a
 * search box's mic in another tab, already done); by the third, something is
 * taking the recognizer back each time, and restarting again only steals it
 * back in a loop where neither side hears anything.
 */
const MAX_INTERRUPTIONS = 3;
/**
 * Below this the microphone is delivering nothing: 0.02 is -58.8 dBFS, under
 * what a live microphone picks up in a quiet room (breath, a keyboard, the room
 * itself). A muted, unplugged or wrong input delivers digital silence, 0.
 */
const SILENT_LEVEL = 0.02;
/**
 * Listening with every reading under `SILENT_LEVEL` this long raises
 * `no-audio-input`. A WARNING, not the end of the call: a person who is simply
 * quiet in a very quiet room reads nearly the same, so the call says "if
 * you're speaking, check your microphone" and keeps listening. It clears the
 * moment sound arrives.
 */
const NO_AUDIO_INPUT_MS = 10_000;
/**
 * A reading this loud is a voice, not a room: 0.5 is -30 dBFS. Speech at a
 * microphone with automatic gain lands around -30..-15 dBFS, and the stream is
 * noise-suppressed, so steady background noise stays well below it.
 */
const SPEECH_LEVEL = 0.5;
/**
 * Voice-level sound for this long in total, while listening, with not one
 * result from the recognizer, ends the call as `recognizer-unresponsive`: the
 * person is talking and the recognition service is not answering. A working
 * recognizer returns its first interim words within about a second of speech.
 * Any result resets it.
 */
const UNRESPONSIVE_SPEECH_MS = 5_000;
/**
 * Readings arrive every ~100ms; a longer gap between two is a restart between
 * sessions, and counts as at most this much sound.
 */
const MAX_LEVEL_STEP_MS = 250;

// ============== INTERNAL STATE ==============

/** What the level readings have shown since the recognizer last returned anything. */
interface HealthWatch {
  lastReadingAt: number | null;
  /** When the current run of silent readings began. */
  quietSince: number | null;
  /** Voice-level sound heard since the last result, in ms. */
  loudMs: number;
}

const freshHealth = (): HealthWatch => ({ lastReadingAt: null, quietSince: null, loudMs: 0 });

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
  /**
   * Why this turn stopped speaking: a clip that could not be made (`synthesis`
   * holds what the route said) or one the device could not play. The call ends
   * with `code` once the answer has finished streaming.
   */
  speechFailure: {
    readonly code: VoiceErrorCode;
    readonly synthesis: SpeechClipError | null;
  } | null;
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
  /**
   * Why the call ended, as a code and as the sentence to show. The sentence is
   * the code's English copy, except for `turn-failed`, which carries what the
   * turn sender threw.
   */
  const [callFailure, setCallFailure] = useState<{ code: VoiceErrorCode; message: string } | null>(
    null,
  );
  /** A turn that failed without ending the call: no answer came back. */
  const [turnErrorCode, setTurnErrorCode] = useState<VoiceErrorCode | null>(null);
  /** Something the person should know while the call goes on: the microphone is silent. */
  const [warningCode, setWarningCode] = useState<VoiceErrorCode | null>(null);
  /** The clip that could not be made, when that is what ended the call. */
  const [synthesisError, setSynthesisError] = useState<SpeechClipError | null>(null);
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
  /** The recognizer and tag the call listens with, chosen when it connects. */
  const recognizerRef = useRef<{ lang: string; service?: string }>({ lang: '' });
  const heardRef = useRef('');
  const committingRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnRef = useRef<ActiveTurn | null>(null);
  const draftIdRef = useRef<string | null>(null);
  /** What the call had said when the person cut in; this session's echo of it is not theirs. */
  const echoContextRef = useRef('');
  /** When the live session was opened, then when it started listening. */
  const sessionStartedAtRef = useRef(0);
  /** Whether the live session has reported that it is listening. */
  const sessionListeningRef = useRef(false);
  /** Whether the live session has returned any words. */
  const sessionHeardRef = useRef(false);
  /** Whether this hook asked the live session to end (stop or abort). */
  const endRequestedRef = useRef(false);
  /** Whether the call has heard its recognizer start: until then it is `connecting`. */
  const connectedRef = useRef(false);
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fruitlessSessionsRef = useRef(0);
  const interruptionsRef = useRef(0);
  const healthRef = useRef<HealthWatch>(freshHealth());
  const warningRef = useRef<VoiceErrorCode | null>(null);
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
    // Until the recognizer has started, the call is connecting and shows no phase.
    if (!mountedRef.current || !connectedRef.current) return;
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

  const patchMessage = useCallback(
    (id: string, patch: Partial<VoiceMessage>) => {
      updateMessages((previous) =>
        previous.map((message) => (message.id === id ? { ...message, ...patch } : message)),
      );
    },
    [updateMessages],
  );

  const getToken = useCallback((): string | null => {
    const { accessToken } = configRef.current;
    if (accessToken) return accessToken;
    return oxyServices.session.accessToken;
  }, [oxyServices]);

  const clearTimers = (): void => {
    if (silenceTimerRef.current !== null) clearTimeout(silenceTimerRef.current);
    if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
    if (startTimerRef.current !== null) clearTimeout(startTimerRef.current);
    silenceTimerRef.current = null;
    commitTimerRef.current = null;
    startTimerRef.current = null;
  };

  /** End the live session on purpose: its end is not the recognizer failing. */
  const endSession = useCallback((how: 'stop' | 'abort'): void => {
    const session = sessionRef.current;
    if (session === null) return;
    endRequestedRef.current = true;
    if (how === 'stop') session.stop();
    else session.abort();
  }, []);

  const warn = useCallback((code: VoiceErrorCode | null) => {
    if (warningRef.current === code) return;
    warningRef.current = code;
    if (mountedRef.current) setWarningCode(code);
  }, []);

  // ============== TEARDOWN ==============

  const endTurn = useCallback(
    (turn: ActiveTurn) => {
      turn.controller.abort();
      turn.closed = true;
      turn.wake?.();
      if (turnRef.current === turn) turnRef.current = null;
      const message = messagesRef.current.find((candidate) => candidate.id === turn.assistantId);
      if (message?.isStreaming) {
        if (message.content.trim() === '') {
          updateMessages((previous) =>
            previous.filter((candidate) => candidate.id !== turn.assistantId),
          );
        } else {
          patchMessage(turn.assistantId, { isStreaming: false });
        }
      }
      levels.setPlayback(0);
    },
    [levels, patchMessage, updateMessages],
  );

  const discardDraft = useCallback(() => {
    const draftId = draftIdRef.current;
    draftIdRef.current = null;
    if (draftId !== null)
      updateMessages((previous) => previous.filter((message) => message.id !== draftId));
  }, [updateMessages]);

  /** Stop everything; the caller decides what state the room is left in. */
  const teardown = useCallback(() => {
    phaseRef.current = 'off';
    connectedRef.current = false;
    clearTimers();
    committingRef.current = false;
    const turn = turnRef.current;
    if (turn !== null) endTurn(turn);
    endSession('abort');
    sessionRef.current = null;
    heardRef.current = '';
    healthRef.current = freshHealth();
    warn(null);
    levels.reset();
  }, [endSession, endTurn, levels, warn]);

  const fail = useCallback(
    (code: VoiceErrorCode, message: string = VOICE_ERROR_MESSAGES[code]) => {
      teardown();
      discardDraft();
      if (!mountedRef.current) return;
      setCallFailure({ code, message });
      setRoomState('error');
      setAgentStateValue('idle');
      setCurrentSpeaker(null);
    },
    [discardDraft, teardown],
  );

  // ============== SPEAKING ==============

  /** The first reason a turn could not speak is the one the call ends with. */
  const stopSpeaking = useCallback(
    (turn: ActiveTurn, code: VoiceErrorCode, synthesis: SpeechClipError | null) => {
      turn.speechFailure ??= { code, synthesis };
    },
    [],
  );

  const synthesize = useCallback(
    (turn: ActiveTurn, text: string): Promise<string | null> => {
      const token = getToken();
      if (token === null) {
        const failure = new SpeechClipError(VOICE_ERROR_MESSAGES['not-authenticated'], {
          status: null,
          code: 'NOT_AUTHENTICATED',
        });
        stopSpeaking(turn, synthesisFailureCode(failure), failure);
        return Promise.resolve(null);
      }
      const { apiUrl: url, speechModel: model, voicePref: voice } = configRef.current;
      return requestSpeechClip({
        apiUrl: url,
        token,
        model,
        input: text,
        voice,
        signal: turn.controller.signal,
      }).catch((caught: unknown) => {
        if (turn.controller.signal.aborted) return null;
        const failure =
          caught instanceof SpeechClipError
            ? caught
            : new SpeechClipError(errorMessage(caught, 'TTS failed'), { status: null, code: null });
        console.error('[useVoiceRoom] Speech synthesis failed:', {
          status: failure.status,
          code: failure.code,
          requestId: failure.requestId,
        });
        stopSpeaking(turn, synthesisFailureCode(failure), failure);
        return null;
      });
    },
    [getToken, stopSpeaking],
  );

  /**
   * Play the turn's clips in order as they arrive, fetching one ahead. Returns
   * early, without skipping to a later sentence, once a clip cannot be made or
   * played.
   */
  const playTurn = useCallback(
    async (turn: ActiveTurn): Promise<void> => {
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
        if (uri === null) {
          setAgent('thinking');
          levels.setPlayback(0);
          return;
        }
        turn.speaking = `${turn.speaking} ${item.text}`;
        setAgent('speaking');
        try {
          await playSpeechClip(uri, { signal, onLevel: (level) => levels.setPlayback(level) });
        } catch (caught: unknown) {
          if (signal.aborted) return;
          console.error('[useVoiceRoom] Playback failed:', caught);
          stopSpeaking(turn, 'not-played', null);
          setAgent('thinking');
          return;
        }
      }
    },
    [levels, setAgent, stopSpeaking, synthesize],
  );

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
    if (sessionRef.current === null || committingRef.current) return;
    committingRef.current = true;
    endSession('stop');
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      endSession('abort');
    }, COMMIT_TIMEOUT_MS);
  }, [endSession]);

  /** The call is listening for real: the first session has started. */
  const markConnected = useCallback(() => {
    if (connectedRef.current || phaseRef.current === 'off') return;
    connectedRef.current = true;
    if (!mountedRef.current) return;
    setRoomState('connected');
    setAgent(phaseRef.current);
  }, [setAgent]);

  /**
   * Judge a level reading while the call listens: a microphone that delivers
   * nothing raises `no-audio-input`; a voice the recognizer returns no word
   * for ends the call. Only while LISTENING to the person: while Alia thinks
   * or speaks the microphone hears her answer, which is no evidence either way.
   */
  const watchLevel = useCallback(
    (level: number) => {
      const health = healthRef.current;
      const now = Date.now();
      const step =
        health.lastReadingAt === null ? 0 : Math.min(now - health.lastReadingAt, MAX_LEVEL_STEP_MS);
      health.lastReadingAt = now;

      const watching =
        phaseRef.current === 'listening' &&
        turnRef.current === null &&
        sessionListeningRef.current &&
        !mutedRef.current &&
        !committingRef.current;
      if (!watching) {
        health.quietSince = null;
        return;
      }

      if (level >= SILENT_LEVEL) {
        health.quietSince = null;
        if (warningRef.current === 'no-audio-input') warn(null);
      } else {
        health.quietSince ??= now;
        const silentMs = now - health.quietSince;
        if (silentMs >= NO_AUDIO_INPUT_MS && warningRef.current === null) {
          console.warn('[useVoiceRoom] Microphone delivers no sound', { silentMs });
          warn('no-audio-input');
        }
      }

      if (level < SPEECH_LEVEL) return;
      health.loudMs += step;
      if (health.loudMs >= UNRESPONSIVE_SPEECH_MS) {
        console.warn('[useVoiceRoom] Voice heard, no words recognized', {
          loudMs: health.loudMs,
          fruitlessSessions: fruitlessSessionsRef.current,
        });
        fail('recognizer-unresponsive');
      }
    },
    [fail, warn],
  );

  const showDraft = useCallback(
    (transcript: string) => {
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
    },
    [patchMessage, updateMessages],
  );

  const startListening = useCallback(() => {
    if (phaseRef.current === 'off' || mutedRef.current || sessionRef.current !== null) return;
    heardRef.current = '';
    committingRef.current = false;
    sessionFailedRef.current = null;
    sessionListeningRef.current = false;
    sessionHeardRef.current = false;
    endRequestedRef.current = false;
    echoContextRef.current = '';
    sessionStartedAtRef.current = Date.now();

    // Armed before the session opens: an engine that ends at once clears it in `onEnd`.
    startTimerRef.current = setTimeout(() => {
      startTimerRef.current = null;
      console.warn('[useVoiceRoom] Speech recognition did not start', {
        waitedMs: RECOGNIZER_START_TIMEOUT_MS,
        connected: connectedRef.current,
      });
      fail('recognizer-not-started');
    }, RECOGNIZER_START_TIMEOUT_MS);

    sessionRef.current = startSpeechRecognition(
      { ...recognizerRef.current, echoCancellation: true },
      {
        onStart: () => {
          if (phaseRef.current === 'off') return;
          if (startTimerRef.current !== null) clearTimeout(startTimerRef.current);
          startTimerRef.current = null;
          sessionListeningRef.current = true;
          sessionStartedAtRef.current = Date.now();
          markConnected();
        },
        onResult: ({ transcript }) => {
          if (phaseRef.current === 'off') return;
          // Words came back: whatever else is wrong, the recognizer works.
          sessionHeardRef.current = true;
          healthRef.current.loudMs = 0;
          interruptionsRef.current = 0;
          fruitlessSessionsRef.current = 0;
          if (committingRef.current) return;

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
          watchLevel(level);
        },
        onError: (failure) => {
          if (failure.code === 'no-speech' || failure.code === 'aborted') return;
          // The engine's own words, for diagnosis; never what was said.
          console.warn('[useVoiceRoom] Speech recognition error', {
            code: failure.code,
            detail: failure.detail ?? null,
            listening: sessionListeningRef.current,
            sessionMs: Date.now() - sessionStartedAtRef.current,
            phase: phaseRef.current,
          });
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

          // Recoverable: the engine's catch-all, and another recognition taking
          // the recognizer. Both are counted below, never restarted forever.
          const failure = sessionFailedRef.current;
          if (failure !== null && failure.code !== 'other' && failure.code !== 'interrupted') {
            fail(speechFailureCode(failure) ?? 'speech-failed');
            return;
          }

          // An utterance in progress when the engine ended is still an utterance.
          if (
            (committing || draftIdRef.current !== null) &&
            heard !== '' &&
            turnRef.current === null
          ) {
            runTurnRef.current(heard);
            return;
          }

          if (failure?.code === 'interrupted') {
            interruptionsRef.current += 1;
            if (interruptionsRef.current >= MAX_INTERRUPTIONS) {
              fail('recognizer-aborted');
              return;
            }
          }

          // A session that ended by itself, without listening or a word, did
          // not idle: restarting it forever is a call that reads "Listening"
          // and hears nothing.
          if (!endRequestedRef.current && !sessionHeardRef.current) {
            const listened =
              sessionListeningRef.current &&
              Date.now() - sessionStartedAtRef.current >= RAPID_END_MS;
            if (!listened || failure !== null) {
              fruitlessSessionsRef.current += 1;
              if (fruitlessSessionsRef.current >= MAX_FRUITLESS_SESSIONS) {
                console.warn('[useVoiceRoom] Speech recognition keeps ending without listening', {
                  sessions: fruitlessSessionsRef.current,
                  code: failure?.code ?? null,
                  detail: failure?.detail ?? null,
                });
                fail(
                  failure !== null
                    ? (speechFailureCode(failure) ?? 'speech-failed')
                    : sessionListeningRef.current
                      ? 'recognizer-unresponsive'
                      : 'recognizer-not-started',
                );
                return;
              }
            } else {
              fruitlessSessionsRef.current = 0;
            }
          }
          startListeningRef.current();
        },
      },
    );
  }, [commitUtterance, endTurn, fail, levels, markConnected, setAgent, showDraft, watchLevel]);
  startListeningRef.current = startListening;

  // ============== THINKING ==============

  const runTurn = useCallback(
    (text: string) => {
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
        {
          id: assistantId,
          role: 'assistant',
          speaker: 'primary',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
        },
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
        speechFailure: null,
      };
      turnRef.current = turn;
      setAgent('thinking');
      if (mountedRef.current) setTurnErrorCode(null);

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
          fail('turn-failed', errorMessage(caught, VOICE_ERROR_MESSAGES['turn-failed']));
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

        // The answer is in the transcript; a call that cannot say it ends here,
        // rather than listening on in silence.
        const speechFailure = turn.speechFailure;
        if (speechFailure !== null) {
          if (mountedRef.current) setSynthesisError(speechFailure.synthesis);
          fail(speechFailure.code);
          return;
        }

        turnRef.current = null;
        levels.setPlayback(0);
        // The session that listened through the answer has heard the answer; a
        // fresh one starts the next utterance clean.
        endSession('abort');
        if (turn.text.trim() === '') {
          updateMessages((previous) => previous.filter((message) => message.id !== assistantId));
          if (mountedRef.current) setTurnErrorCode('no-answer');
        }
        setAgent('listening');
        startListeningRef.current();
      })();
    },
    [endSession, fail, levels, patchMessage, playTurn, queueChunks, setAgent, updateMessages],
  );
  runTurnRef.current = runTurn;

  // ============== CONNECT ==============

  const connect = useCallback(async () => {
    if (phaseRef.current !== 'off') return;
    setCallFailure(null);
    setTurnErrorCode(null);
    setSynthesisError(null);
    warn(null);
    setRoomState('connecting');

    if (!isSpeechRecognitionAvailable()) {
      setCallFailure({
        code: 'voice-unavailable',
        message: VOICE_ERROR_MESSAGES['voice-unavailable'],
      });
      setRoomState('error');
      return;
    }
    if (getToken() === null) {
      setCallFailure({
        code: 'not-authenticated',
        message: VOICE_ERROR_MESSAGES['not-authenticated'],
      });
      setRoomState('error');
      return;
    }

    const refusal = await requestSpeechRecognitionPermission();
    if (!mountedRef.current) return;
    if (refusal !== null) {
      const code = speechFailureCode(refusal) ?? 'microphone-denied';
      setCallFailure({ code, message: VOICE_ERROR_MESSAGES[code] });
      setRoomState('error');
      return;
    }

    // The recognizer that knows the call's language, as dictation picks it.
    const choice = await chooseSpeechRecognizer(configRef.current.lang);
    if (!mountedRef.current) return;
    if ('failure' in choice) {
      const code = speechFailureCode(choice.failure) ?? 'speech-language';
      setCallFailure({ code, message: VOICE_ERROR_MESSAGES[code] });
      setRoomState('error');
      return;
    }
    recognizerRef.current = { lang: choice.lang, service: choice.service };

    fruitlessSessionsRef.current = 0;
    interruptionsRef.current = 0;
    healthRef.current = freshHealth();
    // Still `connecting`: the call is connected, and listening, once the
    // recognizer says it has started (`markConnected`).
    connectedRef.current = false;
    setAgent('listening');
    startListeningRef.current();
  }, [getToken, setAgent, warn]);

  // ============== DISCONNECT ==============

  const disconnect = useCallback(() => {
    teardown();
    draftIdRef.current = null;
    messagesRef.current = [];
    mutedRef.current = false;
    setRoomState('disconnected');
    setAgentStateValue('idle');
    setCallFailure(null);
    setTurnErrorCode(null);
    setSynthesisError(null);
    setWarningCode(null);
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
      endSession('abort');
      levels.setCapture(0);
      // Nobody is meant to be heard while muted.
      healthRef.current.quietSince = null;
      warn(null);
    } else {
      startListeningRef.current();
    }
  }, [discardDraft, endSession, levels, warn]);

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
    /** Why the call ended, in English. */
    error: callFailure?.message ?? null,
    /** The same, as a code an app can translate. */
    errorCode: callFailure?.code ?? null,
    turnError: turnErrorCode === null ? null : VOICE_ERROR_MESSAGES[turnErrorCode],
    turnErrorCode,
    /**
     * Something wrong that does not end the call, in English: the microphone
     * has delivered no sound for a while (`no-audio-input`). `null` again as
     * soon as it does.
     */
    warning: warningCode === null ? null : VOICE_ERROR_MESSAGES[warningCode],
    /** The same, as a code an app can translate. */
    warningCode,
    /**
     * When the call ended because a clip could not be made: the route's HTTP
     * status and typed code (`SpeechClipError`). `errorCode` says the same as a
     * `VoiceErrorCode` an app can translate.
     */
    synthesisError,
    messages,
    currentSpeaker,
    connect,
    disconnect,
    toggleMute,
    isConnected: roomState === 'connected',
  };
}
