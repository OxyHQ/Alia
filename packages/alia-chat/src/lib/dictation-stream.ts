/**
 * Streaming dictation's network half (ADR 0024): the caller's microphone PCM to
 * `GET /v1/audio/transcriptions/stream`, and Alia's segments back while the
 * person speaks.
 *
 * It records nothing and draws nothing: the caller brings PCM16 LE mono at
 * 24 kHz from its own recorder (an AudioWorklet, a native module) and shows
 * the segments its own way. A segment's `transcript.final` is the only text to
 * keep; `transcript.interim` and `transcript.delta` are display state the
 * final supersedes. When the stream cannot open (`TRANSCRIPTION_UNAVAILABLE`),
 * batch `requestTranscription` is the fallback.
 */

import {
  type DictationClientEvent,
  type DictationCloseReason,
  type DictationServerEvent,
  DICTATION_PROTOCOL_VERSION,
  DICTATION_SAMPLE_RATE,
  dictationStreamUrl,
  parseDictationServerEvent,
} from './dictation-protocol';

/** The WebSocket the stream drives: a browser's, React Native's or a test's. */
export interface DictationSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

/** How the stream proves the person: their Oxy session token, read once at open. */
export type DictationStreamAuthentication =
  | {
      readonly getToken: (
        target: string,
        options?: { signal?: AbortSignal },
      ) => string | null | Promise<string | null>;
      readonly token?: never;
    }
  | { readonly token: string; readonly getToken?: never };

export type DictationStreamOptions = DictationStreamAuthentication & {
  /** Alia's API origin, `https://api.alia.onl`. */
  readonly apiUrl: string;
  /** BCP 47; omitted lets the model detect the language. */
  readonly language?: string;
  /**
   * Every event, in order. It always ends with one `dictation.closed`; a failure
   * comes as `error` just before it. A connection Alia never answered on is
   * reported as `TRANSCRIPTION_FAILED`, retryable.
   */
  readonly onEvent: (event: DictationServerEvent) => void;
  /** Aborting it is `close()`. */
  readonly signal?: AbortSignal;
  /** The socket factory; the platform's `WebSocket` by default. */
  readonly openSocket?: (url: string) => DictationSocket;
  /** How long `end()` waits for Alia's `dictation.closed` before closing the socket. */
  readonly endTimeoutMs?: number;
};

export interface DictationStream {
  /** One microphone frame: PCM16 LE, mono, {@link DICTATION_SAMPLE_RATE} Hz. */
  append(pcm16: Uint8Array): void;
  /** End the current segment now (push-to-talk). */
  commit(): void;
  /** No more audio: resolves with how the dictation closed, once the finals have arrived. */
  end(): Promise<DictationCloseReason>;
  /** Drop the dictation now; nothing more is reported. */
  close(): void;
  /** Settles with how the dictation closed, whatever closed it. */
  readonly closed: Promise<DictationCloseReason>;
}

const OPEN = 1;
const DEFAULT_END_TIMEOUT_MS = 8_000;
/** Audio held until the socket is open and the start sent: ten seconds. */
const MAX_HELD_BYTES = 10 * DICTATION_SAMPLE_RATE * 2;

function defaultSocket(url: string): DictationSocket {
  const WebSocketClass = (globalThis as { WebSocket?: new (url: string) => DictationSocket })
    .WebSocket;
  if (!WebSocketClass) throw new Error('This platform has no WebSocket');
  return new WebSocketClass(url);
}

/** Open one streaming dictation. */
export function openDictationStream(options: DictationStreamOptions): DictationStream {
  const url = dictationStreamUrl(options.apiUrl);
  const credentialAbort = new AbortController();
  let socket: DictationSocket | null = null;
  let started = false;
  let finished = false;
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  let endRequested = false;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveClosed!: (reason: DictationCloseReason) => void;
  const closed = new Promise<DictationCloseReason>((resolve) => {
    resolveClosed = resolve;
  });

  const sendEvent = (event: DictationClientEvent) => {
    if (socket?.readyState === OPEN) socket.send(JSON.stringify(event));
  };

  const finish = (reason: DictationCloseReason, report: boolean) => {
    if (finished) return;
    finished = true;
    if (endTimer !== null) clearTimeout(endTimer);
    credentialAbort.abort();
    held = [];
    const current = socket;
    socket = null;
    if (current) {
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
      if (current.readyState === OPEN || current.readyState === 0) current.close(1000);
    }
    if (report) options.onEvent({ type: 'dictation.closed', reason });
    resolveClosed(reason);
  };

  const fail = () => {
    if (finished) return;
    options.onEvent({
      type: 'error',
      code: 'TRANSCRIPTION_FAILED',
      message: 'The dictation lost its connection to Alia.',
      retryable: true,
    });
    finish('error', true);
  };

  const readToken = async (): Promise<string | null> => {
    if (options.token !== undefined) return options.token || null;
    try {
      const token = await options.getToken(url, { signal: credentialAbort.signal });
      return token || null;
    } catch {
      return null;
    }
  };

  const begin = async (opened: DictationSocket) => {
    const token = await readToken();
    if (finished || socket !== opened) return;
    if (!token) {
      options.onEvent({
        type: 'error',
        code: 'NOT_AUTHENTICATED',
        message: 'Sign in to Alia to dictate.',
        retryable: false,
      });
      finish('error', true);
      return;
    }
    sendEvent({ type: 'auth', token });
    sendEvent({
      type: 'dictation.start',
      protocol: DICTATION_PROTOCOL_VERSION,
      sampleRate: DICTATION_SAMPLE_RATE,
      ...(options.language === undefined ? {} : { language: options.language }),
    });
    started = true;
    for (const frame of held) opened.send(frame);
    held = [];
    heldBytes = 0;
    if (endRequested) sendEvent({ type: 'dictation.end' });
  };

  try {
    socket = (options.openSocket ?? defaultSocket)(url);
  } catch {
    queueMicrotask(fail);
  }
  if (socket) {
    const opened = socket;
    opened.binaryType = 'arraybuffer';
    opened.onopen = () => {
      void begin(opened);
    };
    opened.onmessage = (message) => {
      if (typeof message.data !== 'string') return;
      const event = parseDictationServerEvent(message.data);
      if (event === null || finished) return;
      if (event.type === 'dictation.closed') {
        options.onEvent(event);
        finish(event.reason, false);
        return;
      }
      options.onEvent(event);
    };
    opened.onclose = () => fail();
    opened.onerror = () => undefined;
  }

  const close = () => finish('ended', false);
  if (options.signal) {
    if (options.signal.aborted) queueMicrotask(close);
    else options.signal.addEventListener('abort', close, { once: true });
  }

  return {
    append(pcm16) {
      if (finished || endRequested || pcm16.byteLength === 0) return;
      if (started && socket?.readyState === OPEN) {
        socket.send(pcm16);
        return;
      }
      if (heldBytes + pcm16.byteLength > MAX_HELD_BYTES) return;
      held.push(pcm16.slice());
      heldBytes += pcm16.byteLength;
    },
    commit() {
      if (!finished && started) sendEvent({ type: 'dictation.commit' });
    },
    end() {
      if (finished) return closed;
      if (!endRequested) {
        endRequested = true;
        if (started) sendEvent({ type: 'dictation.end' });
        endTimer = setTimeout(
          () => finish('ended', true),
          options.endTimeoutMs ?? DEFAULT_END_TIMEOUT_MS,
        );
      }
      return closed;
    },
    close,
    closed,
  };
}
