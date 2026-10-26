/**
 * `GET /v1/voice/session` — the voice call's WebSocket (ADR 0017 §1, §3).
 *
 * A `ws` server in `noServer` mode, handed its path's upgrades by the one
 * upgrade router (`lib/websocket-upgrades.ts`). The protocol is in
 * `./protocol.ts`; the call itself in `./call.ts`.
 *
 * ## Who may call
 *
 * Only a person's Oxy session from Alia's own apps (the first message carries
 * it; a browser cannot set a header on a WebSocket). An `oxy_sk_` machine
 * credential is refused with `credential-not-supported`: opening the route to
 * third parties is a later, separate decision.
 */

import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { log } from '../logger.js';
import { verifySurface } from '../app-surface.js';
import { authenticateSocketSession, type SocketSession } from '../socket-session-auth.js';
import type { WebSocketRoute } from '../websocket-upgrades.js';
import { type VoiceCallEnvironment, type VoiceClientSink, VoiceCall } from './call.js';
import { createVoiceEnvironment } from './environment.js';
import { VOICE_ERROR_TEXT } from './errors.js';
import {
  relayVoiceResume,
  type VoicePeerAuth,
  type VoicePeerConnection,
  voicePeerRoute,
} from './peer-relay.js';
import { productionVoiceRouting, type VoiceRouting } from './routing-directory.js';
import {
  parseVoiceClientEvent,
  type SequencedVoiceEvent,
  VOICE_PROTOCOL_VERSION,
  VOICE_SESSION_PATH,
  type VoicePreSessionEvent,
  type VoiceServerErrorCode,
} from './protocol.js';

const AUTH_TIMEOUT_MS = 5_000;
/** Pings keep the ALB's and Cloudflare's idle timers from cutting a quiet call. */
const PING_INTERVAL_MS = 20_000;
/** Above this much unsent data the socket is behind: assistant audio is dropped, events are not. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/** One frame's ceiling; audio frames are ~2 KB and events far smaller. */
const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Calls held by this task, by `voiceSessionId`, for `session.resume`. */
const liveCalls = new Map<string, VoiceCall>();

export interface VoiceSocketOptions {
  /** The call's world; tests pass one built on the Kaana fake. */
  environment?: (accountId: string) => VoiceCallEnvironment;
  /** Token → the Oxy person and session; tests replace the Oxy round trip. */
  authenticate?: (token: string) => Promise<SocketSession | null>;
  /** The app assertion → its application, for that session (`lib/app-surface.ts`); tests replace it. */
  surface?: (assertion: string | undefined, session: SocketSession) => Promise<string | null>;
  routing?: () => Promise<VoiceRouting | null>;
  peerAuth?: VoicePeerAuth;
  /** Instance-owned calls; injected only to exercise separate tasks in real-wire tests. */
  calls?: Map<string, VoiceCall>;
  /** Private peer connections cannot open calls or forward to another task. */
  resumeOnly?: boolean;
}

function isMachineCredential(token: string): boolean {
  return token.startsWith('oxy_sk_');
}

