import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index';
import { userCredits } from '../../../db/schema/billing';
import { showEpisodes, showSeries } from '../../../db/schema/shows';
import { getOrCreateUserCredits } from '../../../db/billing/userCreditsRepository';
import { createEpisode, createSeries, findEpisodeById } from '../../../db/shows/showRepository';

/**
 * The show pipeline's CREDIT behaviour, against a real Postgres balance.
 *
 * ## Why this file exists
 *
 * `reserveCredits` DEBITS on the way in. The pipeline this replaces answered
 * three of its failure paths with `finalizeCredits(reservation, { totalTokens:
 * 0 })`, and `calculateCreditsFromTokens` returns `MIN_CREDITS_PER_REQUEST` for
 * zero tokens — so a show that produced nothing still charged its owner one
 * credit. Silently, on the path where nothing worked, which is the path a user
 * is least willing to be billed for.
 *
 * A mocked balance cannot test this. The claim is arithmetic over a real row
 * across two statements issued minutes apart, and the failure mode is a number
 * that is one lower than it should be — which every mock reports as whatever it
 * was told to report.
 *
 * ## What is stubbed, and what deliberately is not
 *
 * Everything that leaves the process is stubbed: the model, speech synthesis,
 * S3, Syra, the socket and notifications. `credits-manager` and the show
 * repository are NOT — they are the subject.
 */

const OWNER = 'show-pipeline-credits-owner';

/** Set by each test before the pipeline runs; decides where the run fails. */
let scriptReply: string | null = null;
let synthesisWorks = true;

vi.mock('../../chat-core.js', () => ({
  resolveModel: vi.fn(async () => ({ provider: 'stub', modelId: 'stub-model' })),
  getAIModel: vi.fn(() => ({ id: 'stub-model' })),
  getDefaultAliaModel: vi.fn(() => 'alia-v1'),
  getAliaModel: vi.fn(async () => ({ creditMultiplier: 1 })),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(async () => {
    if (scriptReply === null) throw new Error('stubbed model refused');
    return { text: scriptReply };
  }),
}));

vi.mock('../../synthesize-speech.js', () => ({
  synthesizeSpeech: vi.fn(async () =>
    synthesisWorks ? { audio: Buffer.from('fake-mp3-bytes'), format: 'mp3' } : null,
  ),
}));

/**
 * The sound-effect chain, stubbed at the SAME seam speech is stubbed at.
 *
 * Left real it would reach `provider_keys` on the test database, find nothing
 * and answer null — which is the production failure and would make every
 * assertion below about an episode with no effects, quietly.
 */
let effectsWork = true;
const synthesizeSoundEffect = vi.fn(async (_options: { prompt: string }) =>
  effectsWork ? { audio: Buffer.from('fake-sfx-bytes'), format: 'mp3' } : null,
);
vi.mock('../../synthesize-sound-effect.js', () => ({
  synthesizeSoundEffect: (options: { prompt: string }) => synthesizeSoundEffect(options),
}));

vi.mock('../../s3.js', () => ({
  uploadToS3: vi.fn(async () => 'test/show-segments/key.mp3'),
  deleteS3Objects: vi.fn(async () => 0),
}));

/** Counts redemptions, so a test can assert nothing was published. */
const ingestEpisode = vi.fn(async () => ({ id: 'syra-episode' }));
vi.mock('../../syra/syra.js', () => ({
  syraForTicket: () => ({ ingestEpisode }),
}));

vi.mock('../../../socket.js', () => ({ getIO: () => null }));
vi.mock('../../notification-service.js', () => ({ sendNotification: vi.fn(async () => undefined) }));
/** Set per test; `null` is ffmpeg being unavailable or the bytes unreadable. */
let measuredDurationMs: number | null = 90_000;
vi.mock('../show-audio.js', () => ({
  concatenateAudioSegments: vi.fn(async (parts: Buffer[]) => Buffer.concat(parts)),
  measureAudioDurationMs: vi.fn(async () => measuredDurationMs),
}));

let db: ApiDatabase;

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  scriptReply = null;
  synthesisWorks = true;
  effectsWork = true;
  measuredDurationMs = 90_000;
  ingestEpisode.mockClear();
  synthesizeSoundEffect.mockClear();
  /**
   * Scoped to THIS file's account, never a bare truncate. One database serves
   * the whole run and vitest runs FILES in parallel, so an unpredicated delete
   * reaps `showRepository.pgdb.test.ts`'s fixtures mid-test — measured, as a
   * balance assertion here that passed alone and failed in the full run.
   */
  await db.delete(showEpisodes).where(eq(showEpisodes.userId, OWNER));
  await db.delete(showSeries).where(eq(showSeries.userId, OWNER));
});

