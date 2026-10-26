/** One-hop socket relay. Authentication stays in Oxy and in the existing voice handler. */
import type http from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  ALIA_API_WORKLOAD_ID,
  ALIA_SERVICE_AUDIENCE,
  isAliaWorkload,
} from '@alia.onl/server/internal';
import { oxyServiceClient } from '../oxy-service-client.js';
import type { WebSocketRoute } from '../websocket-upgrades.js';
import { VOICE_PEER_PATH, type VoiceRoute, type VoiceRouting } from './routing-directory.js';

const FRAME_LIMIT = 256 * 1024;
const BUFFER_LIMIT = 2 * 1024 * 1024;
const HANDSHAKE_MS = 5_000;

export interface VoicePeerAuth {
  token(url: string, signal: AbortSignal): Promise<string>;
  verify(token: string): Promise<boolean>;
}

export const productionVoicePeerAuth: VoicePeerAuth = {
  async token(url, signal) {
    const oxy = oxyServiceClient();
    if (!oxy) throw new Error('Voice peer workload unavailable');
    const target = new URL(url);
    target.protocol = 'http:';
    const transport = oxy.createServiceClient({
      baseURL: target.origin,
      audience: ALIA_SERVICE_AUDIENCE,
    });
    try {
      return await transport.getAccessToken(url, { signal });
    } finally {
      transport.dispose();
    }
  },
  async verify(token) {
    const oxy = oxyServiceClient();
    if (!oxy) return false;
    try {
      const principal = await oxy.introspectServiceToken(token);
      return (
        principal.active &&
        principal.audience === ALIA_SERVICE_AUDIENCE &&
        isAliaWorkload(principal, process.env.ALIA_API_WORKLOAD_ID || ALIA_API_WORKLOAD_ID)
      );
    } catch {
      return false;
    }
  },
};

function byteLength(data: RawData): number {
  return Array.isArray(data)
    ? data.reduce((sum, part) => sum + part.byteLength, 0)
    : data.byteLength;
}

function sendBounded(socket: WebSocket, data: RawData, binary: boolean): boolean {
  if (
    socket.readyState !== WebSocket.OPEN ||
    byteLength(data) > FRAME_LIMIT ||
    socket.bufferedAmount + byteLength(data) > BUFFER_LIMIT
  ) {
    socket.terminate();
    return false;
  }
  socket.send(data, { binary }, (error) => {
    if (error) socket.terminate();
  });
  return true;
}

