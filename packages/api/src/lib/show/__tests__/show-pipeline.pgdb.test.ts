import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index';
import { userCredits } from '../../../db/schema/billing';
import { showEpisodes, showSeries } from '../../../db/schema/shows';
import { getOrCreateUserCredits } from '../../../db/billing/userCreditsRepository';
import {
  createEpisode,
  createSeries,
  findEpisodeById,
  listEpisodesForSeries,
  updateEpisode,
} from '../../../db/shows/showRepository';

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

/**
 * Every prompt the pipeline sent, so what the model was TOLD is measurable.
 *
 * The subject of an episode is now the model's to choose, which makes the
 * contents of this prompt a behaviour rather than an implementation detail: a
 * show that repeats itself at episode nine is a show whose prompt did not
 * mention episode two.
 */
const scriptPrompts: { system: string; user: string }[] = [];
const generateText = vi.fn(
  async (options: { messages: { role: string; content: string }[] }) => {
    scriptPrompts.push({
      system: options.messages.find((message) => message.role === 'system')?.content ?? '',
      user: options.messages.find((message) => message.role === 'user')?.content ?? '',
    });
    if (scriptReply === null) throw new Error('stubbed model refused');
    return { text: scriptReply };
  },
);
// Wrapped rather than passed, so the factory does not capture the binding
// before this module has finished initialising.
vi.mock('ai', () => ({
  generateText: (options: { messages: { role: string; content: string }[] }) =>
    generateText(options),
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
  generateText.mockClear();
  scriptPrompts.length = 0;
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

/**
 * A series and one queued episode, ready to run.
 *
 * `topic` defaults to a subject somebody typed, because most of this file is
 * about credits and audio and wants an episode that is simply ready. `null` is
 * the ordinary shape of a real request now — nobody said what it covers — and
 * the tests about the subject pass it explicitly. `title` is the reverse: null
 * by default, because an episode nobody named is the ordinary case.
 */
async function queueEpisode(
  topic: string | null = 'what happened this week',
  episodeNumber = 1,
  title: string | null = null,
): Promise<string> {
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
    episodeNumber,
    // NULL unless a test is about an owner who named their own episode. The
    // route stores nothing here otherwise — `Episode {n}` goes to Syra's draft
    // and not to this column, which is what keeps the two states apart.
    title: title ?? undefined,
    topic: topic ?? undefined,
    syraEpisodeId: 'syra-episode',
    ingestTicket: 'ticket-1',
    ingestTicketExpiresAt: new Date(Date.now() + 86_400_000),
  });

  return episode.id;
}

/**
 * An earlier episode of the SAME series, so the script's prompt has a history
 * to be told about.
 *
 * Takes the episode's number, its subject and its status, because those three
 * are exactly what decides whether it reaches the prompt: a failed run said
 * nothing to a listener and must not retire its subject, while one still
 * recording has already claimed its own.
 */
async function seedPrior(
  seriesId: string,
  episodeNumber: number,
  topic: string,
  options: { readonly recap?: string; readonly status?: 'completed' | 'failed' | 'generating_audio' } = {},
): Promise<void> {
  const episode = await createEpisode(db, {
    userId: OWNER,
    seriesId,
    episodeNumber,
    title: `Episode ${episodeNumber}`,
    topic,
    syraEpisodeId: `syra-episode-${episodeNumber}`,
    ingestTicket: `ticket-${episodeNumber}`,
    ingestTicketExpiresAt: new Date(Date.now() + 86_400_000),
  });

  await updateEpisode(db, episode.id, {
    status: options.status ?? 'completed',
    ...(options.recap === undefined ? {} : { recap: options.recap }),
  });
}

/** The queued episode's own series, for seeding history around it. */
async function seriesOf(episodeId: string): Promise<string> {
  const episode = await findEpisodeById(db, episodeId);
  if (!episode) throw new Error('the queued episode vanished');
  return episode.seriesId;
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

/**
 * A lost cue reaches the OWNER, not just the container's logs.
 *
 * This is the half that was missing while the bug ran. Every sound effect in
 * every episode failed for days; the pipeline logged a warning, skipped the
 * segment, published, and wrote `completed` — so the row, the screen and the
 * notification all described an episode that had everything it asked for. The
 * assertion is therefore about the stored row and about what a ROUTE can read
 * from it, because a flag the pipeline writes and no reader can see is the same
 * silence with more steps.
 */
describe('an episode says which of its segments never rendered', () => {
  it('marks the cues that were lost, and only those', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    scriptReply = SCRIPT_WITH_SFX;
    effectsWork = false;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('completed');

    const failed = (episode?.segments ?? []).filter((segment) => segment.renderFailed === true);
    expect(failed.map((segment) => segment.index)).toEqual([0, 2, 5]);
    // The prompt survives beside the flag, so the row says what the missing
    // sound was meant to be rather than only that something is missing.
    expect(failed[0]?.sfxPrompt).toBe('upbeat show intro jingle, 4 seconds');

    // And nothing that DID render is marked. Marking everything would satisfy
    // the assertion above and tell the owner their whole episode is broken.
    const spoken = (episode?.segments ?? []).filter((segment) => segment.type === 'dialogue');
    expect(spoken).toHaveLength(3);
    expect(spoken.every((segment) => segment.renderFailed === undefined)).toBe(true);
  });

  /**
   * The positive control, and the one that stops the flag from being noise: an
   * episode where everything rendered must carry no mark at all, or the screen
   * shows a warning on every show ever made.
   */
  it('marks nothing when every segment rendered', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    scriptReply = SCRIPT_WITH_SFX;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.segments).toHaveLength(6);
    expect(episode?.segments.some((segment) => segment.renderFailed === true)).toBe(false);
  });

  it('serves the mark to the screen, through the projection a route reads', async () => {
    await fund(50);
    const episodeId = await queueEpisode();
    scriptReply = SCRIPT_WITH_SFX;
    effectsWork = false;

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    /**
     * `EPISODE_PUBLIC_COLUMNS` is an explicit allow-list — a column the table
     * has is not a column a route returns — so reading the row directly proves
     * nothing about what the owner can see. This goes through the same function
     * `GET /shows/series/:id/episodes` calls.
     */
    const episode = await findEpisodeById(db, episodeId);
    const page = await listEpisodesForSeries(db, episode?.seriesId ?? '', 10, 0);
    const served = page.episodes.find((row) => row.id === episodeId);

    expect(served?.segments.filter((segment) => segment.renderFailed === true)).toHaveLength(3);
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

/* -------------------------------------------------------------------------- */
/*  The subject, and the name                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A script carrying whichever of the two new fields a test is about.
 *
 * The key ORDER matters and is the real schema's: `topic` first, because it is
 * the decision the rest follows, and `title` last, after the segments, because
 * a model fills an object in the order it is given and a title asked for above
 * the dialogue is a title written from the subject rather than from the
 * episode.
 */
function scriptWith(fields: { topic?: string; title?: string }): string {
  return JSON.stringify({
    ...(fields.topic === undefined ? {} : { topic: fields.topic }),
    description: 'A short episode.',
    summary: 'A longer summary of the episode.',
    segments: [
      { type: 'dialogue', speaker: 'Marcus', text: 'Welcome back to the show.' },
      { type: 'dialogue', speaker: 'Sarah', text: 'Glad to be here.' },
      { type: 'dialogue', speaker: 'Marcus', text: 'So, what happened this week?' },
    ],
    recap: 'They discussed what happened this week.',
    ...(fields.title === undefined ? {} : { title: fields.title }),
  });
}

/**
 * The episode is named from what it SAYS, and the distinction is the point.
 *
 * The route reserves the Syra draft under `Episode {n}` and the request may
 * carry a subject; neither is the name. A test asserting only that "a title
 * exists" would pass under the design this replaces, where a model turned the
 * requested topic into a title before a word of the episode was written — so
 * every assertion here names the string it must NOT be.
 */
describe('naming an episode after it exists', () => {
  it('takes the name off the script, not off the placeholder or the request', async () => {
    await fund(50);
    const episodeId = await queueEpisode('the trouble with photosynthesis');
    scriptReply = scriptWith({ title: 'How leaves eat light' });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('completed');
    expect(episode?.title).toBe('How leaves eat light');
    // The two strings the old design would have produced instead.
    expect(episode?.title).not.toBe('Episode 1');
    expect(episode?.title).not.toBe('the trouble with photosynthesis');
  });

  /**
   * THE PRECEDENCE, asserted rather than assumed.
   *
   * Both halves of this design are true at once — an episode is named from its
   * script, AND an owner who typed a name keeps it — and which one a test
   * demonstrates depends entirely on its fixture. So the fixture here is the
   * one where they DISAGREE: a person's name on the row and a different name in
   * the script. Without this, "generated from the script" and "the owner's name
   * survives" both pass by accident.
   */
  it("does not touch a name the owner chose, however the script would have named it", async () => {
    await fund(50);
    const episodeId = await queueEpisode('the trouble with photosynthesis', 1, 'The Reckoning');
    scriptReply = scriptWith({ title: 'How leaves eat light' });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('completed');
    expect(episode?.title).toBe('The Reckoning');
    // The name the script proposed, which must not have won.
    expect(episode?.title).not.toBe('How leaves eat light');
  });

  it('falls back to the episode number when the owner named nothing and the script named nothing', async () => {
    // Both overrides absent and the model unhelpful. `Episode 1` is the same
    // string the route reserved the Syra draft under, so the fallback changes
    // nothing on either side.
    await fund(50);
    const episodeId = await queueEpisode('the trouble with photosynthesis');
    scriptReply = scriptWith({});

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('completed');
    expect(episode?.title).toBe('Episode 1');
  });

  it('keeps the placeholder when the reply is an explanation rather than a title', async () => {
    // The positive control. A pipeline that stored whatever came back would
    // pass the test above and put a paragraph on a published episode.
    await fund(50);
    const episodeId = await queueEpisode('the trouble with photosynthesis');
    scriptReply = scriptWith({
      title:
        'Certainly! Here are a few possible names for this episode, depending on the tone you are '.repeat(
          3,
        ),
    });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('completed');
    expect(episode?.title).toBe('Episode 1');
  });

  it('cleans the name, so the cleaner is reached rather than merely correct', async () => {
    // `episode-title.ts` can be perfectly right and never called — a mechanism
    // green and inert. This asserts the ENTRYPOINT runs it.
    await fund(50);
    const episodeId = await queueEpisode('the trouble with photosynthesis');
    scriptReply = scriptWith({ title: 'Title: "How leaves eat light."' });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect((await findEpisodeById(db, episodeId))?.title).toBe('How leaves eat light');
  });
});

/**
 * Nobody says what an episode covers, so the script decides — and what it
 * decided is STORED, because that is what the next episode is told not to do
 * again.
 */
describe('deciding what an episode covers', () => {
  it('stores the subject the script chose when the request named none', async () => {
    await fund(50);
    const episodeId = await queueEpisode(null);
    scriptReply = scriptWith({ topic: 'how a leaf turns light into sugar', title: 'Leaf work' });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('completed');
    expect(episode?.topic).toBe('how a leaf turns light into sugar');

    // And the prompt asked it to choose, rather than handing it a subject.
    expect(scriptPrompts[0]?.user).toContain('Choosing what this episode covers');
  });

  it("keeps the owner's own words when they steered this one", async () => {
    // The positive control: a pipeline that always overwrote `topic` with the
    // model's restatement would pass the test above and quietly rewrite what
    // somebody typed.
    await fund(50);
    const episodeId = await queueEpisode('the election result, and what it changes');
    scriptReply = scriptWith({ topic: 'something else entirely', title: 'After the count' });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.topic).toBe('the election result, and what it changes');
    expect(scriptPrompts[0]?.user).toContain('the election result, and what it changes');
  });

  it('refuses a script that chose no subject, rather than publishing one nothing can describe', async () => {
    await fund(50);
    const before = await balance();
    const episodeId = await queueEpisode(null);
    // A well-formed script in every other respect, with no `topic`. Accepting
    // it publishes an episode the NEXT one is never told about, so the show is
    // free to cover the same thing again.
    scriptReply = scriptWith({ title: 'Leaf work' });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const episode = await findEpisodeById(db, episodeId);
    expect(episode?.status).toBe('failed');
    expect(ingestEpisode).not.toHaveBeenCalled();
    // Retried across the failover loop first, exactly as an unusable script is.
    expect(generateText).toHaveBeenCalledTimes(3);
    // And nothing was charged for it.
    expect(await balance()).toBe(before);
  });

  it('accepts the same script when the owner already named the subject', async () => {
    // The control for the rejection above: the missing `topic` is only a fault
    // when the row has none either.
    await fund(50);
    const episodeId = await queueEpisode('the election result');
    scriptReply = scriptWith({ title: 'After the count' });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    expect((await findEpisodeById(db, episodeId))?.status).toBe('completed');
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

/**
 * What the script is TOLD about the episodes before it.
 *
 * This is the failure the whole design turns on: a prompt carrying only the
 * last few recaps makes episode nine free to cover what episode two covered,
 * because from the model's side episode two never happened. So the assertion is
 * that EVERY earlier subject reaches the prompt while only the recent recaps
 * do — breadth and detail at two different costs.
 */
describe('the script is told what the show has already covered', () => {
  it('lists every earlier subject, and only the recent few in full', async () => {
    await fund(50);
    const episodeId = await queueEpisode(null, 7);
    const seriesId = await seriesOf(episodeId);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      await seedPrior(seriesId, n, `subject ${n}`, { recap: `recap ${n}` });
    }
    scriptReply = scriptWith({ topic: 'something new', title: 'Something new' });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const prompt = scriptPrompts[0]?.user ?? '';
    // Breadth: all six, including the three the recap window cannot reach.
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(prompt).toContain(`Episode ${n}: subject ${n}`);
    }
    // Detail: the last three recaps, and NOT the older ones. Without this the
    // first assertion would also pass a prompt that simply sent everything,
    // which is the cost the split exists to avoid.
    expect(prompt).toContain('Episode 6: recap 6');
    expect(prompt).toContain('Episode 4: recap 4');
    expect(prompt).not.toContain('recap 3');
    expect(prompt).not.toContain('recap 1');
  });

  it('leaves out an episode whose run failed, and keeps one still recording', async () => {
    await fund(50);
    const episodeId = await queueEpisode(null, 4);
    const seriesId = await seriesOf(episodeId);
    await seedPrior(seriesId, 1, 'a subject that aired', { recap: 'recap 1' });
    await seedPrior(seriesId, 2, 'a subject nobody ever heard', { status: 'failed' });
    await seedPrior(seriesId, 3, 'a subject being recorded now', { status: 'generating_audio' });
    scriptReply = scriptWith({ topic: 'something new', title: 'Something new' });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const prompt = scriptPrompts[0]?.user ?? '';
    // A run that died said nothing to a listener, so its subject is free again.
    expect(prompt).not.toContain('a subject nobody ever heard');
    // One still being recorded has already claimed its subject. Leaving it out
    // is how two episodes queued a minute apart cover the same thing.
    expect(prompt).toContain('Episode 3: a subject being recorded now');
    expect(prompt).toContain('Episode 1: a subject that aired');
  });

  it('numbers the recaps from the rows, not by counting backwards from this one', async () => {
    await fund(50);
    const episodeId = await queueEpisode(null, 4);
    const seriesId = await seriesOf(episodeId);
    await seedPrior(seriesId, 1, 'the first subject', { recap: 'recap one' });
    // Episode 2 failed, so the surviving recaps are not contiguous. A prompt
    // that counted backwards from episode 4 would label these 2 and 3, and a
    // host saying "last week we talked about X" when it did not is worse than
    // one that never refers back at all.
    await seedPrior(seriesId, 2, 'a subject nobody ever heard', { status: 'failed' });
    await seedPrior(seriesId, 3, 'the third subject', { recap: 'recap three' });
    scriptReply = scriptWith({ topic: 'something new', title: 'Something new' });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const prompt = scriptPrompts[0]?.user ?? '';
    expect(prompt).toContain('Episode 1: recap one');
    expect(prompt).toContain('Episode 3: recap three');
    expect(prompt).not.toContain('Episode 2: recap');
  });

  it('tells a first episode it is the first, rather than nothing at all', async () => {
    // The vacuity floor for this whole describe: with no history the prompt
    // must still say something, or "contains no earlier subject" would be
    // satisfied by a prompt that was never built.
    await fund(50);
    const episodeId = await queueEpisode(null, 1);
    scriptReply = scriptWith({ topic: 'where this show begins', title: 'Where we begin' });

    const { runShowPipeline } = await import('../show-pipeline.js');
    await runShowPipeline(episodeId);

    const prompt = scriptPrompts[0]?.user ?? '';
    expect(prompt).toContain('This is the FIRST episode');
    expect(prompt).toContain('Write episode 1.');
    expect(prompt).not.toContain('What this show has already covered');
  });
});
