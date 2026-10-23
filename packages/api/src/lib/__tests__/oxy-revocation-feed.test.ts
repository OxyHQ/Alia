import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  OXY_SERVICE_EVENTS_HEARTBEAT_EVENT,
  OXY_SERVICE_EVENTS_NAMESPACE,
  OXY_SESSION_REVOKED_EVENT,
} from '@oxy.so/contracts';
import { OxyServer } from '@oxy.so/core/server';
import { Server as SocketIoServer } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `@oxy.so/core`'s session-revocation feed, opened for real on the API's runtime.
 *
 * Since core 6.9.0 `OxyServer` opens a Socket.IO connection to Oxy's
 * `/service-events` by itself, the first time a session validation could be
 * cached, and only in a process that can mint a service token. Every other test
 * process cannot (no credential, no ECS task role), so no other suite ever opens
 * it — and 6.9.0's feed crashed every Bun process that did (`this.ws._socket.unref`
 * in engine.io-client: Bun's `ws` has no `_socket`), a crash loop on ECS behind a
 * green CI. Here the client holds a (fake) credential, so the feed opens exactly
 * as it does in production.
 *
 * This file runs on Node (vitest) AND on Bun (`test:bun-runtime`, the API's
 * runtime). An uncaught exception from the feed fails either run.
 *
 * Nothing stubs `@oxy.so/core`: the fake is Oxy itself — an HTTP server answering
 * the service-token mint and `GET /session/validate-header/:id`, with the
 * `/service-events` namespace on the same origin.
 */

function unsignedJwt(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'EdDSA', typ: 'JWT' })}.${part(claims)}.not-a-signature`;
}

interface FakeOxy {
  baseURL: string;
  io: SocketIoServer;
  /** Session id → the user it speaks as; a missing id is a session Oxy ended. */
  sessions: Map<string, string>;
  /** How many times each session was validated against Oxy. */
  validations: Map<string, number>;
  feedConnections: () => number;
  close: () => Promise<void>;
}

async function fakeOxy(): Promise<FakeOxy> {
  const sessions = new Map<string, string>();
  const validations = new Map<string, number>();
  let connections = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://oxy.test');
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/auth/service-token') {
      req.resume();
      reply(200, {
        token: unsignedJwt({ type: 'service', exp: Math.floor(Date.now() / 1000) + 600 }),
        expiresIn: 600,
      });
      return;
    }

    const match = /^\/session\/validate-header\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && match) {
      const sessionId = decodeURIComponent(match[1]);
      validations.set(sessionId, (validations.get(sessionId) ?? 0) + 1);
      const userId = sessions.get(sessionId);
      if (!userId) {
        reply(401, { error: 'INVALID_SESSION' });
        return;
      }
      reply(200, {
        valid: true,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        lastActivity: new Date().toISOString(),
        user: { id: userId },
      });
      return;
    }

    reply(404, { error: 'NOT_FOUND' });
  });

  const io = new SocketIoServer(server);
  io.of(OXY_SERVICE_EVENTS_NAMESPACE).on('connection', (socket) => {
    connections += 1;
    socket.emit(OXY_SERVICE_EVENTS_HEARTBEAT_EVENT, { at: Date.now() });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}`,
    io,
    sessions,
    validations,
    feedConnections: () => connections,
    close: async () => {
      await io.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('Oxy session-revocation feed', () => {
  it('opens on this runtime, caches only while live, and drops a revoked session at once', async () => {
    const oxy = await fakeOxy();
    cleanups.push(oxy.close);
    const client = new OxyServer({
      baseURL: oxy.baseURL,
      sessionValidationCacheTtlMs: 30_000,
      serviceAuth: { apiKey: 'test-key', apiSecret: 'test-secret' },
    });
    cleanups.push(() => client.dispose());

    oxy.sessions.set('sess-1', 'user-1');
    const accessToken = unsignedJwt({
      userId: 'user-1',
      sessionId: 'sess-1',
      exp: Math.floor(Date.now() / 1000) + 3_600,
    });
    const validate = () => client.session.validate('sess-1', { accessToken, fresh: false });
    const asked = () => oxy.validations.get('sess-1') ?? 0;

    // The first validation opens the feed; it is not live yet, so Oxy is asked.
    expect((await validate()).valid).toBe(true);
    expect(asked()).toBe(1);
    await until(() => oxy.feedConnections() === 1, 'the feed to connect');

    // Live (connected, heartbeat seen): one answer is reused instead of asking again.
    await until(async () => {
      const before = asked();
      await validate();
      await validate();
      return asked() - before === 1;
    }, 'a live feed to let a validation be reused');

    // Oxy ends the session and announces it: the very next request is refused.
    oxy.sessions.delete('sess-1');
    const before = asked();
    oxy.io.of(OXY_SERVICE_EVENTS_NAMESPACE).emit(OXY_SESSION_REVOKED_EVENT, {
      sessionId: 'sess-1',
      userId: 'user-1',
      at: Date.now(),
    });
    await until(
      () =>
        validate().then(
          (answer) => answer.valid !== true,
          () => true,
        ),
      'the revocation to apply',
    );
    expect(asked()).toBeGreaterThan(before);
    await expect(validate()).rejects.toThrow();
  });
});
