import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

/**
 * The speech-clip index against a real Postgres: what the in-memory fakes in
 * `lib/__tests__/speech-clips.test.ts` and the route test assume, held to the
 * SQL — owner scoping, the conflict that keeps one object, the conversation
 * claim, the purge and the retention sweep — and the cache end to end over it,
 * with synthesis and storage faked.
 */

const H = vi.hoisted(() => ({
  synthesize: vi.fn(),
  removed: [] as string[],
  uploads: 0,
}));
vi.mock('../../lib/synthesize-speech.js', () => ({
  speechModelCandidates: vi.fn(async () => ['acme/voice']),
  synthesizeSpeech: H.synthesize,
}));
vi.mock('../../lib/s3.js', () => ({
  uploadToS3: vi.fn(async (_audio: Buffer, _name: string, folder: string) => {
    H.uploads += 1;
    return `test/${folder}/speech-${H.uploads}.mp3`;
  }),
  uploadToS3Deterministic: vi.fn(async (_audio: Buffer, key: string) => {
    H.uploads += 1;
    return key;
  }),
  deleteS3Objects: vi.fn(async (keys: readonly string[]) => {
    H.removed.push(...keys);
    return keys.length;
  }),
}));
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { speech: child, general: child, files: child } };
});

import { closePostgres, connectPostgres, type ApiDatabase } from '../index.js';
import { speechClips } from '../schema/speech.js';
import {
  deleteConversationSpeechClips,
  deleteStaleSpeechClips,
  findSpeechClips,
  indexSpeechClip,
  touchSpeechClip,
} from '../chat/speechClipRepository.js';
import {
  obtainSpeechClip,
  purgeConversationSpeechClips,
  SPEECH_CLIP_RETENTION_DAYS,
  sweepSpeechClips,
} from '../../lib/speech-clips.js';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

/** Every person here is this file's own, so parallel files never see these rows. */
const ALICE = `speech-alice-${crypto.randomUUID()}`;
const BOB = `speech-bob-${crypto.randomUUID()}`;

beforeEach(async () => {
  H.removed.length = 0;
  H.synthesize.mockReset();
  H.synthesize.mockImplementation(async () => ({
    audio: Buffer.from('ID3'),
    format: 'mp3',
    requestId: 'req_pg',
    model: 'acme/voice',
  }));
  await db.delete(speechClips).where(sql`${speechClips.oxyUserId} in (${ALICE}, ${BOB})`);
});

const rowsOf = (user: string) =>
  db
    .select({
      cacheKey: speechClips.cacheKey,
      conversationId: speechClips.conversationId,
      objectKey: speechClips.objectKey,
    })
    .from(speechClips)
    .where(eq(speechClips.oxyUserId, user))
    .orderBy(speechClips.cacheKey);

