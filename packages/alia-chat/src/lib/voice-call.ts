/**
 * One voice call over Alia's `/v1/voice/session` socket (ADR 0017 §3–§4),
 * without React: the hook (`useVoiceRoom`) owns one and renders its snapshots.
 *
 * Alia holds the realtime session with Kaana; turn detection and barge-in are
 * the model's, on the server. The device only:
 *
 * - captures the microphone and sends it as PCM16 frames (nothing while muted);
 * - plays the answer's PCM16 frames from a jitter-buffered queue;
 * - when the server says the person started speaking, drops what it has not
 *   played and tells Alia how much of the answer was HEARD
 *   (`playback.interrupted`), so the model remembers what was said, not what it
 *   generated;
 * - shows a state it can prove (`VoiceCallState`). "Listening" needs the
 *   session ready upstream, a first captured buffer and Alia's acknowledgement
 *   of the first appended audio; "speaking" needs the first answer frame
 *   actually playing.
 *
 * A socket that drops without `session.closed` is resumed within the session's
 * resume window (`session.resume { afterSeq }`), and the call reads
 * `reconnecting` meanwhile — never `listening`.
 */

import type { VoiceCallState, VoiceMessage } from '../types';
import type { VoiceErrorCode } from './speech-messages';
import type { VoiceLevelChannel } from './voice-levels';
import {
  VoiceAudioEngineError,
  type VoiceAudioEngine,
  type VoiceAudioEngineHandlers,
} from './voice-audio-engine-types';
import {
  decodeAssistantAudioFrame,
  parseVoiceServerEvent,
  VOICE_PROTOCOL_VERSION,
  voiceSessionUrl,
  type ProductVoice,
  type ReceivedVoiceEvent,
  type VoiceClientEvent,
  type VoiceCloseReason,
} from './voice-protocol';

/** The part of a WebSocket a call uses: the browser's and React Native's both fit. */
export interface VoiceSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export type VoiceSocketFactory = (url: string) => VoiceSocket;

const OPEN = 1;

/** How often the Oxy token is re-read, and re-sent when it changed. */
const TOKEN_REFRESH_MS = 4 * 60_000;
/** Between two attempts to resume a dropped socket. */
const RESUME_RETRY_MS = 1_000;
/** Until the server says otherwise in `session.ready`. */
const DEFAULT_RESUME_WINDOW_MS = 30_000;

export interface VoiceCallSnapshot {
  readonly state: VoiceCallState;
  readonly messages: readonly VoiceMessage[];
  readonly isMuted: boolean;
  /** Milliseconds left when the server warned that the call is about to end. */
  readonly endingSoonMs: number | null;
  /** The model serving the call, once the session is ready. */
  readonly model: { id: string; displayName: string; publisher: string } | null;
}

export interface VoiceCallOptions {
  readonly apiUrl: string;
  /** The person's Oxy session token, read at connect and every few minutes. */
  readonly getToken: () => string | null;
  readonly conversationId: string;
  readonly agentId?: string;
  readonly voice: ProductVoice;
  /** BCP-47. */
  readonly locale: string;
  readonly createEngine: () => VoiceAudioEngine;
  readonly openSocket: VoiceSocketFactory;
  readonly levels: VoiceLevelChannel;
  readonly onChange: (snapshot: VoiceCallSnapshot) => void;
  /** Alia stored messages of the call in the conversation. */
  readonly onMessagesSaved?: (conversationId: string, messageIds: readonly string[]) => void;
  /** A tool filed an action for the person's OK; the card is in the conversation. */
  readonly onApprovalRequested?: (toolName: string) => void;
  readonly tokenRefreshMs?: number;
  readonly resumeRetryMs?: number;
}

const LIVE: ReadonlySet<VoiceCallState['kind']> = new Set([
  'listening',
  'user-speaking',
  'thinking',
  'using-tool',
  'speaking',
]);

