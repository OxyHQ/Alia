/**
 * Generated audio shows — a SERIES of episodes, published to Syra.
 *
 * ## What replaced what, and why the old table could not be extended
 *
 * `shows` was one flat row per generated MP3: a topic, a script, some segments,
 * an S3 key and a 15-minute signed link. It had no series, no episode number, no
 * visibility and no destination — the audio lived and died inside Alia. Syra
 * (`syra.fm`) is Oxy's podcast product, so a generated show now becomes a real
 * podcast a listener can subscribe to and an owner can keep adding to.
 *
 * That is not a column on `shows`. Syra's `episodes.podcast_id` is NOT NULL, so
 * an episode without a show is unrepresentable there — which settles the shape
 * here too: **everything is a series, and a one-off is a series with one
 * episode.** No special case, and "generate another episode" needs no new path.
 *
 * ## The audio is Syra's, so there is no `audio_url` column
 *
 * Deliberately absent, and its absence is the point. The finished MP3 is handed
 * to Syra through an ingest ticket and served from there, with Syra's own
 * visibility rules and its own HLS transcode. A key kept here would be a second
 * address for one recording, and the two would diverge the first time an owner
 * made a show private. Segments still land in S3, but only as ephemeral working
 * storage for the concatenation step — they are not exposed to any client.
 *
 * ## Why `show_preferences` is its own table
 *
 * Alia has no settings table. The only precedent, `user_memories.settings*`
 * (`memory.ts`), hangs a user's preferences off a row that belongs to a
 * different domain, and reusing it would mean a memory profile is created as a
 * side effect of choosing a default podcast visibility. A two-column table keyed
 * by the account is the honest answer, and it is keyed the way `user_credits`
 * is: the account id IS the primary key, with no default, because a generated id
 * would mint a row no lookup could find.
 */

import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf, encryptedText } from './columns';

export const SHOW_FORMATS = ['podcast', 'news', 'debate', 'interview', 'explainer'] as const;
export type ShowFormat = (typeof SHOW_FORMATS)[number];

/**
 * Who may see a series, mirroring Syra's own `podcast_visibility`.
 *
 * The values are Syra's and are sent to it verbatim, so this tuple is a MIRROR
 * of a vocabulary somebody else owns. It carries a CHECK anyway — unlike
 * `subscriptions.status`, where Stripe may invent a value tomorrow, this set is
 * the complete audience axis of a product inside the same organisation, and a
 * fourth value would arrive as a coordinated change to both services rather than
 * as a webhook nobody scheduled.
 */
export const SHOW_VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type ShowVisibility = (typeof SHOW_VISIBILITIES)[number];

/**
 * The statuses an EPISODE moves through.
 *
 * `publishing` is new against the old `shows` set and names the step that did
 * not exist: handing the finished audio to Syra. It sits after `concatenating`
 * and before `completed`, so a run that produced audio and failed to deliver it
 * is distinguishable from one that never produced any.
 *
 * `completed` means Alia's work is done and Syra holds the file. Syra then
 * transcodes it to HLS on its own schedule; that is Syra's episode status, read
 * from Syra, and deliberately not mirrored here — a copy of somebody else's
 * workflow state is a copy that goes stale.
 */
export const SHOW_EPISODE_STATUSES = [
  'queued',
  'generating_script',
  'generating_audio',
  'concatenating',
  'publishing',
  'completed',
  'failed',
] as const;
export type ShowEpisodeStatus = (typeof SHOW_EPISODE_STATUSES)[number];

/**
 * The statuses that mean an episode is still being produced.
 *
 * A SUBSET of {@link SHOW_EPISODE_STATUSES}, not a set of its own — the routes
 * cap concurrent generations by counting rows in these states, so it has to stay
 * a strict subset or the cap silently stops counting something. The type
 * annotation is what enforces that: adding a member that is not a
 * `ShowEpisodeStatus` fails `tsc`.
 */
export const ACTIVE_SHOW_EPISODE_STATUSES: readonly ShowEpisodeStatus[] = [
  'queued',
  'generating_script',
  'generating_audio',
  'concatenating',
  'publishing',
];

export const SHOW_SEGMENT_TYPES = ['dialogue', 'sfx', 'transition'] as const;
export type ShowSegmentType = (typeof SHOW_SEGMENT_TYPES)[number];
export const SHOW_SPEAKER_ROLES = ['host', 'co-host', 'guest', 'narrator'] as const;
export type ShowSpeakerRole = (typeof SHOW_SPEAKER_ROLES)[number];

/** One voice in a series' cast. An element of the `speakers` `jsonb` array. */
export interface ShowSpeaker {
  name: string;
  voiceId: string;
  voiceName: string;
  role: ShowSpeakerRole;
}

/**
 * One spoken or sound segment of an episode.
 *
 * `audioUrl` is an S3 KEY for the working copy of that segment, never an
 * address: it exists so the concatenation step can be resumed and inspected, and
 * no route renders it. The old shape handed each segment's link to the client,
 * which is what made a show's raw dialogue individually downloadable.
 */
