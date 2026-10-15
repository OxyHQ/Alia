import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestSpeechClip, SpeechClipError } from '../../src/lib/speech-synthesis';

/**
 * What `/v1/audio/speech` said about a clip it could not make survives the
 * client: the HTTP status and the typed code, so a voice call can say why.
 */
const fetchMock = vi.fn<typeof fetch>();

const request = (token = 'session-token') => ({
  apiUrl: 'https://alia.test',
  token,
  input: 'Hola',
  voice: 'female' as const,
  signal: new AbortController().signal,
});

async function failureOf(promise: Promise<unknown>): Promise<SpeechClipError> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(SpeechClipError);
  return caught as SpeechClipError;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestSpeechClip', () => {
  it('answers the private link the route returns', async () => {
    fetchMock.mockResolvedValue(Response.json({ audioUrl: 'https://alia.test/media/1' }));
    await expect(requestSpeechClip(request())).resolves.toBe('https://alia.test/media/1');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer session-token',
    });
  });

  it.each([
    [503, 'SPEECH_UNAVAILABLE', false],
    [429, 'SPEECH_LIMIT_REACHED', true],
    [422, 'SPEECH_REJECTED', false],
    [502, 'SPEECH_PROVIDER_FAILED', false],
    [502, 'SPEECH_GENERATION_FAILED', false],
    [400, 'INVALID_REQUEST', false],
  ] as const)('keeps the status and typed code of a %s %s', async (status, code, retryable) => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: {
            code,
            message: 'Speech is not available right now.',
            retryable,
            requestId: 'r1',
          },
        },
        { status },
      ),
    );
    const failure = await failureOf(requestSpeechClip(request()));
    expect(failure).toMatchObject({
      status,
      code,
      retryable,
      requestId: 'r1',
      message: 'Speech is not available right now.',
    });
  });

  it('a code it does not know is no code, and the status still says what happened', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { code: 'SOMETHING_NEW', message: 'New' } }, { status: 500 }),
    );
    expect(await failureOf(requestSpeechClip(request()))).toMatchObject({
      status: 500,
      code: null,
      message: 'New',
    });
  });

  it('a 401 is NOT_AUTHENTICATED, even in the route’s bare envelope', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'Authentication required' }, { status: 401 }),
    );
    expect(await failureOf(requestSpeechClip(request()))).toMatchObject({
      status: 401,
      code: 'NOT_AUTHENTICATED',
      message: 'Authentication required',
    });
  });

  it('no session token is an explicit failure, not a request', async () => {
    expect(await failureOf(requestSpeechClip(request('')))).toMatchObject({
      status: null,
      code: 'NOT_AUTHENTICATED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a gateway timeout says so, and keeps the status', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 504 }));
    expect(await failureOf(requestSpeechClip(request()))).toMatchObject({
      status: 504,
      code: null,
      message: 'Request timed out — please try again',
    });
  });

  it('a success without a link is a failure', async () => {
    fetchMock.mockResolvedValue(Response.json({}));
    expect(await failureOf(requestSpeechClip(request()))).toMatchObject({
      status: 200,
      code: null,
    });
  });
});