/** An account with an exact opening balance, so an assertion is about the run. */
async function fund(free: number): Promise<void> {
  await getOrCreateUserCredits(db, OWNER);
  await db.update(userCredits).set({ creditsFree: free, creditsPaid: 0 }).where(eq(userCredits.id, OWNER));
}

async function balance(): Promise<number> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, OWNER)).limit(1);
  return (row?.creditsFree ?? 0) + (row?.creditsPaid ?? 0);
}

/** A series and one queued episode, ready to run. */
async function queueEpisode(): Promise<string> {
  const series = await createSeries(db, {
    id: uuidv7(),
    userId: OWNER,
    syraPodcastId: `syra-${uuidv7()}`,
    title: 'The Wednesday Digest',
    format: 'podcast',
    brief: 'A weekly look at whatever the owner has been reading.',
    speakers: [
      { name: 'Marcus', voiceId: 'v1', voiceName: 'Marcus', role: 'host' },
      { name: 'Sarah', voiceId: 'v2', voiceName: 'Sarah', role: 'co-host' },
    ],
    visibility: 'private',
  });

  const episode = await createEpisode(db, {
    userId: OWNER,
    seriesId: series.id,
    episodeNumber: 1,
    title: 'The first one',
    topic: 'what happened this week',
    syraEpisodeId: 'syra-episode',
    ingestTicket: 'ticket-1',
    ingestTicketExpiresAt: new Date(Date.now() + 86_400_000),
  });

  return episode.id;
}

/** A well-formed script naming only the series' own cast. */
const GOOD_SCRIPT = JSON.stringify({
  description: 'A short episode.',
  summary: 'A longer summary of the episode.',
  recap: 'They discussed what happened this week.',
  segments: [
    { type: 'dialogue', speaker: 'Marcus', text: 'Welcome back to the show.' },
    { type: 'dialogue', speaker: 'Sarah', text: 'Glad to be here.' },
    { type: 'dialogue', speaker: 'Marcus', text: 'So, what happened this week?' },
  ],
});

/**
 * The same script with the sound cues a real one carries: an intro, a
 * transition and an outro, which is what `script-prompt.ts` asks for on every
 * episode.
 */
const SCRIPT_WITH_SFX = JSON.stringify({
  description: 'A short episode.',
  summary: 'A longer summary of the episode.',
  recap: 'They discussed what happened this week.',
  segments: [
    { type: 'sfx', speaker: '', text: '', sfxPrompt: 'upbeat show intro jingle, 4 seconds' },
    { type: 'dialogue', speaker: 'Marcus', text: 'Welcome back to the show.' },
    { type: 'sfx', speaker: '', text: '', sfxPrompt: 'smooth transition whoosh, 2 seconds' },
    { type: 'dialogue', speaker: 'Sarah', text: 'Glad to be here.' },
    { type: 'dialogue', speaker: 'Marcus', text: 'So, what happened this week?' },
    { type: 'sfx', speaker: '', text: '', sfxPrompt: 'warm outro sting, 3 seconds' },
  ],
});

/**
 * THE ENTRYPOINT, which is the assertion every unit test of the failover loop
 * cannot make.
 *
 * `synthesize-sound-effect.ts` can be perfectly correct and never reached — a
 * mechanism green and inert — and that is close to what shipped: the pipeline
 * called one provider inline and no chain existed to walk. So this asserts the
 * pipeline ASKS, once per cue, with the script's own words, and that what comes
 * back reaches the finished file.
 */
