import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: new Proxy({}, { get: () => quiet }) };
});

const H = vi.hoisted(() => ({ kaana: null as unknown }));
vi.mock('../../kaana/transport.js', () => ({ getKaanaClient: () => H.kaana }));
// Credits must never be touched by dictation: any call fails the test.
vi.mock('../../credits-manager.js', () => ({
  reserveCredits: vi.fn(() => {
    throw new Error('dictation reserved credits');
  }),
  finalizeCredits: vi.fn(() => {
    throw new Error('dictation charged credits');
  }),
}));

const { createFakeKaana, voiceCatalogue } = await import('@kaana.ai/sdk/testing');
const { KaanaError } = await import('@kaana.ai/sdk');
const { dictationMediaType, resetTranscriptionCatalogueForTests, transcribeDictation } =
  await import('../transcribe.js');
const credits = await import('../../credits-manager.js');
const { default: audioRouter } = await import('../../../routes/v1/audio.js');
type KaanaClient = import('../../kaana/port.js').KaanaClient;
type Upload = import('@kaana.ai/sdk/testing').FakeTranscriptionUpload;

/**
 * Dictation (ADR 0017 §7): one clip, transcribed by a model computed from
 * Kaana's catalogue, free on every plan, typed when it fails, never partial.
 * Against `@kaana.ai/sdk/testing`: the real client and Kaana's own rules.
 */

beforeEach(() => {
  resetTranscriptionCatalogueForTests();
});

const clip = (overrides: Partial<Parameters<typeof transcribeDictation>[2]> = {}) => ({
  audio: new Uint8Array([1, 2, 3]),
  mediaType: 'audio/webm' as const,
  durationMs: 4_000,
  language: 'es-ES',
  ...overrides,
});

/** Kaana's transcription models, cheapest minute first. */
const transcription = voiceCatalogue
  .filter((model) => model.capabilities.apiFormats?.includes('audio_transcriptions'))
  .sort((a, b) => Number(a.pricePerMinute!.amount) - Number(b.pricePerMinute!.amount));

/** A fake Kaana whose transcriptions answer `text`, recording every upload. */
function fakeKaana(text = 'hola mundo') {
  const uploads: Upload[] = [];
  const fake = createFakeKaana({
    models: voiceCatalogue,
    transcribe: (upload) => {
      uploads.push(upload);
      return { text, durationMs: 4_000 };
    },
  });
  return { ...fake, uploads };
}

/** The client around the fake's, answering every transcription with `error`. */
function refusing(kaana: KaanaClient, error: (model: string) => Error) {
  const tried: string[] = [];
  const client: KaanaClient = {
    ...kaana,
    audio: {
      transcriptions: {
        create: (async (request) => {
          tried.push(request.model);
          throw error(request.model);
        }) as KaanaClient['audio']['transcriptions']['create'],
      },
    },
  };
  return { client, tried };
}

