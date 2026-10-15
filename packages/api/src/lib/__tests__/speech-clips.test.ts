import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The speech-clip cache, with the index held in memory and synthesis, storage
 * and the catalogue faked. What the SQL does — scoping, the conflict, the
 * conversation claim, the sweep — is `db/__tests__/speechClips.pgdb.test.ts`.
 */

interface Row {
  cacheKey: string;
  oxyUserId: string;
  conversationId: string | null;
  objectKey: string;
}

const H = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  candidates: vi.fn(),
  synthesize: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  index: vi.fn(),
  uploads: 0,
}));

vi.mock('../synthesize-speech.js', () => ({
  speechModelCandidates: H.candidates,
  synthesizeSpeech: H.synthesize,
}));
vi.mock('../s3.js', () => ({ uploadToS3: H.upload, deleteS3Objects: H.remove }));
vi.mock('../logger.js', () => ({
  log: { speech: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../db/index.js', () => ({ getDb: vi.fn() }));
vi.mock('../../db/chat/speechClipRepository.js', () => ({
  findSpeechClips: async (_db: unknown, user: string, keys: readonly string[]) =>
    [...H.rows.values()]
      .filter((row) => row.oxyUserId === user && keys.includes(row.cacheKey))
      .map(({ cacheKey, objectKey }) => ({ cacheKey, objectKey })),
  touchSpeechClip: async (
    _db: unknown,
    user: string,
    key: string,
    conversationId: string | null,
  ) => {
    const row = H.rows.get(key);
    if (row?.oxyUserId === user) row.conversationId ??= conversationId;
  },
  indexSpeechClip: H.index,
  deleteConversationSpeechClips: async (_db: unknown, user: string, conversationId: string) => {
    const gone = [...H.rows.values()].filter(
      (row) => row.oxyUserId === user && row.conversationId === conversationId,
    );
    for (const row of gone) H.rows.delete(row.cacheKey);
    return gone.map((row) => row.objectKey);
  },
  deleteStaleSpeechClips: vi.fn(),
}));

const {
  normalizeSpeechSpeed,
  obtainSpeechClip,
  purgeConversationSpeechClips,
  speechClipKey,
  SPEECH_CLIP_KEY_VERSION,
} = await import('../speech-clips.js');

const db = {
  transaction: async <T>(work: (tx: unknown) => Promise<T>) => work({}),
} as unknown as Parameters<typeof obtainSpeechClip>[0];

const ask = (patch: Partial<Parameters<typeof obtainSpeechClip>[1]> = {}) =>
  obtainSpeechClip(db, {
    userId: 'u1',
    input: 'Hola, ¿qué tal?',
    voice: 'female',
    conversationId: null,
    signal: new AbortController().signal,
    ...patch,
  });

function made(model: string, requestId = 'req_1') {
  return { audio: Buffer.from('ID3'), format: 'mp3', requestId, model };
}

beforeEach(() => {
  H.rows.clear();
  H.uploads = 0;
  vi.clearAllMocks();
  H.candidates.mockResolvedValue(['acme/voice', 'beta/voice']);
  H.synthesize.mockImplementation(async () => made('acme/voice'));
  H.upload.mockImplementation(async (_audio: Buffer, _name: string, folder: string) => {
    H.uploads += 1;
    return `test/${folder}/speech-${H.uploads}.mp3`;
  });
  H.remove.mockImplementation(async (keys: readonly string[]) => keys.length);
  H.index.mockImplementation(
    async (_db: unknown, clip: { cacheKey: string; oxyUserId: string; objectKey: string }) => {
      const standing = H.rows.get(clip.cacheKey);
      if (standing) return standing.objectKey;
      H.rows.set(clip.cacheKey, { ...clip, conversationId: null });
      return clip.objectKey;
    },
  );
});

describe('the key', () => {
  const parts = {
    userId: 'u1',
    model: 'acme/voice',
    voice: 'female',
    speed: undefined,
    format: 'mp3',
    input: 'Hola',
  };

  it('is a stable SHA-256 of every part, the version included', () => {
    expect(speechClipKey(parts)).toMatch(/^[0-9a-f]{64}$/);
    expect(speechClipKey(parts)).toBe(speechClipKey({ ...parts }));
    expect(SPEECH_CLIP_KEY_VERSION).toBe(1);
    const variants = [
      { userId: 'u2' },
      { model: 'beta/voice' },
      { voice: 'male' },
      { speed: 1.15 },
      { format: 'wav' },
      { input: 'Hola ' },
      { input: 'hola' },
    ];
    const keys = new Set(variants.map((patch) => speechClipKey({ ...parts, ...patch })));
    expect(keys.size).toBe(variants.length);
    expect(keys.has(speechClipKey(parts))).toBe(false);
  });

  it('cannot be forged by moving text between parts', () => {
    expect(speechClipKey({ ...parts, voice: 'fe', input: 'maleHola' })).not.toBe(
      speechClipKey({ ...parts, voice: 'female', input: 'Hola' }),
    );
  });

  it('normalizes speed to two decimals, and 1 to the model’s own', () => {
    expect(normalizeSpeechSpeed(undefined)).toBeUndefined();
    expect(normalizeSpeechSpeed(1)).toBeUndefined();
    expect(normalizeSpeechSpeed(1.004)).toBeUndefined();
    expect(normalizeSpeechSpeed(1.149)).toBe(1.15);
    expect(normalizeSpeechSpeed(0.7)).toBe(0.7);
  });
});

describe('a clip is made once', () => {
  it('synthesizes and stores on a miss', async () => {
    const clip = await ask();
    expect(clip).toEqual({
      objectKey: 'test/tts/u1/speech-1.mp3',
      model: 'acme/voice',
      cache: 'miss',
      inflight: false,
      requestId: 'req_1',
    });
    expect(H.synthesize).toHaveBeenCalledWith({
      input: 'Hola, ¿qué tal?',
      voice: 'female',
      format: 'mp3',
      userId: 'u1',
      signal: expect.any(AbortSignal),
    });
    expect(H.upload).toHaveBeenCalledWith(expect.any(Buffer), 'speech.mp3', 'tts/u1', 'speech');
    expect([...H.rows.values()]).toEqual([
      {
        cacheKey: speechClipKey({
          userId: 'u1',
          model: 'acme/voice',
          voice: 'female',
          speed: undefined,
          format: 'mp3',
          input: 'Hola, ¿qué tal?',
        }),
        oxyUserId: 'u1',
        conversationId: null,
        objectKey: 'test/tts/u1/speech-1.mp3',
      },
    ]);
  });

  it('answers a hit from storage without synthesizing', async () => {
    await ask();
    const clip = await ask();
    expect(clip).toEqual({
      objectKey: 'test/tts/u1/speech-1.mp3',
      model: 'acme/voice',
      cache: 'hit',
      inflight: false,
    });
    expect(H.synthesize).toHaveBeenCalledTimes(1);
    expect(H.upload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another voice', { voice: 'male' }],
    ['another speed', { speed: 1.25 }],
    ['other text', { input: 'Hola, ¿qué tal? ' }],
    ['another person', { userId: 'u2' }],
  ])('misses for %s', async (_label, patch) => {
    await ask();
    const clip = await ask(patch);
    expect(clip.cache).toBe('miss');
    expect(H.synthesize).toHaveBeenCalledTimes(2);
    expect(H.rows.size).toBe(2);
  });

  it('treats speed 1 as no speed, and sends synthesis the normalized value', async () => {
    await ask({ speed: 1 });
    expect(H.synthesize.mock.calls[0]?.[0]).not.toHaveProperty('speed');
    expect((await ask()).cache).toBe('hit');
    expect((await ask({ speed: 1.004 })).cache).toBe('hit');
    await ask({ speed: 1.149 });
    expect(H.synthesize.mock.calls[1]?.[0]).toMatchObject({ speed: 1.15 });
    expect((await ask({ speed: 1.15 })).cache).toBe('hit');
    expect(H.synthesize).toHaveBeenCalledTimes(2);
  });

  it('stores a fallback under the model that made it, and serves it after', async () => {
    H.synthesize.mockImplementation(async () => made('beta/voice', 'req_fallback'));
    const first = await ask();
    expect(first).toMatchObject({ cache: 'miss', model: 'beta/voice' });
    const [row] = H.rows.values();
    expect(row?.cacheKey).toBe(
      speechClipKey({
        userId: 'u1',
        model: 'beta/voice',
        voice: 'female',
        speed: undefined,
        format: 'mp3',
        input: 'Hola, ¿qué tal?',
      }),
    );
    // The first model would refuse again; the fallback's clip answers without asking.
    expect(await ask()).toMatchObject({ cache: 'hit', model: 'beta/voice' });
    expect(H.synthesize).toHaveBeenCalledTimes(1);
  });

  it('serves the best-ranked model that has a clip', async () => {
    H.synthesize.mockImplementationOnce(async () => made('beta/voice'));
    await ask();
    H.candidates.mockResolvedValue(['acme/voice']);
    await ask();
    H.candidates.mockResolvedValue(['acme/voice', 'beta/voice']);
    expect(await ask()).toMatchObject({ cache: 'hit', model: 'acme/voice' });
  });

  it('misses when the clip’s model is no longer a candidate', async () => {
    await ask();
    H.candidates.mockResolvedValue(['gamma/voice']);
    H.synthesize.mockImplementation(async () => made('gamma/voice'));
    expect(await ask()).toMatchObject({ cache: 'miss', model: 'gamma/voice' });
    expect(H.synthesize).toHaveBeenCalledTimes(2);
  });

  it('claims an unclaimed clip for the conversation that asks', async () => {
    await ask();
    await ask({ conversationId: 'c1' });
    await ask({ conversationId: 'c2' });
    expect([...H.rows.values()].map((row) => row.conversationId)).toEqual(['c1']);
  });
});

describe('two identical requests at once', () => {
  it('pay for one synthesis', async () => {
    let finish: () => void = () => {};
    H.synthesize.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(made('acme/voice'));
        }),
    );
    const first = ask();
    const second = ask();
    await vi.waitFor(() => expect(H.synthesize).toHaveBeenCalledTimes(1));
    finish();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ cache: 'miss', inflight: false, requestId: 'req_1' });
    expect(b).toEqual({
      objectKey: a.objectKey,
      model: 'acme/voice',
      cache: 'hit',
      inflight: true,
    });
    expect(H.synthesize).toHaveBeenCalledTimes(1);
    expect(H.upload).toHaveBeenCalledTimes(1);
  });

  it('keep synthesizing while one of them still waits', async () => {
    let finish: () => void = () => {};
    let synthesisSignal: AbortSignal | undefined;
    H.synthesize.mockImplementation(
      (options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          synthesisSignal = options.signal;
          finish = () => resolve(made('acme/voice'));
        }),
    );
    const leaving = new AbortController();
    const first = ask({ signal: leaving.signal });
    const second = ask();
    await vi.waitFor(() => expect(H.synthesize).toHaveBeenCalledTimes(1));
    leaving.abort();
    await expect(first).rejects.toBeDefined();
    expect(synthesisSignal?.aborted).toBe(false);
    finish();
    expect(await second).toMatchObject({ cache: 'hit', inflight: true });
  });

  it('cancel the synthesis when the last one leaves, and the next starts afresh', async () => {
    let synthesisSignal: AbortSignal | undefined;
    H.synthesize.mockImplementation(
      (options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          synthesisSignal = options.signal;
          options.signal.addEventListener('abort', () => reject(options.signal.reason));
        }),
    );
    const leaving = new AbortController();
    const first = ask({ signal: leaving.signal });
    await vi.waitFor(() => expect(H.synthesize).toHaveBeenCalledTimes(1));
    leaving.abort();
    await expect(first).rejects.toBeDefined();
    expect(synthesisSignal?.aborted).toBe(true);
    expect(H.upload).not.toHaveBeenCalled();

    H.synthesize.mockImplementation(async () => made('acme/voice'));
    expect(await ask()).toMatchObject({ cache: 'miss' });
    expect(H.synthesize).toHaveBeenCalledTimes(2);
  });

  it('across tasks: the clip indexed first stands, and the surplus object is deleted', async () => {
    H.index.mockResolvedValueOnce('test/tts/u1/from-another-task.mp3');
    const clip = await ask();
    expect(clip.objectKey).toBe('test/tts/u1/from-another-task.mp3');
    expect(H.remove).toHaveBeenCalledWith(['test/tts/u1/speech-1.mp3']);
  });
});