describe('the pipeline asks the sound-effect chain for every cue the script wrote', () => {
  it('sends each sfxPrompt, and puts the audio into the join', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    scriptReply = SCRIPT_WITH_SFX;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect(synthesizeSoundEffect).toHaveBeenCalledTimes(3);
    expect(synthesizeSoundEffect.mock.calls.map((call) => call[0].prompt)).toEqual([
      'upbeat show intro jingle, 4 seconds',
      'smooth transition whoosh, 2 seconds',
      'warm outro sting, 3 seconds',
    ]);

    /**
     * And the bytes are really in the episode. `concatenateAudioSegments` is
     * stubbed to `Buffer.concat`, so the blob handed to Syra is the segments in
     * playback order — the one place an effect that was generated but dropped
     * on the floor would show up.
     */
    const published = ingestEpisode.mock.calls[0] as unknown as [unknown, Blob];
    const joined = Buffer.from(await published[1].arrayBuffer()).toString();
    expect(joined).toBe(
      'fake-sfx-bytes' +
        'fake-mp3-bytes' +
        'fake-sfx-bytes' +
        'fake-mp3-bytes' +
        'fake-mp3-bytes' +
        'fake-sfx-bytes',
    );
    expect((await findEpisodeById(db, episodeId))?.status).toBe('completed');
  });

  it('still publishes when no effect can be produced, because a whoosh is not the show', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    scriptReply = SCRIPT_WITH_SFX;
    effectsWork = false;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('completed');
    expect(ingestEpisode).toHaveBeenCalledTimes(1);

    // The dialogue survives, in order, with the three cues missing.
    const published = ingestEpisode.mock.calls[0] as unknown as [unknown, Blob];
    expect(Buffer.from(await published[1].arrayBuffer()).toString()).toBe(
      'fake-mp3-bytes' + 'fake-mp3-bytes' + 'fake-mp3-bytes',
    );
  });
});

describe('a failure leaves the balance exactly where it was', () => {
  it('when the script cannot be written', async () => {
    await fund(50);
    const before = await balance();
    const episodeId = await queueEpisode();

    // Every provider refuses, so `generateScript` answers null.
    scriptReply = null;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect(await balance()).toBe(before);
    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('failed');
    expect(episode?.creditsCharged).toBeNull();
    expect(ingestEpisode).not.toHaveBeenCalled();
  });

  it('when no audio can be produced', async () => {
    await fund(50);
    const before = await balance();
    const episodeId = await queueEpisode();

    // The script arrives; every synthesis call answers null, so no segment
    // renders and there is nothing to join.
    scriptReply = GOOD_SCRIPT;
    synthesisWorks = false;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect(await balance()).toBe(before);
    expect((await findEpisodeById(db, episodeId))?.status).toBe('failed');
    expect(ingestEpisode).not.toHaveBeenCalled();
  });

  it('when the ticket has already been spent', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    // A re-run of an episode that was already published.
    await db.update(showEpisodes).set({ ingestTicket: null }).where(eq(showEpisodes.id, episodeId));

    const before = await balance();
    scriptReply = GOOD_SCRIPT;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect(await balance()).toBe(before);
    expect(ingestEpisode).not.toHaveBeenCalled();
  });

  it('when the row has no Syra episode to publish to', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    await db.update(showEpisodes).set({ syraEpisodeId: null }).where(eq(showEpisodes.id, episodeId));

    const before = await balance();
    scriptReply = GOOD_SCRIPT;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect(await balance()).toBe(before);
    // Nothing is sent. Defaulting the id to `''` would post to
    // `/episodes//ingest` and report Syra's 404 as a refusal to publish.
    expect(ingestEpisode).not.toHaveBeenCalled();
    expect((await findEpisodeById(db, episodeId))?.error).toContain('no Syra episode');
  });

  it('when publishing to Syra throws', async () => {
    await fund(50);
    const before = await balance();
    const episodeId = await queueEpisode();

    scriptReply = GOOD_SCRIPT;
    ingestEpisode.mockRejectedValueOnce(new Error('Syra refused the ingest'));

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect(await balance()).toBe(before);
    expect((await findEpisodeById(db, episodeId))?.status).toBe('failed');
  });

  it('and an account with nothing to reserve is not driven negative', async () => {
    await fund(0);
    const episodeId = await queueEpisode();
    scriptReply = GOOD_SCRIPT;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect(await balance()).toBe(0);
    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('failed');
    expect(episode?.error).toBe('Insufficient credits');
  });
});

