import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  snapshot: vi.fn(),
  synthesizeSpeech: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  find: vi.fn(),
  save: vi.fn(),
  link: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock('../../../lib/product-credit-access.js', () => ({
  readConfiguredProductCreditSnapshot: H.snapshot,
}));
vi.mock('../../../lib/synthesize-speech.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/synthesize-speech.js')>()),
  synthesizeSpeech: H.synthesizeSpeech,
}));
vi.mock('../../../lib/s3.js', () => ({ uploadToS3: H.upload, deleteS3Objects: H.remove }));
vi.mock('../../../lib/stored-media.js', () => ({ storedMediaUrl: H.link }));
vi.mock('../../../db/chat/messageRepository.js', () => ({
  findMessageAudioUrl: H.find,
  setMessageAudioUrl: H.save,
}));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../../db/notifications/audioJobRepository.js', () => ({ findAudioJobStatus: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({
  log: { speech: { error: H.logError, warn: H.logWarn }, general: { error: vi.fn() } },
}));
const { default: audioRouter } = await import('../audio.js');
const { SpeechSynthesisError } = await import('../../../lib/synthesize-speech.js');
interface RouteLayer {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown, next: unknown) => unknown }>;
  };
}
function handler() {
  const layer = (audioRouter as unknown as { stack: RouteLayer[] }).stack.find(
    (entry) => entry.route?.path === '/speech' && entry.route.methods?.post,
  );
  if (!layer?.route) throw new Error('Speech route missing');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function response() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    body: undefined as unknown,
    writableEnded: false,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      this.writableEnded = true;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  });
}
const body = { input: 'Hola', voice: 'female', speed: 1.15, conversationId: 'c1', messageId: 'm1' };
beforeEach(() => {
  vi.clearAllMocks();
  H.find.mockResolvedValue(null);
  H.save.mockResolvedValue(1);
  H.synthesizeSpeech.mockResolvedValue({
    audio: Buffer.from('ID3'),
    format: 'mp3',
    requestId: 'req_tts',
  });
  H.upload.mockResolvedValue('test/audio/u1/speech.mp3');
  H.remove.mockResolvedValue(1);
  H.link.mockReturnValue('https://api.alia.test/media?signed');
});
describe('speech synthesis boundary', () => {
  it('requires authentication before synthesis or storage', async () => {
    const res = response();
    await handler()({ body }, res, undefined);
    expect(res.statusCode).toBe(401);
    expect(H.synthesizeSpeech).not.toHaveBeenCalled();
    expect(H.upload).not.toHaveBeenCalled();
  });
  it('returns playable stored audio and only updates the authenticated user’s message', async () => {
    const res = response();
    await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      audioUrl: 'https://api.alia.test/media?signed',
      requestId: 'req_tts',
    });
    expect(H.synthesizeSpeech).toHaveBeenCalledWith({
      input: 'Hola',
      voice: 'female',
      format: 'mp3',
      userId: 'u1',
      speed: 1.15,
      signal: expect.any(AbortSignal),
    });
    expect(H.save).toHaveBeenCalledWith({}, 'u1', 'c1', 'm1', 'test/audio/u1/speech.mp3');
    expect(H.remove).not.toHaveBeenCalled();
    expect(res.listenerCount('close')).toBe(0);
  });
  it.each([
    { input: '' },
    { input: ' '.repeat(4) },
    { input: 'a'.repeat(15001) },
    { voice: 'unknown' },
    { speed: 4 },
    { model: 42 },
    { extra: true },
  ])('rejects unsupported input before egress: %p', async (patch) => {
    const res = response();
    await handler()({ user: { id: 'u1' }, body: { ...body, ...patch } }, res, undefined);
    expect(res.statusCode).toBe(400);
    expect(H.synthesizeSpeech).not.toHaveBeenCalled();
  });
  it("ignores a model an older client still names: the speech model is the catalogue's", async () => {
    const res = response();
    await handler()({ user: { id: 'u1' }, body: { ...body, model: 'acme/any' } }, res, undefined);
    expect(res.statusCode).toBe(200);
    expect(H.synthesizeSpeech).toHaveBeenCalledWith(
      expect.not.objectContaining({ model: expect.anything() }),
    );
  });
  it('does not generate audio for another user’s message', async () => {
    H.find.mockResolvedValue(undefined);
    const res = response();
    await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(res.statusCode).toBe(404);
    expect(H.synthesizeSpeech).not.toHaveBeenCalled();
  });
  it('answers a limit with its typed code and wait, logs it, and never retries a paid request', async () => {
    H.synthesizeSpeech.mockRejectedValue(
      new SpeechSynthesisError('SPEECH_LIMIT_REACHED', {
        reason: 'refused',
        retryable: true,
        retryAfterMs: 1500,
        upstreamCode: 'rate_limited',
        upstreamStatus: 429,
        requestId: 'req_limit',
        models: ['acme/voice'],
      }),
    );
    const res = response();
    await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('2');
    expect(res.body).toEqual({
      error: {
        code: 'SPEECH_LIMIT_REACHED',
        message: expect.any(String),
        retryable: true,
        requestId: 'req_limit',
        retryAfterMs: 1500,
      },
    });
    expect(H.synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(H.upload).not.toHaveBeenCalled();
    expect(H.logWarn).toHaveBeenCalledWith(
      {
        code: 'SPEECH_LIMIT_REACHED',
        reason: 'refused',
        status: 429,
        retryable: true,
        upstreamCode: 'rate_limited',
        upstreamStatus: 429,
        requestId: 'req_limit',
        param: undefined,
        models: ['acme/voice'],
        voice: 'female',
        inputChars: 4,
      },
      'Speech synthesis failed',
    );
  });
  it.each([
    ['SPEECH_UNAVAILABLE', 'no_speech_model', 503, 'error'],
    ['SPEECH_REJECTED', 'refused', 422, 'warn'],
    ['SPEECH_PROVIDER_FAILED', 'transport', 502, 'error'],
  ] as const)('answers %s with its own status and logs it', async (code, reason, status, level) => {
    H.synthesizeSpeech.mockRejectedValue(new SpeechSynthesisError(code, { reason }));
    const res = response();
    await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(res.statusCode).toBe(status);
    expect(res.body).toMatchObject({ error: { code, retryable: false } });
    const logged = level === 'error' ? H.logError : H.logWarn;
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ code, reason, status }),
      'Speech synthesis failed',
    );
  });
  it('answers and logs an unconfigured storage as unavailable speech, before egress', async () => {
    H.link.mockReturnValue(null);
    const res = response();
    await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: { code: 'SPEECH_UNAVAILABLE', retryable: false } });
    expect(H.synthesizeSpeech).not.toHaveBeenCalled();
    expect(H.logError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SPEECH_UNAVAILABLE', reason: 'storage_unavailable' }),
      'Speech synthesis failed',
    );
  });
  it('never logs the text, the user or the conversation', async () => {
    const input = 'Mi número secreto es 1234';
    H.synthesizeSpeech.mockRejectedValue(
      new SpeechSynthesisError('SPEECH_REJECTED', { reason: 'refused', param: 'input' }),
    );
    await handler()({ user: { id: 'u1' }, body: { ...body, input } }, response(), undefined);
    H.synthesizeSpeech.mockRejectedValue(new Error(input));
    await handler()({ user: { id: 'u1' }, body: { ...body, input } }, response(), undefined);
    const logged = JSON.stringify([...H.logWarn.mock.calls, ...H.logError.mock.calls]);
    expect(H.logWarn).toHaveBeenCalledTimes(1);
    expect(H.logError).toHaveBeenCalledTimes(1);
    for (const secret of [input, '1234', 'u1', 'c1', 'm1']) expect(logged).not.toContain(secret);
  });
  it('removes generated storage when the message disappears before attachment', async () => {
    H.save.mockResolvedValue(0);
    const res = response();
    await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: { code: 'SPEECH_GENERATION_FAILED' } });
    expect(H.remove).toHaveBeenCalledWith(['test/audio/u1/speech.mp3']);
    expect(H.logError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SPEECH_GENERATION_FAILED', stage: 'attachment' }),
      'Speech generation failed',
    );
  });
  it('cancels synthesis when its client disconnects', async () => {
    const res = response();
    H.synthesizeSpeech.mockImplementation(async (options) => {
      res.emit('close');
      options.signal.throwIfAborted();
    });
    await handler()({ user: { id: 'u1' }, body }, res, undefined);
    expect(H.upload).not.toHaveBeenCalled();
    expect(res.body).toBeUndefined();
    expect(res.listenerCount('close')).toBe(0);
    expect(H.logError).not.toHaveBeenCalled();
  });
});

it.each([
  'active-bundle',
  'expired-bundle',
  'canceled-bundle',
  'stale-authority',
  'conflicting-grants',
  'multiple-grants',
  'individual-and-bundle',
])('preserves authenticated standalone speech independent of %s', async (state) => {
  H.snapshot.mockRejectedValue(new Error(`Bundle authority must not be consulted: ${state}`));
  const res = response();
  await handler()({ user: { id: 'u1' }, accessToken: 'session', body }, res, undefined);
  expect(H.snapshot).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(200);
  expect(H.synthesizeSpeech).toHaveBeenCalledTimes(1);
});
