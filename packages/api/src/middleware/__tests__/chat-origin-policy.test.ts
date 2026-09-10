import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEV_ORIGINS, PRODUCTION_ORIGINS, createInternalCors } from '../../lib/cors-origins.js';

/**
 * The browser-origin policy of the two chat mounts, pinned — issue #244.
 *
 * `@alia.onl/sdk` is a PRODUCT client (it parses `alia.*` events) that still
 * defaults to `POST /v1/chat/completions`, and the reason is a CORS difference
 * between two mounts of the same handler: `/alia/chat` answers preflights only
 * for Alia's own origins, while `/v1` answers `*`. The SDK ships raw source and
 * compiles into consumer apps on origins Alia does not enumerate, so pointing
 * it at `/alia/chat` would block every consumer browser. #244 records that
 * table, measured against production on 2026-08-19:
 *
 * | preflight                                          | allow-origin |
 * | -------------------------------------------------- | ------------ |
 * | `OPTIONS /alia/chat` from `https://customer.example` | absent     |
 * | `OPTIONS /alia/chat` from `https://alia.onl`         | match      |
 * | `OPTIONS /alia/chat` from `https://console.alia.onl` | match      |
 * | `OPTIONS /v1/chat/completions` from any of them      | `*`        |
 *
 * This file is that table as a test, so the policy changes only when somebody
 * changes it on purpose. It is NOT a request to widen the allowlist: #244 says
 * in as many words that widening is not the repair, because the narrow policy
 * is one of the recorded differences that makes `/alia/chat` a product surface
 * rather than a second generic one (`routes/__tests__/v1-compatibility-surface.test.ts`,
 * `SURFACE_DIFFERENCES.cors`). The supported way for an external product to use
 * the SDK today is the consumer-backend path — `useAliaChat({ apiUrl })` at the
 * consumer's own backend, which calls `/alia/chat` server-to-server, where there
 * is no `Origin` header and the last case below is the one that applies.
 *
 * ## What is measured, and what is read
 *
 * The `/alia/chat` half drives the SAME middleware `index.ts` mounts, built by
 * the same function (`createInternalCors`), through a real socket — the way
 * `src/__tests__/corsOrigins.test.ts` does for the matcher. That file pins the
 * matcher's rules (opaque origins, `WEB_URL`); this one pins what a chat
 * consumer sees at the two paths, which is a different question with a
 * different reader.
 *
 * The `/v1` half cannot be driven the same way without re-implementing it: its
 * `cors({ origin: '*' })` call is inline in `index.ts`, and importing `index.ts`
 * starts the server. So the wiring — that `/v1` gets the wildcard and that the
 * internal middleware skips `/v1` — is read out of the source, and the wildcard
 * `cors` configuration is then driven over a socket to show what `*` answers.
 * Both halves must move together for this file to stay green.
 */

const INDEX_SOURCE = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');

/** The origin #244 probed as "a consumer nobody enumerated". */
const FOREIGN_ORIGIN = 'https://customer.example';

const MOUNTS = { chat: '/alia/chat', v1: '/v1/chat/completions' } as const;

let server: Server;
let base: string;

function app(): Express {
  const instance = express();
  // Same order as `index.ts`: the `/v1` wildcard first, then the internal
  // allowlist for everything that is not `/v1`.
  instance.use('/v1', cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], optionsSuccessStatus: 200 }));
  const internalCors = createInternalCors(undefined);
  instance.use((req, res, next) => {
    if (req.path.startsWith('/v1')) return next();
    internalCors(req, res, next);
  });
  instance.use((_req, res) => {
    res.status(200).json({ ok: true });
  });
  return instance;
}

interface Answer {
  readonly status: number;
  readonly allowOrigin: string | null;
  readonly allowCredentials: string | null;
}