function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export class VoiceCall {
  private readonly options: VoiceCallOptions;
  private state: VoiceCallState = { kind: 'idle' };
  private messages: VoiceMessage[] = [];
  /**
   * Each message's text by the item it was spoken in, in the order the items
   * began: an assistant turn that called a tool is one message of two items.
   */
  private readonly itemTexts = new Map<string, Map<string, string>>();
  /** The message each item belongs to. */
  private readonly messageOfItem = new Map<string, string>();
  private muted = false;
  private endingSoonMs: number | null = null;
  private model: VoiceCallSnapshot['model'] = null;

  private engine: VoiceAudioEngine | null = null;
  private socket: VoiceSocket | null = null;
  private authenticated = false;
  private lastToken: string | null = null;
  private voiceSessionId: string | null = null;
  private lastSeq = -1;
  private resumeWindowMs = DEFAULT_RESUME_WINDOW_MS;
  private droppedAt: number | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenTimer: ReturnType<typeof setInterval> | null = null;
  private finished = false;

  /** The three facts "listening" needs. */
  private ready = false;
  private captured = false;
  private inputReady = false;

  /** Assistant items the person talked over: late frames of them are dropped. */
  private readonly interrupted = new Set<string>();
  private lastReceivedItem: string | null = null;
  private playingItem: string | null = null;
  private readonly activeTools = new Map<string, string>();
  /** A tool ran since the last response ended: another response follows it. */
  private toolRan = false;
  /** The error Alia sent before closing, which the close then ends the call with. */
  private serverError: VoiceErrorCode | null = null;

  constructor(options: VoiceCallOptions) {
    this.options = options;
  }

  snapshot(): VoiceCallSnapshot {
    return {
      state: this.state,
      messages: this.messages,
      isMuted: this.muted,
      endingSoonMs: this.endingSoonMs,
      model: this.model,
    };
  }

  /** Ask for the microphone, then open the socket and the session. */
  async start(): Promise<void> {
    if (this.state.kind !== 'idle') return;
    this.setState({ kind: 'connecting' });
    const token = this.options.getToken();
    if (token === null || token === '') {
      this.fail('not-authenticated');
      return;
    }
    const engine = this.options.createEngine();
    this.engine = engine;
    try {
      await engine.start(this.engineHandlers());
    } catch (caught: unknown) {
      if (this.finished) return;
      this.fail(caught instanceof VoiceAudioEngineError ? caught.code : 'voice-unavailable');
      return;
    }
    if (this.finished) return;
    this.openSocket(false);
    this.tokenTimer = setInterval(
      () => this.refreshToken(),
      this.options.tokenRefreshMs ?? TOKEN_REFRESH_MS,
    );
  }

  /** The person hung up, or the screen holding the call went away. */
  hangUp(): void {
    if (this.finished) return;
    this.send({ type: 'session.end' });
    this.finish({ kind: 'ended', reason: 'hangup' });
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (muted) this.options.levels.setCapture(0);
    this.emit();
  }

  /* ------------------------------------------------------------------------ */

  private engineHandlers(): VoiceAudioEngineHandlers {
    return {
      onCaptureFrame: (pcm) => {
        if (this.finished) return;
        if (!this.captured) {
          this.captured = true;
          this.maybeListening();
        }
        if (this.muted || !this.ready || !this.authenticated) return;
        if (this.socket?.readyState !== OPEN) return;
        this.socket.send(pcm);
      },
      onCaptureLevel: (level) => this.options.levels.setCapture(this.muted ? 0 : level),
      onPlaybackStarted: (itemId) => {
        if (this.finished || this.interrupted.has(itemId)) return;
        this.playingItem = itemId;
        if (LIVE.has(this.state.kind)) this.setState({ kind: 'speaking' });
      },
      onPlaybackLevel: (level) => this.options.levels.setPlayback(level),
      onPlaybackIdle: () => {
        this.playingItem = null;
        if (this.state.kind === 'speaking') this.afterSpeech();
      },
      onError: (error) => this.fail(error.code),
    };
  }

  private openSocket(resuming: boolean): void {
    this.authenticated = false;
    let socket: VoiceSocket;
    try {
      socket = this.options.openSocket(voiceSessionUrl(this.options.apiUrl));
    } catch {
      if (resuming) this.scheduleResume();
      else this.fail('connection-lost');
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      const token = this.options.getToken();
      if (token === null || token === '') {
        this.fail('not-authenticated');
        return;
      }
      this.lastToken = token;
      socket.send(JSON.stringify({ type: 'auth', token } satisfies VoiceClientEvent));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.finished) return;
      if (typeof event.data === 'string') {
        const parsed = parseVoiceServerEvent(event.data);
        if (parsed !== null) this.handle(parsed, resuming);
        return;
      }
      const bytes = asBytes(event.data);
      if (bytes !== null) this.handleAudio(bytes);
    };
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.socket !== socket || this.finished) return;
      this.socket = null;
      this.authenticated = false;
      if (this.serverError !== null) {
        this.fail(this.serverError);
        return;
      }
      if (this.voiceSessionId === null) {
        this.fail('connection-lost');
        return;
      }
      this.droppedAt ??= Date.now();
      this.setState({ kind: 'reconnecting' });
      this.scheduleResume();
    };
  }

  private scheduleResume(): void {
    if (this.finished) return;
    const droppedAt = this.droppedAt ?? Date.now();
    this.droppedAt = droppedAt;
    if (Date.now() - droppedAt >= this.resumeWindowMs) {
      this.fail('connection-lost');
      return;
    }
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (!this.finished) this.openSocket(true);
    }, this.options.resumeRetryMs ?? RESUME_RETRY_MS);
  }

  private refreshToken(): void {
    if (!this.authenticated || this.socket?.readyState !== OPEN) return;
    const token = this.options.getToken();
    if (token === null || token === '' || token === this.lastToken) return;
    this.lastToken = token;
    this.send({ type: 'auth', token });
  }

  private send(event: VoiceClientEvent): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(event));
  }

  private handle(event: ReceivedVoiceEvent, resuming: boolean): void {
    if (event.seq !== undefined) {
      if (event.seq <= this.lastSeq) return;
      this.lastSeq = event.seq;
    }
    switch (event.type) {
      case 'auth.ok':
        if (this.authenticated) return;
        this.authenticated = true;
        if (resuming && this.voiceSessionId !== null) {
          this.send({
            type: 'session.resume',
            protocol: VOICE_PROTOCOL_VERSION,
            voiceSessionId: this.voiceSessionId,
            afterSeq: this.lastSeq,
          });
        } else {
          this.send({
            type: 'session.start',
            protocol: VOICE_PROTOCOL_VERSION,
            conversationId: this.options.conversationId,
            ...(this.options.agentId === undefined ? {} : { agentId: this.options.agentId }),
            voice: this.options.voice,
            locale: this.options.locale,
          });
        }
        return;
      case 'session.accepted':
        this.voiceSessionId = event.voiceSessionId;
        return;
      case 'session.ready':
        this.ready = true;
        this.model = event.model;
        this.resumeWindowMs = event.resumeWindowMs;
        if (this.state.kind === 'reconnecting') this.setState({ kind: 'listening' });
        else this.maybeListening();
        this.emit();
        return;
      case 'input.ready':
        this.inputReady = true;
        this.maybeListening();
        return;
      case 'session.resumed':
        this.droppedAt = null;
        if (this.state.kind === 'reconnecting') this.setState({ kind: 'listening' });
        return;
      case 'session.reconnecting':
        this.setState({ kind: 'reconnecting' });
        return;
      case 'user.speech_started':
        this.bargeIn();
        if (LIVE.has(this.state.kind)) this.setState({ kind: 'user-speaking' });
        return;
      case 'user.speech_stopped':
        if (this.state.kind === 'user-speaking' || this.state.kind === 'listening')
          this.setState({ kind: 'thinking' });
        return;
      case 'transcript.delta':
        this.upsertMessage(event, (previous) => previous + event.text, true);
        return;
      case 'transcript.done':
        this.upsertMessage(event, () => event.text, false);
        return;
      case 'assistant.audio_done':
        return;
      case 'assistant.done':
        this.settleStreaming(event.itemId);
        if (this.toolRan) {
          // A response that called tools is followed by the one that answers.
          this.toolRan = false;
          return;
        }
        if (this.state.kind === 'thinking' && this.playingItem === null) this.afterSpeech();
        return;
      case 'tool.started':
        this.recordTool(event, 'call');
        this.activeTools.set(event.callId, event.name);
        this.toolRan = true;
        if (LIVE.has(this.state.kind)) this.setState({ kind: 'using-tool', tool: event.name });
        return;
      case 'tool.finished': {
        this.recordTool(event, 'result');
        this.activeTools.delete(event.callId);
        if (this.state.kind !== 'using-tool') return;
        const still = [...this.activeTools.values()].at(-1);
        this.setState(
          still === undefined ? { kind: 'thinking' } : { kind: 'using-tool', tool: still },
        );
        return;
      }
      case 'approval.requested':
        this.options.onApprovalRequested?.(event.toolName);
        return;
      case 'messages.saved':
        this.options.onMessagesSaved?.(event.conversationId, event.messageIds);
        return;
      case 'session.warning':
        this.endingSoonMs = event.remainingMs;
        this.emit();
        return;
      case 'error':
        this.serverError = event.code;
        return;
      case 'session.closed':
        this.closedByServer(event.reason);
        return;
    }
  }

  private handleAudio(frame: Uint8Array): void {
    const decoded = decodeAssistantAudioFrame(frame);
    if (decoded === null || this.interrupted.has(decoded.itemId)) return;
    this.lastReceivedItem = decoded.itemId;
    // Copied: the socket's buffer is not the engine's to keep.
    this.engine?.enqueue(decoded.itemId, decoded.pcm.slice());
  }

  /** The person spoke: stop the answer now and report what of it was heard. */
  private bargeIn(): void {
    const received = this.lastReceivedItem;
    if (received !== null) this.interrupted.add(received);
    const engine = this.engine;
    if (engine === null) return;
    this.playingItem = null;
    void engine.flush().then((heard) => {
      if (heard === null || this.finished) return;
      this.interrupted.add(heard.itemId);
      this.send({ type: 'playback.interrupted', itemId: heard.itemId, playedMs: heard.playedMs });
    });
  }

  /** Back to listening once the answer has been said, or nothing more is coming. */
  private afterSpeech(): void {
    if (this.activeTools.size > 0) {
      this.setState({ kind: 'using-tool', tool: [...this.activeTools.values()].at(-1)! });
      return;
    }
    this.setState({ kind: 'listening' });
  }

  private maybeListening(): void {
    if (this.state.kind !== 'connecting') return;
    if (this.ready && this.captured && this.inputReady) this.setState({ kind: 'listening' });
  }

  private closedByServer(reason: VoiceCloseReason): void {
    if (reason === 'error') {
      this.fail(this.serverError ?? 'realtime-failed');
      return;
    }
    this.finish({ kind: 'ended', reason });
  }

  /**
   * One message per `messageId`, the id the server stores and announces it
   * under, so the stored copy that reaches the thread is this message, not a
   * second one. Its text is its items' texts in order.
   */
  private upsertMessage(
    event: { role: 'user' | 'assistant'; messageId: string; itemId: string },
    text: (previous: string) => string,
    isStreaming: boolean,
  ): void {
    const { messageId, itemId } = event;
    const items = this.itemTexts.get(messageId) ?? new Map<string, string>();
    this.itemTexts.set(messageId, items);
    this.messageOfItem.set(itemId, messageId);
    items.set(itemId, text(items.get(itemId) ?? ''));
    const content = [...items.values()].filter((part) => part !== '').join(' ');
    this.writeMessage(messageId, event.role, (message) => ({ ...message, content, isStreaming }));
  }

  /**
   * A tool the answer ran, inside the answer's message, by name and state: the
   * device never receives its arguments or result, and the stored message that
   * carries them replaces this one once it is saved.
   */
  private recordTool(
    event: { messageId: string; callId: string; name: string },
    state: 'call' | 'result',
  ): void {
    this.writeMessage(event.messageId, 'assistant', (message) => {
      const invocation = { toolCallId: event.callId, toolName: event.name, state };
      const tools = message.toolInvocations ?? [];
      const index = tools.findIndex((tool) => tool.toolCallId === event.callId);
      return {
        ...message,
        toolInvocations:
          index === -1
            ? [...tools, invocation]
            : tools.map((tool, at) => (at === index ? invocation : tool)),
      };
    });
  }

  private writeMessage(
    messageId: string,
    role: 'user' | 'assistant',
    change: (message: VoiceMessage) => VoiceMessage,
  ): void {
    const index = this.messages.findIndex((message) => message.id === messageId);
    const current: VoiceMessage =
      index === -1
        ? {
            id: messageId,
            role,
            ...(role === 'assistant' ? { speaker: 'primary' as const } : {}),
            content: '',
            timestamp: Date.now(),
            isStreaming: false,
          }
        : this.messages[index]!;
    const next = change(current);
    this.messages =
      index === -1
        ? [...this.messages, next]
        : this.messages.map((message, at) => (at === index ? next : message));
    this.emit();
  }

  private settleStreaming(itemId: string | null): void {
    const messageId = itemId === null ? undefined : this.messageOfItem.get(itemId);
    if (messageId === undefined) return;
    if (!this.messages.some((message) => message.id === messageId && message.isStreaming)) return;
    this.messages = this.messages.map((message) =>
      message.id === messageId ? { ...message, isStreaming: false } : message,
    );
    this.emit();
  }

  private fail(code: VoiceErrorCode): void {
    this.finish({ kind: 'error', code });
  }

  private finish(state: VoiceCallState): void {
    if (this.finished) return;
    this.finished = true;
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer);
    if (this.tokenTimer !== null) clearInterval(this.tokenTimer);
    this.resumeTimer = null;
    this.tokenTimer = null;
    this.engine?.stop();
    this.engine = null;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, 'call ended');
      } catch {
        // Already closed.
      }
    }
    this.options.levels.reset();
    this.messages = this.messages.map((message) =>
      message.isStreaming ? { ...message, isStreaming: false } : message,
    );
    this.setState(state);
  }

  private setState(state: VoiceCallState): void {
    if (this.finished && state.kind !== 'ended' && state.kind !== 'error') return;
    this.state = state;
    this.emit();
  }

  private emit(): void {
    this.options.onChange(this.snapshot());
  }
}