describe('a success charges what the episode actually cost', () => {
  it('bills from the measured duration, not from a token count nobody measured', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    scriptReply = GOOD_SCRIPT;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('completed');
    expect(ingestEpisode).toHaveBeenCalledTimes(1);

    /**
     * 90 seconds of audio: three at one credit per thirty seconds, plus two for
     * the script. The number matters — the laundering this replaces settled the
     * same episode as `ceil(5 * 50 / 1000)`, which is 1.
     */
    expect(episode?.creditsCharged).toBe(5);
    expect(await balance()).toBe(45);
  });

  it('stores the figure the LEDGER moved, not the one it intended', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    scriptReply = GOOD_SCRIPT;

    const before = await balance();
    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    const spent = before - (await balance());

    /**
     * The integrity claim, asserted as a RELATION rather than as a number: the
     * pipeline this replaces stored its intended figure while the ledger moved
     * a laundered one, so a ten-minute show intended 22, charged 2, and stored
     * 22. Both halves were individually plausible and nothing compared them.
     *
     * `spent` is measured across the whole run — the reservation debits one on
     * the way in and the settle adjusts from there — so it IS what the account
     * lost, independent of how the code got there.
     *
     * **What this catches, stated exactly.** Restoring the laundering while
     * keeping the stored figure — the original bug, both halves — turns it red.
     * Storing the intended figure while the ledger is CORRECT does NOT, and
     * that was measured rather than assumed: `showCreditCost` always returns an
     * integer of at least 3, so `finalizeFixedCredits`'s floor and ceiling never
     * fire and the two numbers are equal in every reachable case. Reading the
     * settled value in the pipeline is therefore a construction choice, not
     * something this assertion proves.
     */
    expect(episode?.creditsCharged).toBe(spent);
    expect(spent).toBeGreaterThan(0);
  });

  it('hands Syra SECONDS, and the episode number, and no ingest ticket afterwards', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    scriptReply = GOOD_SCRIPT;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const call = ingestEpisode.mock.calls[0] as unknown as [
      { episodeId: string; ingestTicket: string },
      unknown,
      { duration?: number; episodeNumber?: number; description?: string },
    ];
    expect(call[0]).toEqual({ episodeId: 'syra-episode', ingestTicket: 'ticket-1' });
    // 90 seconds, NOT 90000. Syra writes this straight into
    // `<itunes:duration>`, so milliseconds would publish a fifty-hour episode.
    expect(call[2].duration).toBe(90);
    expect(call[2].episodeNumber).toBe(1);
    expect(call[2].description).toBe('A short episode.');

    // The capability is spent, so it is not kept.
    expect((await findEpisodeById(db, episodeId))?.ingestTicket).toBeNull();
  });

  it('falls back to the speech rate when the file cannot be measured', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    scriptReply = GOOD_SCRIPT;
    // ffmpeg unavailable, so there is no duration to bill from.
    measuredDurationMs = null;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('completed');

    /**
     * The three dialogue lines are 68 characters together, so one credit at the
     * speech endpoint's own rate of 200 characters per credit, plus two for the
     * script. The point is not the number — it is that an unmeasurable file is
     * neither free nor billed from a figure nobody computed.
     */
    expect(episode?.creditsCharged).toBe(3);
    expect(await balance()).toBe(47);

    // And Syra is told nothing rather than told a guess: it writes the duration
    // it is handed and never revisits it.
    const call = ingestEpisode.mock.calls[0] as unknown as [unknown, unknown, { duration?: number }];
    expect(call[2].duration).toBeUndefined();
    expect(episode?.durationMs).toBeNull();
  });

  it('stores a recap the NEXT episode can read', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    scriptReply = GOOD_SCRIPT;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect((await findEpisodeById(db, episodeId))?.recap).toBe(
      'They discussed what happened this week.',
    );
  });
});

describe('the script parser refuses what would fail later', () => {
  it('rejects a reply naming a speaker outside the series cast', async () => {
    await fund(50);
    const before = await balance();
    const episodeId = await queueEpisode();

    // `Diane` is not in the cast. The old pipeline accepted this, then dropped
    // every one of her segments at synthesis time with only a warning.
    scriptReply = JSON.stringify({
      description: 'd',
      summary: 's',
      recap: 'r',
      segments: [
        { type: 'dialogue', speaker: 'Marcus', text: 'Hello.' },
        { type: 'dialogue', speaker: 'Diane', text: 'Who am I?' },
        { type: 'dialogue', speaker: 'Sarah', text: 'No idea.' },
      ],
    });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect((await findEpisodeById(db, episodeId))?.status).toBe('failed');
    expect(await balance()).toBe(before);
    expect(ingestEpisode).not.toHaveBeenCalled();
  });

  it('rejects a reply with too few segments to be an episode', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    scriptReply = JSON.stringify({
      description: 'd',
      summary: 's',
      recap: 'r',
      segments: [{ type: 'dialogue', speaker: 'Marcus', text: 'That is all.' }],
    });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect((await findEpisodeById(db, episodeId))?.status).toBe('failed');
  });
});
