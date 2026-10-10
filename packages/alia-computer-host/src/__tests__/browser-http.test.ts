/**
 * The control API's browser routes: behind the same workload token, refusing
 * anything outside the input vocabulary before the browser is asked, and
 * absent (404) where the browser is turned off.
 */
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkloadAuthority } from '../attestation.js';
import type { BrowserService } from '../browser-service.js';
import type { ComputerService } from '../computer-service.js';
import { createApp } from '../http.js';

const silent = { warn: () => undefined, error: () => undefined };
let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

async function boot(browser: Partial<BrowserService> | null, authorised = true) {
  const authority = { verifyToken: () => authorised } as unknown as WorkloadAuthority;
  const app = createApp({
    service: { recentReceipts: async () => [] } as unknown as ComputerService,
    browser: browser as BrowserService | null,
    authority,
    log: silent,
    ready: () => true,
  });
  server = app.listen(0);
  await new Promise((resolve) => server!.once('listening', resolve));
  const { port } = server.address() as { port: number };
  return (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        authorization: 'Bearer t',
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
}

const ACTOR = encodeURIComponent('agent:a1:user:u1');

describe('browser routes', () => {
  it('require the workload token', async () => {
    const call = await boot({ status: async () => ({}) as never }, false);
    expect((await call(`/v1/actors/${ACTOR}/browser`)).status).toBe(401);
  });

  it('answer 404 browser_disabled where the browser is off', async () => {
    const call = await boot(null);
    const response = await call(`/v1/actors/${ACTOR}/browser/open`, {
      method: 'POST',
      body: JSON.stringify({ by: 'agent' }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'browser_disabled' } });
  });

  it('refuse input outside the vocabulary before the browser is asked', async () => {
    const seen: unknown[] = [];
    const call = await boot({
      input: async (...args: unknown[]) => {
        seen.push(args);
        return {} as never;
      },
    });
    for (const body of [
      { by: 'agent', input: { type: 'key', key: 'Control+Shift+I' } },
      { by: 'agent', input: { type: 'evaluate', script: 'document.cookie' } },
      { by: 'agent', input: { type: 'click', x: 5000, y: 1 } },
      { by: 'root', input: { type: 'click', x: 1, y: 1 } },
      { by: 'agent', input: { type: 'click', x: 1, y: 1 }, script: 'x' },
    ]) {
      const response = await call(`/v1/actors/${ACTOR}/browser/input`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(seen).toEqual([]);
    const ok = await call(`/v1/actors/${ACTOR}/browser/input`, {
      method: 'POST',
      body: JSON.stringify({ by: 'owner', input: { type: 'type', text: 'hola' } }),
    });
    expect(ok.status).toBe(200);
    expect(seen).toEqual([['agent:a1:user:u1', { type: 'type', text: 'hola' }, 'owner']]);
  });

  it('serve the screenshot as a JPEG, not JSON', async () => {
    const call = await boot({ screenshot: async () => Buffer.from([0xff, 0xd8, 0xff]) });
    const response = await call(`/v1/actors/${ACTOR}/browser/screenshot`);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('list recent command receipts', async () => {
    const call = await boot(null);
    const response = await call(`/v1/actors/${ACTOR}/commands?limit=5`);
    expect(await response.json()).toEqual({ data: [] });
  });
});
