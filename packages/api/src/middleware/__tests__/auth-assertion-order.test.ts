import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `authenticateTokenOrApiKey` runs BEFORE `authenticateRequesterAssertion` on
 * `/v1/chat/completions`, and a present-requester request (ADR 0025 in
 * OxyHQServices) carries no user bearer by design: the product presents its own
 * SERVICE token plus the assertion, and the identity comes out of the verified
 * assertion.
 *
 * ## The regression this pins
 *
 * The entry middleware required a user, so it answered 401 "Authentication
 * required" before the assertion middleware ever read the header. Everything
 * else in the lane was deployed and correct — Oxy minted assertions, Alia never
 * logged a rejection and Oxy never saw one consumed — and Homiio's Sindi chat
 * answered 401 `chat_auth_required` on every message. The suites missed it
 * because `src/__tests__/mocks/oxy-core-server.ts` stubs `createOxyAuthMiddleware`
 * as a pass-through, so the requirement it enforces in production is absent in
 * tests. This asserts the ROUTING decision instead, which is the part that was
 * wrong: with the header, the request must reach the next middleware; without
 * it and without a bearer, 401 stays.
 */

vi.mock('../../lib/logger.js', () => {
  const channel = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() });
  return { log: new Proxy({}, { get: channel }) };
});
vi.mock('../../lib/channels/registry.js', () => ({ getConfiguredChannels: () => [] }));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../lib/oxy-service-client.js', () => ({ oxyServiceClient: () => null }));

const { authenticateTokenOrApiKey } = await import('../auth.js');
const { OXY_REQUESTER_ASSERTION_HEADER } = await import('@oxy.so/core/server');

const app = express();
app.post('/v1/chat/completions', authenticateTokenOrApiKey, (_req: Request, res: Response) => {
  res.status(200).json({ reached: true });
});

let server: http.Server;
let origin: string;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

// `Response` here is express's; the fetch result is the DOM one.
function post(headers: Record<string, string>): Promise<globalThis.Response> {
  return fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: '{}',
  });
}

describe('authenticateTokenOrApiKey with a present-requester assertion', () => {
  it('lets a service-token request carrying the assertion header through to the next middleware', async () => {
    const response = await post({
      Authorization: 'Bearer service.token.value',
      [OXY_REQUESTER_ASSERTION_HEADER]: 'assertion.value.here',
    });

    expect(response.status).toBe(200);
  });

  it('still refuses a request with neither a bearer nor an assertion', async () => {
    const response = await post({});

    expect(response.status).toBe(401);
  });

  it('does not require a bearer to be present for the assertion lane to be taken', async () => {
    // The assertion middleware refuses this one (`service_token_required`);
    // what matters here is that the entry middleware no longer decides it.
    const response = await post({ [OXY_REQUESTER_ASSERTION_HEADER]: 'assertion.value.here' });

    expect(response.status).toBe(200);
  });
});
