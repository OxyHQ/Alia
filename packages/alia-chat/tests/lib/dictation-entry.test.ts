import { describe, expect, it, vi } from 'vitest';
import * as entry from '../../src/dictation';
import * as lib from '../../src/lib/dictation';

describe('@alia.onl/sdk/dictation', () => {
  it('exports the request the composer uses, not a copy', () => {
    expect(entry.requestTranscription).toBe(lib.requestTranscription);
    expect(entry.DictationError).toBe(lib.DictationError);
    expect(entry.dictationFailureCode).toBe(lib.dictationFailureCode);
    expect(entry.normalizeAudioMediaType).toBe(lib.normalizeAudioMediaType);
    expect(entry.MAX_DICTATION_MS).toBe(5 * 60_000);
  });

  it('sends through a caller transport without a bearer header of its own', async () => {
    const send = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ text: 'hello there' }), { status: 200 }),
    );
    const result = await entry.requestTranscription({
      apiUrl: 'https://api.alia.test',
      transport: { fetch: send as typeof fetch },
      clip: {
        file: new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }),
        mediaType: 'audio/wav',
        durationMs: 900,
      },
      language: 'en-US',
    });
    expect(result.text).toBe('hello there');
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://api.alia.test/v1/audio/transcriptions');
    expect(init?.headers).toBeUndefined();
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    const form = init?.body as FormData;
    expect((form.get('file') as File).name).toBe('dictation.wav');
    expect(form.get('durationMs')).toBe('900');
    expect(form.get('language')).toBe('en-US');
  });
});