export interface ShowSegment {
  index: number;
  speaker: string;
  text: string;
  audioUrl?: string;
  durationMs?: number;
  type: ShowSegmentType;
  sfxPrompt?: string;
  /**
   * This segment asked for audio and got none, so it is not in the episode.
   *
   * The pipeline is right to publish anyway — one missing transition whoosh is
   * a slightly abrupt show, and refusing over it is no show — but it used to
   * publish and say NOTHING. Three sound cues vanished from every episode for
   * days while the row read `completed` and the owner had no way to know, which
   * is worse than an episode that admits what it could not make.
   *
   * So the loss is recorded where it happened, on the segment, rather than
   * summarised into a count somewhere else: the row says exactly which cues are
   * missing and what they were meant to be. `segments` is already in
   * `EPISODE_PUBLIC_COLUMNS`, so the screen derives its notice from this and
   * there is no second copy of the fact to fall out of step.
   *
   * Absent means rendered. Nothing sets it to `false` — a segment that was
   * never attempted cannot exist, because the pipeline builds this array from
   * the script and then walks all of it.
   */
  renderFailed?: boolean;
}

/**
 * A show SERIES — one Alia-side row per Syra podcast.
 *
 * `speakers` is `jsonb`: an ordered cast read whole whenever an episode is
 * produced, with no cross-table reference and no per-element toggle. It lives on
 * the SERIES rather than the episode because voices are the series' identity —
 * a podcast whose hosts changed voice between episodes would be absurd, and the
 * old per-run assignment did exactly that.
 */
export const showSeries = pgTable(
  'show_series',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key — Oxy owns identity. */
    userId: text().notNull(),
    /**
     * The Syra podcast this series publishes to. NOT NULL, and unique.
     *
     * A series exists only as the Alia-side handle on a Syra show, so a row
     * without one would be a series nothing could ever be published to. The
     * route therefore creates the Syra podcast FIRST and inserts this row with
     * the id it answered — a failure there is a failed request, not a
     * half-created series.
     */
    syraPodcastId: text().notNull(),
    title: text().notNull(),
    description: text(),
    /**
     * `$type` restores the literal union the `as unknown as [string, ...string[]]`
     * cast erases. It is type-only — no generated SQL changes — and what makes
     * it TRUE rather than a wish is the CHECK below, rendered from the same
     * tuple: no other value can reach a reader.
     */
    format: text({ enum: SHOW_FORMATS as unknown as [string, ...string[]] })
      .$type<ShowFormat>()
      .notNull()
      .default('podcast'),
    /**
     * The standing description of what this show is about, in the owner's words.
     *
     * Distinct from an episode's `topic`: the brief is the series' premise and
     * is fed to every script, while the topic is what one episode covers.
     */
    brief: text().notNull(),
    // `$type` is a TypeScript annotation only — it changes no generated SQL, and
    // it is what stops the repository handing `jsonb` back as `unknown`.
    speakers: jsonb().$type<ShowSpeaker[]>().notNull().default([]),
    visibility: text({ enum: SHOW_VISIBILITIES as unknown as [string, ...string[]] })
      .$type<ShowVisibility>()
      .notNull()
      .default('private'),
    /**
     * Syra's image id for the cover art, not a URL — Syra re-hosts artwork
     * rather than hotlinking it, so an address here would be Syra's internal
     * layout copied into Alia. Nullable because cover generation is allowed to
     * fail without blocking the series: a show with no artwork is a show, a
     * request that 500s because an image model was busy is not.
     */
    coverImageAssetId: text(),
    /**
     * The number the NEXT episode will take, allocated by an atomic increment
     * rather than by counting rows. Two concurrent requests reading a count
     * would both see the same value; `UPDATE … SET n = n + 1 RETURNING` cannot,
     * and the unique index on `show_episodes` is what proves it.
     */
    nextEpisodeNumber: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The list query: one account's series, newest first. Ported from
    // `shows_user_created_at_idx`, which served the same read.
    index('show_series_user_created_at_idx').on(t.userId, t.createdAt.desc()),
    // Not merely a uniqueness rule — it is what makes "which series is this Syra
    // podcast" a single-row lookup, which is how a Syra-side event would be
    // attributed back.
    uniqueIndex('show_series_syra_podcast_id_key').on(t.syraPodcastId),
    checkOneOf('show_series_format_check', t.format, SHOW_FORMATS),
    checkOneOf('show_series_visibility_check', t.visibility, SHOW_VISIBILITIES),
  ],
);

/**
 * One EPISODE of a series.
 *
 * `segments` is `jsonb` for the reason the old `shows.segments` was: an ordered
 * list read whole while the episode is produced, whose `speaker` names a
 * speaker's `name` within the series' own cast — an internal reference a child
 * table could not make checkable either.
 */
