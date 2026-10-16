/**
 * `GET /v1/voice/session` — the voice call's WebSocket (ADR 0017 §1, §3).
 *
 * Mounted with `ws` in `noServer` mode on the shared HTTP server, exactly as
 * `lib/mcp-relay.ts` is, so socket.io's handshake on the same server is never
 * stomped: only this path's upgrades are taken here. The protocol is in
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
import { authenticateSocketToken } from '../socket-session-auth.js';
import { type VoiceCallEnvironment, type VoiceClientSink, VoiceCall } from './call.js';
import { createVoiceEnvironment } from './environment.js';
import { VOICE_ERROR_TEXT } from './errors.js';
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
  environment?: () => VoiceCallEnvironment;
  /** Token → Oxy user id; tests replace the Oxy round trip. */
  authenticate?: (token: string) => Promise<string | null>;
}

function isMachineCredential(token: string): boolean {
  return token.startsWith('oxy_sk_');
}

/** Serve one connection: auth, then start or resume a call. */
export function handleVoiceConnection(ws: WebSocket, options: VoiceSocketOptions = {}): void {
  const authenticate = options.authenticate ?? authenticateSocketToken;
  const environment = options.environment ?? createVoiceEnvironment;
  let oxyUserId: string | null = null;
  let token: string | null = null;
  let call: VoiceCall | null = null;
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
    if (isBinary) {
      if (!call) return;
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
        .then((id) => {
          authenticating = false;
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
        if (event.protocol !== VOICE_PROTOCOL_VERSION) {
          refuse('invalid-request', 4400);
          return;
        }
        const started = new VoiceCall(environment(), oxyUserId, token);
        call = started;
        liveCalls.set(started.id, started);
        started.attach(sink);
        // The map holds a call only while it can be resumed.
        void started.ended.then(() => liveCalls.delete(started.id));
        void started.open({
          conversationId: event.conversationId,
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          voice: event.voice,
          locale: event.locale,
        });
        return;
      }
      case 'session.resume': {
        if (call) return;
        const held = liveCalls.get(event.voiceSessionId);
        if (
          event.protocol !== VOICE_PROTOCOL_VERSION ||
          !held ||
          held.oxyUserId !== oxyUserId ||
          !held.attach(sink, event.afterSeq)
        ) {
          // Sticky routing should bring a resume here; a task that died cannot serve it.
          refuse('resume-unavailable', 4404);
          return;
        }
        held.setAccessToken(token);
        call = held;
        return;
      }
      case 'playback.interrupted':
        call?.onPlaybackInterrupted(event.itemId, event.playedMs);
        return;
      case 'session.end':
        void call?.end('hangup');
        return;
    }
  });

  ws.on('close', (closeCode) => {
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

/** Mount `GET /v1/voice/session` on the shared HTTP server. */
export function initVoiceSessions(
  server: http.Server,
  observe?: (socket: WebSocket, headers: http.IncomingHttpHeaders) => void,
  options: VoiceSocketOptions = {},
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '', 'http://internal');
    if (pathname !== VOICE_SESSION_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
    observe?.(ws, request.headers);
    handleVoiceConnection(ws, options);
  });
  log.voice.info(`Voice sessions at ${VOICE_SESSION_PATH}`);
  return wss;
}

/** Shutdown: every call held here ends `server-shutdown` (after the deploy's drain window). */
export async function shutdownVoiceSessions(): Promise<void> {
  const calls = [...liveCalls.values()];
  liveCalls.clear();
  await Promise.all(calls.map((call) => call.end('server-shutdown')));
}
