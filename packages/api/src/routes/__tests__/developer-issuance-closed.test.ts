/**
 * Every path that used to bring an Alia developer application or an `alia_sk_*`
 * credential into existence, driven as real HTTP against the real routers.
 *
 * There were FIVE, not the one `docs/developers-portal.md` described. Alongside
 * `POST /developer/apps` and `POST /developer/apps/:appId/keys`, the `/auth`
 * router carried a complete PKCE exchange — `/authorize/codea`,
 * `/authorize/cowork` and `/token` — that registered an application per user and
 * then minted, or silently replaced the secret of, a key. Closing four of five
 * would have left the checkbox unearned and the freeze untrue.
 *
 * The routers are mounted for real. A test that asserted against a handler it
 * imported directly would keep passing after someone re-registered the path
 * above it, which is exactly how a closed route quietly reopens.
 *
 * No database is connected. That is deliberate and it is the negative control:
 * a refusal answers without touching Postgres, so any handler that still tried
 * to write would fail loudly here instead of passing quietly.
 */

import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import authRouter from '../auth.js';
import developerRouter from '../developer.js';
import { log } from '../../lib/logger.js';
import { toStructuredFieldDate } from '../../middleware/http-deprecation.js';
import { CREDENTIAL_DEPRECATION } from '../../middleware/credential-deprecation.js';

let base: string;
let server: Server;

beforeAll(async () => {
  /**
   * The surviving routes below reach their real handlers with no database, so
   * each one logs the error it catches. That is the control working, not a
   * failure — but it is a hundred lines of stack trace on every CI run, so the
   * one logger they use is stubbed. Vitest isolates module registries per file,
   * so this touches nothing outside this suite.
   */
  vi.spyOn(log.developer, 'error').mockImplementation(() => undefined);

  const app: Express = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/developer', developerRouter);
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

interface Answer {
  status: number;
  deprecation: string | null;
  link: string | null;
  sunset: string | null;
  body: Record<string, unknown>;
}

async function post(path: string, body: unknown = {}): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    deprecation: res.headers.get('deprecation'),
    link: res.headers.get('link'),
    sunset: res.headers.get('sunset'),
    body: (await res.json()) as Record<string, unknown>,
  };
}

/** The five, with the subject each one refuses under. */
const CLOSED: ReadonlyArray<readonly [string, string]> = [
  ['/developer/apps', 'developer_application'],
  ['/developer/apps/any-app-id/keys', 'developer_api_key'],
  ['/auth/authorize/codea', 'developer_application'],
  ['/auth/authorize/cowork', 'developer_application'],
  ['/auth/token', 'developer_api_key'],
];

describe('every creation path refuses', () => {
  it.each(CLOSED)('%s answers 410 with the migration instruction', async (path, subject) => {
    const answer = await post(path);
    expect(answer.status).toBe(410);
    expect(answer.body.error).toBe('issuance_closed');
    expect(answer.body.subject).toBe(subject);
    expect(answer.body.message).toMatch(/Oxy Console/);
    expect(answer.deprecation).toBe(toStructuredFieldDate(CREDENTIAL_DEPRECATION));
    expect(answer.link).toMatch(/rel="deprecation"/);
    // No removal date is set for the CREDENTIALS, so none is announced. The
    // aliases got one on 2026-08-18 and this path deliberately did not — see
    // `middleware/credential-deprecation.ts`. Do not "fix" this to match them.
    expect(answer.sunset).toBeNull();
  });

  it('refuses regardless of what the caller sends', async () => {
    /**
     * The bodies these routes used to accept, replayed. A handler that still
     * validated its input would answer 400 for the empty case and 201 for the
     * valid one, and both are visible here.
     */
    expect((await post('/developer/apps', { name: 'A new app' })).status).toBe(410);
    expect((await post('/developer/apps', {})).status).toBe(410);
    expect((await post('/developer/apps/x/keys', { name: 'k', scopes: ['chat:write'] })).status).toBe(410);
    expect((await post('/auth/authorize/codea', { code_challenge: 'x'.repeat(43) })).status).toBe(410);
    expect(
      (await post('/auth/token', {
        grant_type: 'authorization_code',
        code: 'anything',
        code_verifier: 'anything',
        client_id: 'cowork',
      })).status,
    ).toBe(410);
  });

  it('never returns anything that could be used as a credential', async () => {
    // The response that matters most: a refusal must not hand back a token, a
    // key, or the stored digest dressed up as a replacement secret.
    for (const [path] of CLOSED) {
      const answer = await post(path);
      const serialized = JSON.stringify(answer.body);
      expect(serialized).not.toContain('alia_sk_');
      for (const field of ['key', 'token', 'apiKey', 'keyHash', 'keyPrefix', 'code']) {
        expect(answer.body[field]).toBeUndefined();
      }
    }
  });
});

describe('the negative control: the surviving routes did not become refusals too', () => {
  /**
   * Section (c) of the compatibility window keeps listing, inspection and
   * revocation working for the whole window, "because taking away revocation
   * during a migration would be a security regression". A change that closed the
   * whole router would satisfy every assertion above, so the difference is
   * asserted directly.
   *
   * These reach their real handlers with no database and no authenticated user,
   * so they answer 500 — the point is only that they RAN, rather than being
   * short-circuited into a 410 with an `issuance_closed` body.
   */
  async function send(method: 'GET' | 'DELETE' | 'PATCH', path: string): Promise<Answer> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'PATCH' ? '{}' : undefined,
    });
    return {
      status: res.status,
      deprecation: res.headers.get('deprecation'),
      link: res.headers.get('link'),
      sunset: res.headers.get('sunset'),
      body: (await res.json()) as Record<string, unknown>,
    };
  }

  it.each([
    ['GET', '/developer/apps'],
    ['GET', '/developer/apps/an-id'],
    ['PATCH', '/developer/apps/an-id'],
    ['DELETE', '/developer/apps/an-id'],
    ['GET', '/developer/apps/an-id/keys'],
    ['PATCH', '/developer/apps/an-id/keys/a-key'],
    ['DELETE', '/developer/apps/an-id/keys/a-key'],
    ['GET', '/developer/usage'],
    ['GET', '/developer/stats'],
  ] as const)('%s %s still runs its handler', async (method, path) => {
    const answer = await send(method, path);
    expect(answer.status).not.toBe(410);
    expect(answer.body.error).not.toBe('issuance_closed');
  });
});
