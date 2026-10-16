import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Router } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `/v1/conversations` — the SDK's door to a person's history — admits a person's bearer and
 * nothing else.
 *
 * The real `/v1` router is mounted over a stand-in for the Oxy verifier: `authenticateToken`
 * accepts exactly `Bearer person-token` and sets `req.user`; `authenticateTokenOrApiKey` (the
 * blanket lane every other `/v1` route sits behind, which also admits bot secrets and
 * application keys) is recorded, so the test can show the conversations never reach it. The
 * conversations router itself is replaced by one route that echoes the user it was given: what
 * is under test is the door, not the storage behind it.
 */

const lane = vi.hoisted(() => ({ blanketCalls: 0 }));

vi.mock('../../middleware/auth.js', () => {
  const next = (_req: unknown, _res: unknown, done: () => void) => done();
  return {
    oxyClient: { users: { get: vi.fn(async () => null) }, middleware: { socket: vi.fn() } },
    optionalAuth: vi.fn(next),
    authenticateToken: vi.fn(
      (
        req: { headers: Record<string, string | undefined>; user?: { id: string } },
        res: { status: (code: number) => { json: (body: unknown) => void } },
        done: () => void,
      ) => {
        if (req.headers.authorization === 'Bearer person-token') {
          req.user = { id: 'person-1' };
          done();
          return;
        }
        res.status(401).json({ error: 'Authentication required' });
      },
    ),
    authenticateTokenOrApiKey: vi.fn(
      (
        req: { headers: Record<string, string | undefined>; user?: { id: string } },
        _res: unknown,
        done: () => void,
      ) => {
        lane.blanketCalls += 1;
        // The blanket lane would admit a channel bot by its secret.
        if (req.headers['x-channel-bot-secret'] !== undefined) req.user = { id: 'bot-user' };
        done();
      },
    ),
  };
});
vi.mock('../conversations.js', () => {
  const router = Router();
  router.get('/', (req, res) => {
    res.json({ user: (req as unknown as { user?: { id: string } }).user?.id ?? null });
  });
  return { default: router };
});
vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

import v1Router from '../v1.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use('/v1', v1Router);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  async () =>
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
);

describe('GET /v1/conversations', () => {
  it('answers a person’s bearer with that person', async () => {
    const response = await fetch(`${base}/v1/conversations`, {
      headers: { Authorization: 'Bearer person-token' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: 'person-1' });
  });

  it('refuses a request with no credential', async () => {
    expect((await fetch(`${base}/v1/conversations`)).status).toBe(401);
  });

  it('refuses a bearer that is not a person’s session (an application key, a stray token)', async () => {
    for (const authorization of ['Bearer oxy_sk_application', 'Bearer other-token']) {
      const response = await fetch(`${base}/v1/conversations`, {
        headers: { Authorization: authorization },
      });
      expect(response.status).toBe(401);
    }
  });

  it('refuses a channel bot’s secret, which the blanket lane would have admitted', async () => {
    const response = await fetch(`${base}/v1/conversations`, {
      headers: { 'x-channel-bot-secret': 's3cret', 'x-oxy-user-id': 'a'.repeat(24) },
    });
    expect(response.status).toBe(401);
  });

  it('never reaches the blanket lane that admits bots and keys', async () => {
    expect(lane.blanketCalls).toBe(0);
  });
});
