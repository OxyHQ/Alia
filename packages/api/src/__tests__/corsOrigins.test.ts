import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOxyCors } from '@oxyhq/core/server';
import { DEV_ORIGINS, PRODUCTION_ORIGINS, createInternalCors } from '../lib/cors-origins.js';

/**
 * What the internal-routes CORS middleware actually answers, driven over a real
 * socket.
 *
 * A gate over the allowlist alone would pass with a correct list and a broken
 * matcher, so this measures the middleware `index.ts` mounts, built by the
 * function `index.ts` calls, against the same origins that were probed on
 * production. `vitest.config.ts` aliases `@oxyhq/core/server` to a mock; that
 * mock re-exports the REAL `createOxyCors` precisely so this file cannot end up
 * measuring a stub of the rule it is here to check.
 */

/**
 * Three middlewares on one server, so the leak and its absence are read the
 * same way, through the same client.
 *
 * `/unfiltered` is the state this file was written about: an allowlist carrying
 * `exp://localhost:8150`, handed straight to `createOxyCors`. It is the
 * positive control for every "no header" assertion below — without it, a probe
 * that silently sent no `Origin` at all would produce exactly the same clean
 * result as a fixed matcher.
 */
const MOUNTS = {
  shipped: '/shipped',
  webUrl: '/web-url',
  unfiltered: '/unfiltered',
} as const;

const CUSTOM_SCHEME_ORIGINS = [
  'vscode-webview://abc123',
  'capacitor://localhost',
  'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  'exp://localhost:8150',
  'app://alia',
] as const;

let server: Server;
let base: string;

function app(): Express {
  const instance = express();
  instance.use(MOUNTS.shipped, createInternalCors(undefined));
  // Deployment configuration is not a literal in this repo: `WEB_URL` reaches
  // the allowlist from the environment, where no scan of source can see it.
  instance.use(MOUNTS.webUrl, createInternalCors('exp://localhost:8150'));
  instance.use(
    MOUNTS.unfiltered,
    createOxyCors({
      appOrigins: [...PRODUCTION_ORIGINS, 'exp://localhost:8150'],
      methods: ['GET', 'POST', 'OPTIONS'],
    }),
  );
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

async function ask(mount: string, origin: string | undefined, method = 'GET'): Promise<Answer> {
  const headers: Record<string, string> = origin === undefined ? {} : { Origin: origin };
  if (method === 'OPTIONS') headers['Access-Control-Request-Method'] = 'GET';
  const response = await fetch(`${base}${mount}/catalogue`, { method, headers });
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

describe('the internal-routes CORS middleware', () => {
  it('leaks every custom scheme when one opaque origin is on the list', async () => {
    /**
     * The reproduction, in test form. `exp` is not a special scheme, so
     * `new URL('exp://localhost:8150').origin` is the STRING `"null"` and the
     * explicit-origin set holds `"null"`; every other non-special scheme
     * normalises to the same `"null"` and therefore matches, and the middleware
     * echoes back the RAW header it matched. Measured identically against
     * `https://api.alia.onl/catalogue` on 2026-08-19, credentialed.
     */
    for (const origin of CUSTOM_SCHEME_ORIGINS) {
      const answer = await ask(MOUNTS.unfiltered, origin);
      expect(answer.allowOrigin).toBe(origin);
      expect(answer.allowCredentials).toBe('true');
    }

    // And the bound on it, which is why this was a hole and not a wildcard: a
    // normal https origin off the list, and a literal `null`, were refused by
    // the same broken matcher.
    expect((await ask(MOUNTS.unfiltered, 'https://evil.example.com')).allowOrigin).toBeNull();
    expect((await ask(MOUNTS.unfiltered, 'null')).allowOrigin).toBeNull();
  });

  it('answers no custom scheme, on the middleware that ships', async () => {
    for (const origin of [...CUSTOM_SCHEME_ORIGINS, 'file://', 'null', 'https://evil.example.com']) {
      const answer = await ask(MOUNTS.shipped, origin);
      expect({ origin, ...answer }).toEqual({
        origin,
        status: 200,
        allowOrigin: null,
        allowCredentials: null,
      });
    }
  });

  it('answers every first-party origin, with credentials', async () => {
    // The positive control for the assertion above, read over the real lists
    // rather than a sample: an empty or mis-built allowlist fails here.
    expect([...PRODUCTION_ORIGINS, ...DEV_ORIGINS].length).toBeGreaterThanOrEqual(7);
    for (const origin of [...PRODUCTION_ORIGINS, ...DEV_ORIGINS]) {
      expect(await ask(MOUNTS.shipped, origin)).toEqual({
        status: 200,
        allowOrigin: origin,
        allowCredentials: 'true',
      });
    }
  });

  it('carries the same answers through preflight', async () => {
    // A GET is the wrong half to check on its own: a browser asks OPTIONS
    // first, and a preflight that leaked would admit the request before any GET
    // was made.
    expect(await ask(MOUNTS.shipped, 'vscode-webview://abc123', 'OPTIONS')).toEqual({
      status: 204,
      allowOrigin: null,
      allowCredentials: null,
    });
    expect(await ask(MOUNTS.shipped, 'https://alia.onl', 'OPTIONS')).toEqual({
      status: 204,
      allowOrigin: 'https://alia.onl',
      allowCredentials: 'true',
    });
  });

  it('drops an opaque WEB_URL instead of admitting every scheme through it', async () => {
    expect((await ask(MOUNTS.webUrl, 'exp://localhost:8150')).allowOrigin).toBeNull();
    expect((await ask(MOUNTS.webUrl, 'vscode-webview://abc123')).allowOrigin).toBeNull();
    // Dropped, not fatal: the rest of the allowlist still answers.
    expect((await ask(MOUNTS.webUrl, 'https://alia.onl')).allowOrigin).toBe('https://alia.onl');
  });

  it('leaves a request with no Origin header alone', async () => {
    // Why deleting the `exp://` entry breaks no native client: CORS is a
    // browser rule, and `packages/app` on a device sends no Origin at all, so
    // it never took a decision from this middleware in the first place.
    expect(await ask(MOUNTS.shipped, undefined)).toEqual({
      status: 200,
      allowOrigin: null,
      allowCredentials: null,
    });
  });
});