async function preflight(mount: string, origin: string | undefined): Promise<Answer> {
  const headers: Record<string, string> = {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type',
  };
  if (origin !== undefined) headers.Origin = origin;
  const response = await fetch(`${base}${mount}`, { method: 'OPTIONS', headers });
  await response.arrayBuffer();
  return {
    status: response.status,
    allowOrigin: response.headers.get('access-control-allow-origin'),
    allowCredentials: response.headers.get('access-control-allow-credentials'),
  };
}

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const listening = app().listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  async () =>
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
);

describe('the browser-origin policy at the two chat mounts (#244)', () => {
  it('is wired in index.ts the way this file reproduces it', () => {
    // The `/v1` wildcard, mounted on `/v1` and nothing wider.
    expect(INDEX_SOURCE).toMatch(/app\.use\('\/v1',\s*cors\(\{\s*origin: '\*'/);
    // The internal allowlist covers every other path, `/alia/chat` included,
    // and is built by the function this test drives.
    expect(INDEX_SOURCE).toContain("if (req.path.startsWith('/v1')) return next();");
    expect(INDEX_SOURCE).toContain('createInternalCors(process.env.WEB_URL)');
    expect(INDEX_SOURCE).toContain("app.use('/alia/chat', chatRouter);");
    expect(INDEX_SOURCE).toContain("app.use('/v1', v1Router);");
    // No separate CORS mount on `/alia/chat`: it takes the shared policy.
    expect(INDEX_SOURCE).not.toMatch(/app\.use\('\/alia\/chat',\s*cors\(/);
  });

  it('answers /alia/chat preflights for the origins Alia owns, with credentials', async () => {
    for (const origin of ['https://alia.onl', 'https://console.alia.onl']) {
      expect(await preflight(MOUNTS.chat, origin)).toEqual({
        status: 204,
        allowOrigin: origin,
        allowCredentials: 'true',
      });
    }
    // The positive control is the whole list, not the two the issue probed.
    expect(PRODUCTION_ORIGINS).toContain('https://alia.onl');
    expect(PRODUCTION_ORIGINS).toContain('https://console.alia.onl');
    for (const origin of PRODUCTION_ORIGINS) {
      expect((await preflight(MOUNTS.chat, origin)).allowOrigin).toBe(origin);
    }
  });

  it('answers /alia/chat preflights for the loopback development origins', async () => {
    expect(DEV_ORIGINS.length).toBeGreaterThan(0);
    for (const origin of DEV_ORIGINS) {
      expect(await preflight(MOUNTS.chat, origin)).toEqual({
        status: 204,
        allowOrigin: origin,
        allowCredentials: 'true',
      });
    }
  });

  it('answers no allow-origin at /alia/chat for an origin Alia does not enumerate', async () => {
    // The first row of the #244 table. A browser on this origin cannot read the
    // response, whatever credential it carries — which is why the SDK does not
    // default to this path, and why a consumer reaches it through a backend.
    expect(await preflight(MOUNTS.chat, FOREIGN_ORIGIN)).toEqual({
      status: 204,
      allowOrigin: null,
      allowCredentials: null,
    });
    // Neighbours of an allowed origin are not admitted either: exact match only.
    expect((await preflight(MOUNTS.chat, 'https://staging.alia.onl')).allowOrigin).toBeNull();
    expect((await preflight(MOUNTS.chat, 'http://alia.onl')).allowOrigin).toBeNull();
  });

  it('answers * at /v1/chat/completions for the same three origins, without credentials', async () => {
    // The last row of the table: the compatibility surface is public CORS.
    for (const origin of ['https://alia.onl', 'https://console.alia.onl', FOREIGN_ORIGIN]) {
      expect(await preflight(MOUNTS.v1, origin)).toEqual({
        status: 200,
        allowOrigin: '*',
        allowCredentials: null,
      });
    }
  });

  it('leaves a request with no Origin header alone at /alia/chat', async () => {
    // The consumer-backend path. A server calling Alia sends no `Origin`, so
    // the allowlist takes no decision at all and the route answers on its
    // credential alone. This is the case #244 §(c) rests on.
    expect(await preflight(MOUNTS.chat, undefined)).toEqual({
      status: 204,
      allowOrigin: null,
      allowCredentials: null,
    });
  });
});
