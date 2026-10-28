/**
 * `GET /v1/audio/transcriptions/stream` — streaming dictation's WebSocket
 * (ADR 0024).
 *
 * A `ws` server in `noServer` mode, handed its path's upgrades by the one
 * upgrade router (`lib/websocket-upgrades.ts`). The protocol is in
 * `./protocol.ts`; the dictation in `./stream.ts`.
 *
 * Only a person's Oxy session (the first message carries it; a browser cannot
 * set a header on a WebSocket). An `oxy_sk_` machine credential is refused
 * with `CREDENTIAL_NOT_SUPPORTED`, as the batch route refuses one: what is free
 * here is the person's dictation, not transcription as a service. A client may
 * send `auth` and `dictation.start` back to back, and audio before
 * `dictation.ready`: the start waits for the authentication, and the audio is
 * held while the session opens.
 */

import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { getKaanaClient } from '../kaana/transport.js';
import type { KaanaClient } from '../kaana/port.js';
import { log } from '../logger.js';
import { authenticateSocketSession, type SocketSession } from '../socket-session-auth.js';
import { TranscriptionError } from '../voice/transcribe.js';
import type { WebSocketRoute } from '../websocket-upgrades.js';
import {
  DICTATION_PROTOCOL_VERSION,
  DICTATION_STREAM_PATH,
  type DictationServerEvent,
  type DictationStreamErrorCode,
  parseDictationClientEvent,
} from './protocol.js';
import { DICTATION_STREAM_LIMITS, DictationStream, type DictationStreamLimits } from './stream.js';

const AUTH_TIMEOUT_MS = 5_000;
/** Pings keep the ALB's and Cloudflare's idle timers from cutting a quiet socket. */
const PING_INTERVAL_MS = 20_000;
/** One frame's ceiling; microphone frames are a few KB. */
const MAX_PAYLOAD_BYTES = 256 * 1024;

const ACCESS_TEXT: Readonly<Record<'NOT_AUTHENTICATED' | 'CREDENTIAL_NOT_SUPPORTED', string>> = {
  NOT_AUTHENTICATED: 'Sign in to Alia to dictate.',
  CREDENTIAL_NOT_SUPPORTED: 'Dictation takes a person’s session.',
};

/** Dictations held by this task, for shutdown. */
const liveDictations = new Set<DictationStream>();

export interface DictationAdmission {
  readonly allowed: boolean;
  readonly retryAfterMs?: number;
}

export interface DictationSocketOptions {
  /** Token → the Oxy person and session; tests replace the Oxy round trip. */
  authenticate?: (token: string) => Promise<SocketSession | null>;
  /** The `/v1` per-person rate limit, one request per dictation; tests replace it. */
  admit?: (oxyUserId: string) => Promise<DictationAdmission>;
  /** The Kaana client a dictation runs on; tests pass the fake's. */
  kaana?: (oxyUserId: string) => KaanaClient | null;
  limits?: Partial<DictationStreamLimits>;
}

/** The same sliding window every `/v1` request counts against; it fails open, as the middleware does. */
async function admitByRateLimit(oxyUserId: string): Promise<DictationAdmission> {
  try {
    const { getUserTier } = await import('../../middleware/api-key-rate-limit.js');
    const { checkLimit } = await import('../sliding-window-limiter.js');
    const result = await checkLimit(oxyUserId, await getUserTier(oxyUserId));
    if (result.allowed) return { allowed: true };
    return {
      allowed: false,
      ...(result.resetInSeconds === undefined
        ? {}
        : { retryAfterMs: result.resetInSeconds * 1000 }),
    };
  } catch (error) {
    log.rateLimit.error({ err: error }, 'Dictation rate limit check error');
    return { allowed: true };
  }
}