describe('the index', () => {
  it('finds a clip only for its owner', async () => {
    await indexSpeechClip(db, { cacheKey: `${ALICE}-k1`, oxyUserId: ALICE, objectKey: 'o1' });
    expect(await findSpeechClips(db, ALICE, [`${ALICE}-k1`, `${ALICE}-k2`])).toEqual([
      { cacheKey: `${ALICE}-k1`, objectKey: 'o1', oxyFileId: null },
    ]);
    expect(await findSpeechClips(db, BOB, [`${ALICE}-k1`])).toEqual([]);
    expect(await findSpeechClips(db, ALICE, [])).toEqual([]);
  });

  it('keeps the first object indexed under a key, and answers it to the second', async () => {
    expect(
      await indexSpeechClip(db, { cacheKey: `${ALICE}-k`, oxyUserId: ALICE, objectKey: 'first' }),
    ).toMatchObject({ objectKey: 'first', oxyFileId: null });
    expect(
      await indexSpeechClip(db, { cacheKey: `${ALICE}-k`, oxyUserId: ALICE, objectKey: 'second' }),
    ).toMatchObject({ objectKey: 'first', oxyFileId: null });
    expect(await rowsOf(ALICE)).toEqual([
      { cacheKey: `${ALICE}-k`, conversationId: null, objectKey: 'first' },
    ]);
  });

  it('lets the first conversation that asks claim a clip, and never moves it', async () => {
    await indexSpeechClip(db, { cacheKey: `${ALICE}-k`, oxyUserId: ALICE, objectKey: 'o' });
    await touchSpeechClip(db, ALICE, `${ALICE}-k`, null);
    expect((await rowsOf(ALICE))[0]?.conversationId).toBeNull();
    await touchSpeechClip(db, ALICE, `${ALICE}-k`, 'c1');
    await touchSpeechClip(db, ALICE, `${ALICE}-k`, 'c2');
    await touchSpeechClip(db, BOB, `${ALICE}-k`, 'bob-conv');
    expect((await rowsOf(ALICE))[0]?.conversationId).toBe('c1');
  });

  it('deletes a conversation’s clips for that person only', async () => {
    for (const [user, key, conversation] of [
      [ALICE, `${ALICE}-a`, 'c1'],
      [ALICE, `${ALICE}-b`, 'c2'],
      [BOB, `${BOB}-a`, 'c1'],
    ] as const) {
      await indexSpeechClip(db, { cacheKey: key, oxyUserId: user, objectKey: `${key}.mp3` });
      await touchSpeechClip(db, user, key, conversation);
    }
    expect(await deleteConversationSpeechClips(db, ALICE, 'c1')).toEqual([
      { cacheKey: `${ALICE}-a`, objectKey: `${ALICE}-a.mp3`, oxyFileId: null },
    ]);
    expect((await rowsOf(ALICE)).map((row) => row.conversationId)).toEqual(['c2']);
    expect(await rowsOf(BOB)).toHaveLength(1);
  });

  it('sweeps clips unused for the retention, and a hit restarts the clock', async () => {
    /**
     * In a transaction, per CONVENTIONS ("A fixture that is DELIBERATELY
     * EXPIRED must be written in a transaction"): the sweep selects by age
     * across people, so a committed stale row would be any other run's to take.
     */
    await db
      .transaction(async (tx) => {
        const old = sql`now() - make_interval(days => ${SPEECH_CLIP_RETENTION_DAYS + 1})`;
        await tx.insert(speechClips).values([
          { cacheKey: `${ALICE}-old`, oxyUserId: ALICE, objectKey: 'old.mp3', lastUsedAt: old },
          { cacheKey: `${ALICE}-used`, oxyUserId: ALICE, objectKey: 'used.mp3', lastUsedAt: old },
          { cacheKey: `${ALICE}-new`, oxyUserId: ALICE, objectKey: 'new.mp3' },
        ]);
        await tx
          .update(speechClips)
          .set({ lastUsedAt: sql`now()` })
          .where(eq(speechClips.cacheKey, `${ALICE}-used`));
        const swept = await deleteStaleSpeechClips(tx, SPEECH_CLIP_RETENTION_DAYS, 500);
        const keys = swept.clips.map((clip) => clip.objectKey);
        expect(keys).toContain('old.mp3');
        expect(keys).not.toContain('used.mp3');
        expect(keys).not.toContain('new.mp3');
        expect(swept.truncated).toBe(false);
        const left = await tx
          .select({ cacheKey: speechClips.cacheKey })
          .from(speechClips)
          .where(eq(speechClips.oxyUserId, ALICE));
        expect(left.map((row) => row.cacheKey).sort()).toEqual([`${ALICE}-new`, `${ALICE}-used`]);
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback') throw error;
      });
  });

  it('reports a sweep that hit its batch limit as truncated', async () => {
    await db
      .transaction(async (tx) => {
        const old = sql`now() - make_interval(days => ${SPEECH_CLIP_RETENTION_DAYS + 1})`;
        await tx.insert(speechClips).values(
          [1, 2, 3].map((n) => ({
            cacheKey: `${ALICE}-old-${n}`,
            oxyUserId: ALICE,
            objectKey: `old-${n}.mp3`,
            lastUsedAt: old,
          })),
        );
        const swept = await deleteStaleSpeechClips(tx, SPEECH_CLIP_RETENTION_DAYS, 2);
        expect(swept.clips).toHaveLength(2);
        expect(swept.truncated).toBe(true);
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback') throw error;
      });
  });
});

describe('the cache over the real index', () => {
  const ask = (user: string, patch: { conversationId?: string | null; voice?: string } = {}) =>
    obtainSpeechClip(db, {
      userId: user,
      input: 'Hola, ¿qué tal?',
      voice: patch.voice ?? 'female',
      conversationId: patch.conversationId ?? null,
      signal: new AbortController().signal,
    });

  it('synthesizes once, then answers from storage — for that person only', async () => {
    const first = await ask(ALICE, { conversationId: 'c1' });
    const second = await ask(ALICE);
    expect(first.cache).toBe('miss');
    expect(second).toMatchObject({ cache: 'hit', locator: first.locator });
    expect((await ask(ALICE, { voice: 'male' })).cache).toBe('miss');
    expect((await ask(BOB)).cache).toBe('miss');
    expect(H.synthesize).toHaveBeenCalledTimes(3);
    expect((await rowsOf(ALICE)).map((row) => row.conversationId).sort()).toEqual(['c1', null]);
  });

  it('a deleted conversation takes its clips, rows and objects', async () => {
    const clip = await ask(ALICE, { conversationId: 'c1' });
    await ask(BOB, { conversationId: 'c1' });
    expect(await purgeConversationSpeechClips(db, ALICE, 'c1')).toBe(1);
    expect(H.removed).toEqual([clip.locator]);
    expect(await rowsOf(ALICE)).toEqual([]);
    expect(await rowsOf(BOB)).toHaveLength(1);
    expect((await ask(ALICE)).cache).toBe('miss');
  });

  it('keeps the rows when the objects cannot be deleted, so the purge can be repeated', async () => {
    await ask(ALICE, { conversationId: 'c1' });
    const { deleteS3Objects } = await import('../../lib/s3.js');
    vi.mocked(deleteS3Objects).mockRejectedValueOnce(new Error('storage is down'));
    await expect(purgeConversationSpeechClips(db, ALICE, 'c1')).rejects.toThrow('storage is down');
    expect(await rowsOf(ALICE)).toHaveLength(1);
    expect(await purgeConversationSpeechClips(db, ALICE, 'c1')).toBe(1);
  });

  it('a sweep never throws', async () => {
    await expect(sweepSpeechClips(db)).resolves.toBeUndefined();
  });
});
