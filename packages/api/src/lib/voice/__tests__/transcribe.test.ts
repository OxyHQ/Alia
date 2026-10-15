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

const { FakeKaana, FakeKaanaError, fakeTranscriptionModel } = await import('../../kaana/fake.js');
const { dictationMediaType, resetTranscriptionCatalogueForTests, transcribeDictation } =
  await import('../transcribe.js');
const credits = await import('../../credits-manager.js');
const { default: audioRouter } = await import('../../../routes/v1/audio.js');

/**
 * Dictation (ADR 0017 §7): one clip, transcribed by a model computed from the
 * catalogue, free on every plan, typed when it fails, never partial.
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

describe('transcribeDictation', () => {
  it('uses the cheapest model that takes the media type and the language, for the person', async () => {
    const dear = fakeTranscriptionModel({ modelId: 't/dear' });
    const cheap = fakeTranscriptionModel({
      modelId: 't/cheap',
      pricing: {
        priceVersionId: 'p',
        currency: 'USD',
        unitPrices: [
          { unit: 'audio_input_milliseconds', amount: '0.001', per: 60_000, currency: 'USD' },
        ],
      },
    });
    const kaana = new FakeKaana({ models: [dear, cheap] });
    kaana.transcriptText = '  hola mundo  ';
    const result = await transcribeDictation(kaana, 'user-1', clip());
    expect(result).toMatchObject({ text: 'hola mundo', model: 't/cheap@2026-09-01' });
    expect(kaana.transcriptionRequests[0]).toMatchObject({
      request: { model: 't/cheap', mediaType: 'audio/webm', language: 'es' },
      options: { onBehalfOfUserId: 'user-1' },
    });
  });

  it('tries at most three models, and only on a model refusal', async () => {
    const models = ['a', 'b', 'c', 'd'].map((id) => fakeTranscriptionModel({ modelId: `t/${id}` }));
    const kaana = new FakeKaana({ models });
    for (const id of ['a', 'b', 'c'])
      kaana.failTranscription.push({
        model: `t/${id}`,
        error: new FakeKaanaError('model_not_found'),
      });
    await expect(transcribeDictation(kaana, 'u', clip())).rejects.toMatchObject({
      code: 'TRANSCRIPTION_UNAVAILABLE',
    });
    expect(kaana.transcriptionRequests).toHaveLength(3);

    resetTranscriptionCatalogueForTests();
    const limited = new FakeKaana({ models });
    limited.failTranscription.push({
      model: '*',
      error: new FakeKaanaError('rate_limited', { retryAfterMs: 3_000 }),
    });
    await expect(transcribeDictation(limited, 'u', clip())).rejects.toMatchObject({
      code: 'TRANSCRIPTION_LIMITED',
      retryable: true,
      retryAfterMs: 3_000,
    });
    expect(limited.transcriptionRequests).toHaveLength(1);
  });

  it('refuses a clip over five minutes, and is unavailable without Kaana or a model', async () => {
    await expect(
      transcribeDictation(new FakeKaana(), 'u', clip({ durationMs: 5 * 60_000 + 3_000 })),
    ).rejects.toMatchObject({
      code: 'CLIP_TOO_LONG',
      httpStatus: 413,
    });
    await expect(transcribeDictation(null, 'u', clip())).rejects.toMatchObject({
      code: 'TRANSCRIPTION_UNAVAILABLE',
      httpStatus: 503,
    });
    await expect(
      transcribeDictation(new FakeKaana({ models: [] }), 'u', clip()),
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
    const kaana = new FakeKaana();
    kaana.transcriptText = 'dictado';
    H.kaana = kaana;
    const url = await serve({ id: 'free-user' });
    const response = await fetch(url, {
      method: 'POST',
      body: form({ language: 'es', durationMs: '3200' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: 'dictado',
      model: 'fake/transcribe@2026-09-01',
    });
    expect(credits.reserveCredits).not.toHaveBeenCalled();
    expect(credits.finalizeCredits).not.toHaveBeenCalled();
    expect(kaana.transcriptionRequests[0]?.options?.onBehalfOfUserId).toBe('free-user');
  });

  it('is typed when it fails', async () => {
    const kaana = new FakeKaana();
    kaana.failTranscription.push({ model: '*', error: new FakeKaanaError('provider_error') });
    H.kaana = kaana;
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
    H.kaana = new FakeKaana();
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