/** Serve one connection: auth, then one dictation. */
export function handleDictationConnection(
  ws: WebSocket,
  options: DictationSocketOptions = {},
): void {
  const authenticate = options.authenticate ?? authenticateSocketSession;
  const admit = options.admit ?? admitByRateLimit;
  const kaanaFor = options.kaana ?? getKaanaClient;
  const limits = { ...DICTATION_STREAM_LIMITS, ...options.limits };
  let oxyUserId: string | null = null;
  let authenticating = false;
  let queuedStart: { language?: string } | null = null;
  let starting = false;
  let stream: DictationStream | null = null;
  let closedHere = false;
  /** Audio sent between `dictation.start` and the stream existing (the rate check). */
  const early: Uint8Array[] = [];

  const send = (event: DictationServerEvent) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };
  const closeSocket = (code: number, reason: string) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    closedHere = true;
    ws.close(code, reason);
  };
  const refuse = (
    code: DictationStreamErrorCode,
    closeCode: number,
    failure: { message?: string; retryable?: boolean } = {},
  ) => {
    send({
      type: 'error',
      code,
      message:
        failure.message ??
        (code === 'NOT_AUTHENTICATED' || code === 'CREDENTIAL_NOT_SUPPORTED'
          ? ACCESS_TEXT[code]
          : new TranscriptionError(code).message),
      retryable: failure.retryable ?? false,
    });
    send({ type: 'dictation.closed', reason: 'error' });
    closeSocket(closeCode, code);
  };

  const start = async (language: string | undefined) => {
    if (stream || starting || oxyUserId === null) return;
    starting = true;
    const owner = oxyUserId;
    const admission = await admit(owner);
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!admission.allowed) {
      const limited = new TranscriptionError('TRANSCRIPTION_LIMITED', {
        retryable: true,
        ...(admission.retryAfterMs === undefined ? {} : { retryAfterMs: admission.retryAfterMs }),
      });
      refuse('TRANSCRIPTION_LIMITED', 4429, { message: limited.message, retryable: true });
      return;
    }
    const dictation = new DictationStream(
      kaanaFor(owner),
      owner,
      {
        send,
        close: () => closeSocket(1000, 'dictation ended'),
      },
      limits,
    );
    stream = dictation;
    liveDictations.add(dictation);
    void dictation.ended.finally(() => liveDictations.delete(dictation));
    for (const frame of early) dictation.audio(frame);
    early.length = 0;
    await dictation.open(language);
  };

  const authTimer = setTimeout(() => {
    if (oxyUserId === null) refuse('NOT_AUTHENTICATED', 4001);
  }, AUTH_TIMEOUT_MS);
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, PING_INTERVAL_MS);
  ping.unref?.();

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      const frame = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (stream) stream.audio(frame);
      else if ((starting || queuedStart) && early.length < 256) early.push(frame.slice());
      return;
    }
    const event = parseDictationClientEvent(data.toString());
    if (event === null) {
      if (!stream) refuse('INVALID_REQUEST', 4400);
      return;
    }
    switch (event.type) {
      case 'auth': {
        if (authenticating) return;
        if (event.token.startsWith('oxy_sk_')) {
          refuse('CREDENTIAL_NOT_SUPPORTED', 4003);
          return;
        }
        authenticating = true;
        void authenticate(event.token)
          .catch(() => null)
          .then((session) => {
            authenticating = false;
            if (ws.readyState !== WebSocket.OPEN) return;
            const id = session?.userId ?? null;
            if (id === null || (oxyUserId !== null && id !== oxyUserId)) {
              refuse('NOT_AUTHENTICATED', 4003);
              void stream?.abort('client-gone');
              return;
            }
            clearTimeout(authTimer);
            oxyUserId = id;
            if (queuedStart) {
              const queued = queuedStart;
              queuedStart = null;
              void start(queued.language);
            }
          });
        return;
      }
      case 'dictation.start': {
        if (stream || starting || queuedStart) return;
        if (event.protocol !== DICTATION_PROTOCOL_VERSION) {
          refuse('INVALID_REQUEST', 4400);
          return;
        }
        const request = event.language === undefined ? {} : { language: event.language };
        if (oxyUserId === null) {
          if (authenticating) queuedStart = request;
          else refuse('NOT_AUTHENTICATED', 4001);
          return;
        }
        void start(request.language);
        return;
      }
      case 'dictation.commit':
        stream?.commit();
        return;
      case 'dictation.end':
        if (stream) void stream.end();
        else closeSocket(1000, 'dictation ended');
        return;
    }
  });

  ws.on('close', (closeCode) => {
    clearTimeout(authTimer);
    clearInterval(ping);
    queuedStart = null;
    early.length = 0;
    if (!closedHere && closeCode !== 1000)
      log.voice.info({ closeCode, dictationId: stream?.id ?? null }, 'Dictation socket dropped');
    void stream?.abort('client-gone');
  });

  ws.on('error', (err) => {
    log.voice.warn({ err }, 'Dictation socket error');
  });
}

/** `GET /v1/audio/transcriptions/stream`, as a route of the upgrade router. */
export function dictationStreamRoute(
  observe?: (socket: WebSocket, headers: http.IncomingHttpHeaders) => void,
  options: DictationSocketOptions = {},
): WebSocketRoute {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
    observe?.(ws, request.headers);
    handleDictationConnection(ws, options);
  });
  log.voice.info(`Streaming dictation at ${DICTATION_STREAM_PATH}`);
  return {
    path: DICTATION_STREAM_PATH,
    handleUpgrade: (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    },
  };
}

/** Shutdown: every dictation held here ends `server-shutdown`. */
export async function shutdownDictations(): Promise<void> {
  const dictations = [...liveDictations];
  liveDictations.clear();
  await Promise.all(dictations.map((dictation) => dictation.abort('server-shutdown')));
}