describe('failures', () => {
  it('deletes the stored object when it cannot be indexed', async () => {
    H.index.mockRejectedValueOnce(new Error('connection lost'));
    await expect(ask()).rejects.toThrow('connection lost');
    expect(H.remove).toHaveBeenCalledWith(['test/tts/u1/speech-1.mp3']);
  });

  it('stores nothing when synthesis fails', async () => {
    H.synthesize.mockRejectedValueOnce(new Error('refused'));
    await expect(ask()).rejects.toThrow('refused');
    expect(H.upload).not.toHaveBeenCalled();
    expect(H.rows.size).toBe(0);
  });
});

describe('a deleted conversation takes its clips', () => {
  it('removes the rows and the objects of that conversation only', async () => {
    await ask({ conversationId: 'c1' });
    await ask({ conversationId: 'c2', input: 'Otra' });
    await ask({ userId: 'u2', conversationId: 'c1' });
    await expect(purgeConversationSpeechClips(db, 'u1', 'c1')).resolves.toBe(1);
    expect(H.remove).toHaveBeenCalledWith(['test/tts/u1/speech-1.mp3']);
    expect([...H.rows.values()].map((row) => [row.oxyUserId, row.conversationId])).toEqual([
      ['u1', 'c2'],
      ['u2', 'c1'],
    ]);
    // Gone means made again on the next request.
    expect((await ask({ conversationId: 'c1' })).cache).toBe('miss');
  });
});