export const showEpisodes = pgTable(
  'show_episodes',
  {
    id: generatedId(),
    /**
     * An Oxy account, denormalised from the series.
     *
     * It duplicates `show_series.user_id`, and that is deliberate: the
     * concurrency cap counts a USER's active episodes and the ownership check on
     * every episode route is a user comparison, so both would otherwise be a
     * join to answer a question about one row. The cascade below keeps the two
     * from ever describing different owners, because an episode cannot outlive
     * the series it was copied from.
     */
    userId: text().notNull(),
    seriesId: text()
      .notNull()
      .references(() => showSeries.id, { onDelete: 'cascade' }),
    /** Unique within the series — see the index below. */
    episodeNumber: integer().notNull(),
    /**
     * The episode's name, on BOTH sides.
     *
     * Set when the episode is created and never rewritten by the pipeline, which
     * is forced by Syra rather than chosen here: `title` is required on
     * `POST /:id/episodes/draft` and absent from the ingest allowlist, because a
     * ticket holder has no session and no standing to rename an episode. So the
     * script owns `description`, `summary` and `recap`, and the person owns the
     * title. The alternative — an LLM title stored here only — would leave the
     * two products disagreeing about one episode's name.
     */
    title: text().notNull(),
    /** What this episode covers. The series' `brief` says what the show is. */
    topic: text().notNull(),
    /** Source material pasted by the owner, if any. */
    notes: text(),
    status: text({ enum: SHOW_EPISODE_STATUSES as unknown as [string, ...string[]] })
      .$type<ShowEpisodeStatus>()
      .notNull()
      .default('queued'),
    progress: integer().notNull().default(0),
    segments: jsonb().$type<ShowSegment[]>().notNull().default([]),
    error: text(),
    jobId: text(),
    /** A count of AI credits, not money. */
    creditsCharged: integer(),
    /** Syra's episode id, known from the moment the draft is reserved. */
    syraEpisodeId: text(),
    /**
     * The single-use capability that lets a worker with no user session attach
     * this episode's audio to Syra.
     *
     * `encryptedText`, for the reason `bots.bot_token` is: it is a bearer
     * credential at rest and nothing looks a row up by it, so the codec's
     * write-side transform is available without costing a lookup. Cleared to
     * NULL once redeemed — a spent ticket is not a secret worth keeping, and the
     * NULL is also what says the episode has been delivered.
     *
     * Never select this into a response. The routes name their columns.
     */
    ingestTicket: encryptedText(),
    ingestTicketExpiresAt: timestamptz(),
    /**
     * A few sentences summarising what this episode said, written after it is
     * produced and fed to the NEXT episode's script prompt.
     *
     * This is what makes a series continuous rather than a folder of unrelated
     * monologues: episode N is told what N-1 covered, so it neither repeats it
     * nor pretends it never happened.
     */
    recap: text(),
    /** Measured with ffprobe from the finished file, never estimated from its size. */
    durationMs: integer(),
    sourceConversationId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The concurrency cap counts a user's in-flight episodes. Ported from
    // `shows_user_status_idx`, which served exactly this count.
    index('show_episodes_user_status_idx').on(t.userId, t.status),
    // The detail screen and the recap lookup both read one series' episodes
    // newest-numbered first, so the ordering is in the index rather than in a
    // sort.
    index('show_episodes_series_number_idx').on(t.seriesId, t.episodeNumber.desc()),
    // What makes the atomic allocation on `show_series.next_episode_number`
    // provable rather than hopeful: two racing allocations that both read the
    // same number cannot both land.
    uniqueIndex('show_episodes_series_number_key').on(t.seriesId, t.episodeNumber),
    checkOneOf('show_episodes_status_check', t.status, SHOW_EPISODE_STATUSES),
  ],
);

/**
 * One account's defaults for new series.
 *
 * `userId` is the PRIMARY KEY with NO default — `user_credits.id` is the
 * precedent and the reasoning is identical: the table is keyed by the account
 * rather than by a row identity, and a `generatedId()` here would mint a row no
 * lookup could ever find, presenting as "the user has no preferences" rather
 * than as a bad insert.
 *
 * Absent means the defaults below. Nothing creates a row until somebody changes
 * something, so a reader must treat a missing row as `private` + `podcast`
 * rather than as an error.
 */
export const showPreferences = pgTable(
  'show_preferences',
  {
    /** An Oxy account. No foreign key — Oxy owns identity. */
    userId: text().primaryKey(),
    /**
     * PRIVATE by default, and that is a deliberate asymmetry with Syra, where a
     * show created without a `visibility` is public. A machine-generated podcast
     * about whatever its owner happened to be reading is not something to
     * publish by accident; making it public is one explicit act.
     */
    defaultVisibility: text({ enum: SHOW_VISIBILITIES as unknown as [string, ...string[]] })
      .$type<ShowVisibility>()
      .notNull()
      .default('private'),
    defaultFormat: text({ enum: SHOW_FORMATS as unknown as [string, ...string[]] })
      .$type<ShowFormat>()
      .notNull()
      .default('podcast'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('show_preferences_visibility_check', t.defaultVisibility, SHOW_VISIBILITIES),
    checkOneOf('show_preferences_format_check', t.defaultFormat, SHOW_FORMATS),
  ],
);