function nextText(socket: WebSocket, signal: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      socket.off('message', message);
      socket.off('close', closed);
      socket.off('error', closed);
      signal.removeEventListener('abort', aborted);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const closed = () => finish(new Error('Voice peer disconnected'));
    const aborted = () => finish(new Error('Voice peer cancelled'));
    const message = (data: RawData, binary: boolean) => {
      try {
        if (binary || byteLength(data) > FRAME_LIMIT) throw new Error('Invalid voice peer frame');
        const value: unknown = JSON.parse(data.toString());
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Invalid voice peer frame');
        finish(undefined, value as Record<string, unknown>);
      } catch {
        finish(new Error('Invalid voice peer frame'));
      }
    };
    const timer = setTimeout(() => finish(new Error('Voice peer timed out')), HANDSHAKE_MS);
    socket.once('message', message);
    socket.once('close', closed);
    socket.once('error', closed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function withinHandshake<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('Voice peer handshake expired'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    void operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
}

export interface VoicePeerConnection {
  send(data: RawData, binary: boolean): void;
  close(): void;
}

/** Router authenticates the person before calling; owner independently verifies the original proof. */
export async function relayVoiceResume(input: {
  client: WebSocket;
  routing: VoiceRouting;
  route: VoiceRoute;
  authFrame: string;
  resumeFrame: string;
  signal: AbortSignal;
  auth?: VoicePeerAuth;
}): Promise<VoicePeerConnection> {
  const url = input.routing.peerUrl(input.route);
  const handshake = AbortSignal.any([input.signal, AbortSignal.timeout(HANDSHAKE_MS)]);
  const peer = new WebSocket(url, {
    followRedirects: false,
    maxPayload: FRAME_LIMIT,
    handshakeTimeout: HANDSHAKE_MS,
  });
  const stop = () => peer.terminate();
  input.signal.addEventListener('abort', stop, { once: true });
  // Retain an error listener throughout handshake transitions; never log bearer frames.
  peer.on('error', () => {});
  const cleanup = () => input.signal.removeEventListener('abort', stop);
  peer.once('close', cleanup);
  try {
    if (input.signal.aborted) throw new Error('Voice peer cancelled');
    // nextText installs before the upgrade completes, so a fast greeting cannot be lost.
    const hello = await nextText(peer, handshake);
    if (hello.type !== 'alia.voice.peer' || hello.generation !== input.route.generation)
      throw new Error('Voice peer owner changed');
    const token = await withinHandshake(
      (input.auth ?? productionVoicePeerAuth).token(url, handshake),
      handshake,
    );
    if (input.signal.aborted || input.route.expiresAt <= Date.now())
      throw new Error('Voice route expired');
    const ready = nextText(peer, handshake);
    peer.send(JSON.stringify({ type: 'alia.voice.peer.auth', token }));
    if ((await ready).type !== 'alia.voice.peer.ready') throw new Error('Voice peer refused');
    const authenticated = nextText(peer, handshake);
    peer.send(input.authFrame);
    if ((await authenticated).type !== 'auth.ok') throw new Error('Voice session refused');
    peer.on('message', (data: RawData, binary) => {
      if (!sendBounded(input.client, data, binary)) stop();
    });
    peer.once('close', (code) => {
      if (input.client.readyState === WebSocket.OPEN) {
        if (code === 1000 || (code >= 4000 && code <= 4999)) input.client.close(code);
        else input.client.terminate();
      }
    });
    peer.send(input.resumeFrame);
    return {
      send(data, binary) {
        if (!sendBounded(peer, data, binary)) input.client.terminate();
      },
      close() {
        cleanup();
        stop();
      },
    };
  } catch (error) {
    cleanup();
    stop();
    throw error;
  }
}

/** Fixed, bounded health greeting reveals only an opaque generation, never session metadata. */
export function voicePeerRoute(input: {
  routing(): Promise<VoiceRouting | null>;
  accept(socket: WebSocket): void;
  auth?: VoicePeerAuth;
}): WebSocketRoute {
  const server = new WebSocketServer({ noServer: true, maxPayload: FRAME_LIMIT });
  server.on('connection', (socket: WebSocket) => {
    socket.on('error', () => {});
    const abort = new AbortController();
    const handshake = AbortSignal.any([abort.signal, AbortSignal.timeout(HANDSHAKE_MS)]);
    const closed = () => abort.abort();
    socket.once('close', closed);
    void (async () => {
      const routing = await input.routing();
      if (!routing || socket.readyState !== WebSocket.OPEN)
        throw new Error('Voice peer unavailable');
      const credential = nextText(socket, handshake);
      socket.send(JSON.stringify({ type: 'alia.voice.peer', generation: routing.generation }));
      const frame = await credential;
      if (
        frame.type !== 'alia.voice.peer.auth' ||
        typeof frame.token !== 'string' ||
        frame.token.length > 16_384 ||
        !(await withinHandshake(
          (input.auth ?? productionVoicePeerAuth).verify(frame.token),
          handshake,
        )) ||
        socket.readyState !== WebSocket.OPEN
      )
        throw new Error('Voice peer refused');
      socket.off('close', closed);
      input.accept(socket); // resume-only handler: no new call, no further forwarding.
      socket.send(JSON.stringify({ type: 'alia.voice.peer.ready' }));
    })().catch(() => {
      socket.close(4403, 'voice peer unavailable');
    });
  });
  return {
    path: VOICE_PEER_PATH,
    handleUpgrade(request: http.IncomingMessage, socket, head) {
      // ALB/Cloudflare ingress is not a peer. Do not expose even the opaque
      // greeting through forwarded public requests or a caller-selected host.
      if (
        Object.keys(request.headers).some(
          (name) =>
            name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'cf-connecting-ip',
        )
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      void input
        .routing()
        .then((routing) => {
          if (
            !routing?.permitsPeer(request.socket.remoteAddress ?? '', request.headers.host ?? '')
          ) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
          }
          if (!socket.destroyed)
            server.handleUpgrade(request, socket, head, (ws) => server.emit('connection', ws));
        })
        .catch(() => socket.destroy());
    },
  };
}
