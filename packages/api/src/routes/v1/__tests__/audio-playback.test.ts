import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one route in `/v1` that answers without a credential.
 *
 * Every case is about that: it must serve exactly what the signature says and
 * nothing else, and it must be reachable at all — a media element presents no
 * `Authorization` header, so a route behind the authenticated block is a route
 * nothing can play.
 */

const H = vi.hoisted(() => ({ requestedKey: null as string | null, exists: true }));

vi.mock('../../../lib/s3.js', () => ({
  readS3Object: async (key: string) => {
    H.requestedKey = key;
    return H.exists
      ? { body: Readable.from([Buffer.from('ID3fake-audio')]), contentType: 'audio/mpeg', contentLength: 13 }
      : null;
  },
}));

const { mintPlaybackQuery } = await import('../../../lib/audio-playback-link.js');
const { default: playbackRouter } = await import('../audio-playback.js');

const KEY = 'production/tts/user-1/speech-abc.mp3';
let server: Server | null = null;

async function get(query: string): Promise<{ status: number; body: string; contentType: string | null }> {
  const app = express();
  app.use('/audio/playback', playbackRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/audio/playback?${query}`);
  return { status: response.status, body: await response.text(), contentType: response.headers.get('content-type') };
}

beforeEach(() => {
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a-secret-that-only-the-server-has');
  H.requestedKey = null;
  H.exists = true;
});

afterEach(async () => {
  if (server !== null) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  vi.unstubAllEnvs();
});

describe('playing a signed clip', () => {
  it('serves the object the signature names, as audio', async () => {
    const response = await get(mintPlaybackQuery(KEY, 'user-1') as string);
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('audio/mpeg');
    expect(response.body).toContain('ID3');
    expect(H.requestedKey).toBe(KEY);
  });

  it('reads no key from the caller', async () => {
    // The signed payload is the only source of the key. A `key=` on the query
    // string must change nothing — otherwise the URL is a file picker.
    const response = await get(`${mintPlaybackQuery(KEY, 'user-1')}&key=production/tts/user-2/private.mp3`);
    expect(response.status).toBe(200);
    expect(H.requestedKey).toBe(KEY);
  });

  it('refuses a forged link without reading anything from S3', async () => {
    const response = await get('o=cHJvZHVjdGlvbi90dHMvdXNlci0yL3ByaXZhdGUubXAz&u=user-2&e=99999999999999&s=forged');
    expect(response.status).toBe(403);
    expect(H.requestedKey).toBeNull();
  });

  it('answers 410 for an expired link, not 403', async () => {
    // A client that sees 403 tells the user they lack permission; 410 tells it
    // to ask for a fresh link, which is what actually happened.
    const stale = mintPlaybackQuery(KEY, 'user-1', Date.now() - 60 * 60 * 1000) as string;
    expect((await get(stale)).status).toBe(410);
  });

  it('answers 404 when the clip is gone, which is not the same as forbidden', async () => {
    H.exists = false;
    expect((await get(mintPlaybackQuery(KEY, 'user-1') as string)).status).toBe(404);
  });
});