const refusal = (
  code: 'model_not_found' | 'rate_limited' | 'provider_error',
  retryAfterMs?: number,
) =>
  new KaanaError({
    code,
    message: code,
    status: code === 'model_not_found' ? 404 : code === 'rate_limited' ? 429 : 502,
    requestId: 'req_1',
    retryable: code !== 'model_not_found',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

describe('transcribeDictation', () => {
  it("uses the cheapest model that takes the media type, for the person, in the person's locale", async () => {
    const { kaana, server, uploads } = fakeKaana('  hola mundo  ');
    const cheapest = transcription[0]!;
    const result = await transcribeDictation(kaana, 'user-1', clip());
    expect(result).toMatchObject({
      text: 'hola mundo',
      model: `${cheapest.modelId}@${cheapest.currentRevision}`,
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ mediaType: 'audio/webm', language: 'es-ES' });
    expect(uploads[0]!.model.modelId).toBe(cheapest.modelId);
    const upload = server.requests.find((request) => request.method === 'POST');
    expect(upload?.headers.get('X-Oxy-User-Id')).toBe('user-1');
  });

  it('tries at most three models, and only on a model refusal', async () => {
    const { kaana } = fakeKaana();
    const gone = refusing(kaana, () => refusal('model_not_found'));
    await expect(transcribeDictation(gone.client, 'u', clip())).rejects.toMatchObject({
      code: 'TRANSCRIPTION_UNAVAILABLE',
    });
    expect(gone.tried).toEqual(transcription.slice(0, 3).map((model) => model.modelId));

    resetTranscriptionCatalogueForTests();
    const limited = refusing(kaana, () => refusal('rate_limited', 3_000));
    await expect(transcribeDictation(limited.client, 'u', clip())).rejects.toMatchObject({
      code: 'TRANSCRIPTION_LIMITED',
      retryable: true,
      retryAfterMs: 3_000,
    });
    expect(limited.tried).toHaveLength(1);
  });

  it('refuses a clip over five minutes, and is unavailable without Kaana or a model', async () => {
    await expect(
      transcribeDictation(fakeKaana().kaana, 'u', clip({ durationMs: 5 * 60_000 + 3_000 })),
    ).rejects.toMatchObject({
      code: 'CLIP_TOO_LONG',
      httpStatus: 413,
    });
    await expect(transcribeDictation(null, 'u', clip())).rejects.toMatchObject({
      code: 'TRANSCRIPTION_UNAVAILABLE',
      httpStatus: 503,
    });
    resetTranscriptionCatalogueForTests();
    await expect(
      transcribeDictation(createFakeKaana({ models: [] }).kaana, 'u', clip()),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_UNAVAILABLE' });
  });

  it('maps the browser and recorder content types to the contract’s', () => {
    expect(dictationMediaType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(dictationMediaType('audio/x-m4a')).toBe('audio/mp4');
    expect(dictationMediaType('audio/mp4')).toBe('audio/mp4');
    expect(dictationMediaType('text/plain')).toBeNull();
    expect(dictationMediaType('constructor')).toBeNull();
  });
});

describe('POST /v1/audio/transcriptions', () => {
  let server: import('node:http').Server | null = null;
  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
    server = null;
  });

  async function serve(user: { id: string } | null, machine = false) {
    const app = express();
    app.use((req, _res, next) => {
      if (user) req.user = user as never;
      if (machine) (req as unknown as { machineCredential: unknown }).machineCredential = {};
      next();
    });
    app.use('/v1/audio', audioRouter);
    server = app.listen(0);
    await new Promise((resolve) => server!.once('listening', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1/audio/transcriptions`;
  }

  function form(fields: Record<string, string>, type = 'audio/webm;codecs=opus', bytes = 3) {
    const body = new FormData();
    body.set('file', new Blob([new Uint8Array(bytes)], { type }), 'clip.webm');
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    return body;
  }

  it('answers the text for a person on any plan, and charges nothing', async () => {
    const { kaana, server: kaanaServer } = fakeKaana('dictado');
    H.kaana = kaana;
    const url = await serve({ id: 'free-user' });
    const response = await fetch(url, {
      method: 'POST',
      body: form({ language: 'es', durationMs: '3200' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: 'dictado',
      model: `${transcription[0]!.modelId}@${transcription[0]!.currentRevision}`,
    });
    expect(credits.reserveCredits).not.toHaveBeenCalled();
    expect(credits.finalizeCredits).not.toHaveBeenCalled();
    const upload = kaanaServer.requests.find((request) => request.method === 'POST');
    expect(upload?.headers.get('X-Oxy-User-Id')).toBe('free-user');
  });

  it('is typed when it fails', async () => {
    H.kaana = refusing(fakeKaana().kaana, () => refusal('provider_error')).client;
    const url = await serve({ id: 'u' });
    const failed = await fetch(url, { method: 'POST', body: form({ durationMs: '1000' }) });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      error: { code: 'TRANSCRIPTION_FAILED', message: expect.any(String), retryable: true },
    });

    const tooLong = await fetch(url, {
      method: 'POST',
      body: form({ durationMs: String(6 * 60_000) }),
    });
    expect(tooLong.status).toBe(413);
    expect(((await tooLong.json()) as { error: { code: string } }).error.code).toBe(
      'CLIP_TOO_LONG',
    );

    const notAudio = await fetch(url, {
      method: 'POST',
      body: form({ durationMs: '10' }, 'text/plain'),
    });
    expect(notAudio.status).toBe(400);
    expect(((await notAudio.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_REQUEST',
    );

    H.kaana = null;
    const unavailable = await fetch(url, { method: 'POST', body: form({ durationMs: '10' }) });
    expect(unavailable.status).toBe(503);
    expect(((await unavailable.json()) as { error: { code: string } }).error.code).toBe(
      'TRANSCRIPTION_UNAVAILABLE',
    );
  });

  it('takes a person’s session only', async () => {
    H.kaana = fakeKaana().kaana;
    const anonymous = await fetch(await serve(null), {
      method: 'POST',
      body: form({ durationMs: '10' }),
    });
    expect(anonymous.status).toBe(401);
    server!.close();
    const machine = await fetch(await serve({ id: 'u' }, true), {
      method: 'POST',
      body: form({ durationMs: '10' }),
    });
    expect(machine.status).toBe(403);
    expect(((await machine.json()) as { error: { code: string } }).error.code).toBe(
      'CREDENTIAL_NOT_SUPPORTED',
    );
  });
});
