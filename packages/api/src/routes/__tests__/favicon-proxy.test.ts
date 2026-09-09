import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The HTTP surface of the favicon proxy: what a browser gets, and what it is
 * told to do with it.
 *
 * These are properties `lib/favicon.ts` cannot hold on its own. A missing icon
 * has to be a clean status an `<img>` reports as an error — the app draws its
 * own mark then — and it has to be CACHEABLE, or every message that cites a
 * site without a favicon re-asks on every render. Bytes from a site Alia does
 * not control have to arrive as an inert image.
 *
 * The client below uses the `fetch` captured before the outbound one is
 * stubbed: the same global serves both sides of this test, and stubbing it for
 * the server's outbound calls would otherwise replace the test's own client.
 */

const clientFetch = globalThis.fetch;

const H = vi.hoisted(() => ({
  addresses: new Map<string, Array<{ address: string; family: number }>>(),
  handler: (_url: URL): Promise<Response> => Promise.resolve(new Response(null, { status: 404 })),
}));

vi.mock('node:dns/promises', () => ({
  lookup: async (hostname: string) => {
    const found = H.addresses.get(hostname);
    if (found === undefined) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    return found;
  },
}));

const { default: faviconsRouter } = await import('../favicons.js');

const ICON = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);

let server: Server | null = null;

async function get(domain: string) {
  const app = express();
  app.use('/favicons', faviconsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const response = await clientFetch(`http://127.0.0.1:${port}/favicons/${encodeURIComponent(domain)}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    nosniff: response.headers.get('x-content-type-options'),
    csp: response.headers.get('content-security-policy'),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

beforeEach(() => {
  H.addresses.clear();
  H.handler = () => Promise.resolve(new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', (input: string | URL) => H.handler(new URL(String(input))));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (server !== null) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

describe('GET /favicons/:domain', () => {
  it('serves the icon as an inert image the browser may keep', async () => {
    H.addresses.set('route-icon.example.com', [{ address: '93.184.216.34', family: 4 }]);
    H.handler = () =>
      Promise.resolve(new Response(new Uint8Array(ICON), { status: 200, headers: { 'content-type': 'image/x-icon' } }));

    const response = await get('route-icon.example.com');

    expect(response.status).toBe(200);
    expect(response.contentType).toBe('image/x-icon');
    expect(response.body.equals(ICON)).toBe(true);
    expect(response.cacheControl).toBe('public, max-age=604800');
    expect(response.nosniff).toBe('nosniff');
    expect(response.csp).toBe("default-src 'none'; sandbox");
  });

  it('answers 404 for a site with no icon, and lets the client remember that', async () => {
    H.addresses.set('route-bare.example.com', [{ address: '93.184.216.34', family: 4 }]);

    const response = await get('route-bare.example.com');

    expect(response.status).toBe(404);
    expect(response.cacheControl).toBe('public, max-age=21600');
  });

  it('answers 400 for a domain it will not fetch', async () => {
    const response = await get('127.0.0.1');

    expect(response.status).toBe(400);
    // Not 404: the string is the problem, and it will still be the problem in
    // six hours, so the distinction is worth keeping in the log and the cache.
    expect(response.cacheControl).toBe('public, max-age=3600');
  });

  it('never answers with a body a browser would render as something other than an image', async () => {
    // A 404 body is JSON for a human reading the log, but `nosniff` and the
    // status are what stop an <img> from doing anything with it.
    H.addresses.set('route-html.example.com', [{ address: '93.184.216.34', family: 4 }]);
    H.handler = () =>
      Promise.resolve(new Response('<script>alert(1)</script>', { status: 200, headers: { 'content-type': 'text/html' } }));

    const response = await get('route-html.example.com');

    expect(response.status).toBe(404);
    expect(response.body.toString()).not.toContain('<script>');
  });
});