/** Serve one connection: auth, then start or resume a call. */
export function handleVoiceConnection(ws: WebSocket, options: VoiceSocketOptions = {}): void {
  const authenticate = options.authenticate ?? authenticateSocketSession;
  const surfaceOf =
    options.surface ??
    ((assertion: string | undefined, session: SocketSession) =>
      verifySurface(assertion, session).catch(() => null));
  const environment = options.environment ?? createVoiceEnvironment;
  const calls = options.calls ?? liveCalls;
  const routing = options.routing ?? productionVoiceRouting;
  const lifetime = new AbortController();
  let authFrame: string | null = null;
  let peer: VoicePeerConnection | null = null;
  let resuming = false;
  let oxyUserId: string | null = null;
  let token: string | null = null;
  /** The app the call comes from, by the latest `auth`'s assertion (ADR 0021). */
  let surfaceApplicationId: string | null = null;
  let call: VoiceCall | null = null;
  let pendingStart = false;
  let authenticating = false;
  const connectedAt = Date.now();
  /** Whether this side sent the close frame; otherwise the device or the network ended it. */
  let closedHere = false;

  const sendPre = (event: VoicePreSessionEvent) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  };
  const refuse = (code: VoiceServerErrorCode, closeCode: number) => {
    sendPre({
      type: 'error',
      code,
      message: VOICE_ERROR_TEXT[code],
      retryable: false,
      reference: `voice-${Date.now().toString(36)}`,
    });
    closedHere = true;
    ws.close(closeCode, code);
  };

  let droppedAudio = false;
  const sink: VoiceClientSink = {
    sendEvent: (event: SequencedVoiceEvent) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    },
    sendAudio: (frame) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        if (!droppedAudio) log.voice.warn('Voice socket is behind; dropping assistant audio');
        droppedAudio = true;
        return;
      }
      droppedAudio = false;
      ws.send(frame, { binary: true });
    },
    close: () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      closedHere = true;
      ws.close(1000, 'call ended');
    },
  };

  const authTimer = setTimeout(() => {
    if (oxyUserId === null) refuse('not-authenticated', 4001);
  }, AUTH_TIMEOUT_MS);
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, PING_INTERVAL_MS);
  ping.unref?.();

  ws.on('message', (data, isBinary) => {
    // A superseded socket cannot refresh credentials, inject audio or end the
    // call while its close handshake is still in flight.
    if (call && !pendingStart && !call.hasClient(sink)) return;
    if (peer) {
      peer.send(data, isBinary);
      return;
    }
    if (resuming) {
      if (!isBinary && parseVoiceClientEvent(data.toString())?.type === 'session.end') {
        lifetime.abort();
        sink.close();
      }
      return;
    }
    if (isBinary) {
      if (!call || pendingStart) return;
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      call.onClientAudio(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return;
    }
    const event = parseVoiceClientEvent(data.toString());
    if (event === null) {
      if (oxyUserId === null) refuse('invalid-request', 4400);
      return;
    }

    if (event.type === 'auth') {
      if (authenticating) return;
      if (isMachineCredential(event.token)) {
        refuse('credential-not-supported', 4003);
        return;
      }
      authenticating = true;
      void authenticate(event.token)
        .catch(() => null)
        .then(async (session) => {
          const surface = session === null ? null : await surfaceOf(event.appAssertion, session);
          return { id: session?.userId ?? null, surface };
        })
        .then(({ id, surface }) => {
          authenticating = false;
          if (lifetime.signal.aborted) return;
          if (id === null) {
            refuse('not-authenticated', 4003);
            return;
          }
          if (oxyUserId !== null && id !== oxyUserId) {
            // A refreshed token must be the same person's.
            refuse('not-authenticated', 4003);
            void call?.end('hangup');
            return;
          }
          clearTimeout(authTimer);
          const first = oxyUserId === null;
          oxyUserId = id;
          token = event.token;
          authFrame = JSON.stringify(event);
          surfaceApplicationId = surface;
          call?.setAccessToken(event.token);
          if (first) sendPre({ type: 'auth.ok' });
        });
      return;
    }

    if (oxyUserId === null || token === null) {
      refuse('not-authenticated', 4001);
      return;
    }

    switch (event.type) {
      case 'session.start': {
        if (call) return;
        if (options.resumeOnly || event.protocol !== VOICE_PROTOCOL_VERSION) {
          refuse('invalid-request', 4400);
          return;
        }
        const started = new VoiceCall(environment(oxyUserId), oxyUserId, token);
        call = started;
        pendingStart = true;
        const owner = oxyUserId;
        void (async () => {
          // Publish before any accepted frame exposes this session to a reconnect.
          const directory = await routing();
          const lease = await directory?.register(started.id, owner);
          void started.ended.finally(() => {
            calls.delete(started.id);
            void lease?.release().catch(() => undefined);
          });
          if (lifetime.signal.aborted) {
            pendingStart = false;
            await started.end('hangup');
            return;
          }
          pendingStart = false;
          calls.set(started.id, started);
          started.attach(sink);
          await started.open({
            conversationId: event.conversationId,
            ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
            voice: event.voice,
            locale: event.locale,
            surfaceApplicationId,
          });
        })().catch(() => {
          pendingStart = false;
          refuse('realtime-unavailable', 4503);
          void started.end('error');
        });
        return;
      }
      case 'session.resume': {
        if (call) return;
        const held = calls.get(event.voiceSessionId);
        if (
          event.protocol !== VOICE_PROTOCOL_VERSION ||
          (held && (held.oxyUserId !== oxyUserId || !held.attach(sink, event.afterSeq)))
        ) {
          refuse('resume-unavailable', 4404);
          return;
        }
        if (held) {
          held.setAccessToken(token);
          call = held;
          return;
        }
        if (options.resumeOnly || !authFrame) {
          refuse('resume-unavailable', 4404);
          return;
        }
        resuming = true;
        const originalAuth = authFrame;
        const owner = oxyUserId;
        void (async () => {
          const directory = await routing();
          const route = await directory?.find(event.voiceSessionId, owner);
          if (!directory || !route || route.generation === directory.generation)
            throw new Error('Voice owner unavailable');
          peer = await relayVoiceResume({
            client: ws,
            routing: directory,
            route,
            authFrame: originalAuth,
            resumeFrame: JSON.stringify(event),
            signal: lifetime.signal,
            auth: options.peerAuth,
          });
          if (lifetime.signal.aborted) peer.close();
        })()
          .catch(() => {
            if (!lifetime.signal.aborted) refuse('resume-unavailable', 4404);
          })
          .finally(() => {
            resuming = false;
          });
        return;
      }
      case 'playback.interrupted':
        call?.onPlaybackInterrupted(event.itemId, event.playedMs);
        return;
      case 'session.end':
        if (pendingStart) {
          // Stop is meaningful before admission too. Closing the socket aborts
          // the pending open; any lease that arrives later is released by ended.
          lifetime.abort();
          sink.close();
        }
        void call?.end('hangup');
        return;
    }
  });

  ws.on('close', (closeCode) => {
    lifetime.abort();
    peer?.close();
    clearTimeout(authTimer);
    clearInterval(ping);
    // The close code is the only trace of a drop: 1006 is the network or the
    // load balancer, 1001 the device going away, 1002/1007/1009 a frame the
    // device refused. A drop with a call attached is what `session.resume` heals.
    const fields = {
      closeCode,
      closedHere,
      connectedMs: Date.now() - connectedAt,
      callId: call?.callId ?? null,
    };
    if (closedHere || closeCode === 1000) log.voice.info(fields, 'Voice socket closed');
    else log.voice.warn(fields, 'Voice socket dropped');
    // Not a hang-up: the call waits out the resume window.
    call?.detach(sink);
  });

  ws.on('error', (err) => {
    log.voice.warn({ err }, 'Voice socket error');
  });
}

/** Private one-hop sibling route; the original person still passes ordinary socket auth. */
export function voiceResumePeerRoute(options: VoiceSocketOptions = {}): WebSocketRoute {
  return voicePeerRoute({
    routing: options.routing ?? productionVoiceRouting,
    auth: options.peerAuth,
    accept: (socket) => handleVoiceConnection(socket, { ...options, resumeOnly: true }),
  });
}

/** `GET /v1/voice/session`, as a route of the upgrade router. */
export function voiceSessionRoute(
  observe?: (socket: WebSocket, headers: http.IncomingHttpHeaders) => void,
  options: VoiceSocketOptions = {},
): WebSocketRoute {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
    observe?.(ws, request.headers);
    handleVoiceConnection(ws, options);
  });
  log.voice.info(`Voice sessions at ${VOICE_SESSION_PATH}`);
  return {
    path: VOICE_SESSION_PATH,
    handleUpgrade: (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    },
  };
}

/** Shutdown: every call held here ends `server-shutdown` (after the deploy's drain window). */
export async function shutdownVoiceSessions(): Promise<void> {
  const calls = [...liveCalls.values()];
  liveCalls.clear();
  await Promise.all(calls.map((call) => call.end('server-shutdown')));
}
