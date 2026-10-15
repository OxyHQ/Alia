import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DictationError,
  dictationFailureCode,
  normalizeAudioMediaType,
  requestTranscription,
} from '../../src/lib/dictation';

const clip = {
  file: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
  mediaType: 'audio/webm;codecs=opus',
  durationMs: 1234.4,
};

function answer(status: number, body: unknown) {
  return vi.fn(
    async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestTranscription', () => {
  it('posts the clip, its language and measured duration, with the session bearer', async () => {
    const fetchMock = answer(200, { text: 'hola', language: 'es', model: 'openai/whisper' });
    vi.stubGlobal('fetch', fetchMock);
    const result = await requestTranscription({
      apiUrl: 'https://api.alia.test',
      token: 'tok',
      clip,
      language: 'es-ES',
    });
    expect(result).toEqual({ text: 'hola', language: 'es', model: 'openai/whisper' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.alia.test/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const form = init.body as FormData;
    expect(form.get('language')).toBe('es-ES');
    expect(form.get('durationMs')).toBe('1234');
    expect((form.get('file') as File).name).toBe('dictation.webm');
  });

  it.each([
    [503, 'TRANSCRIPTION_UNAVAILABLE', 'transcription-unavailable'],
    [429, 'TRANSCRIPTION_LIMITED', 'transcription-limited'],
    [422, 'TRANSCRIPTION_REJECTED', 'transcription-rejected'],
    [502, 'TRANSCRIPTION_FAILED', 'transcription-failed'],
    [413, 'CLIP_TOO_LONG', 'too-long'],
    [400, 'INVALID_REQUEST', 'transcription-rejected'],
    [401, 'NOT_AUTHENTICATED', 'not-authenticated'],
    [403, 'CREDENTIAL_NOT_SUPPORTED', 'credential-not-supported'],
  ])('a %s %s is the typed %s', async (status, code, voiceCode) => {
    vi.stubGlobal('fetch', answer(status, { error: { code, message: 'x', retryable: false } }));
    const failure = await requestTranscription({
      apiUrl: 'https://a',
      token: 't',
      clip,
      language: 'en',
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DictationError);
    expect((failure as DictationError).code).toBe(code);
    expect(dictationFailureCode(failure)).toBe(voiceCode);
  });

  it('is a failed transcription when Alia could not be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('network'))),
    );
    const failure = await requestTranscription({
      apiUrl: 'https://a',
      token: 't',
      clip,
      language: 'en',
    }).catch((error: unknown) => error);
    expect(dictationFailureCode(failure)).toBe('transcription-failed');
  });

  it('refuses to send without a token', async () => {
    const failure = await requestTranscription({
      apiUrl: 'https://a',
      token: '',
      clip,
      language: 'en',
    }).catch((error: unknown) => error);
    expect(dictationFailureCode(failure)).toBe('not-authenticated');
  });

  it('names recorded media types the way the route accepts them', () => {
    expect(normalizeAudioMediaType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(normalizeAudioMediaType('audio/x-m4a')).toBe('audio/mp4');
    expect(normalizeAudioMediaType('audio/mp4')).toBe('audio/mp4');
  });
});
