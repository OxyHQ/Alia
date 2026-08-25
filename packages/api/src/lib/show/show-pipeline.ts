/**
 * Producing one episode of a show series, and delivering it to Syra.
 *
 * Script → audio per segment → one file → measure it → hand it to Syra.
 *
 * ## The destination is Syra, and the last step is not "upload"
 *
 * The old pipeline finished by putting an MP3 in Alia's bucket and storing the
 * key. This one redeems a single-use ingest ticket, minted while the user's
 * token was live, and Syra becomes the file's home: its visibility rules, its
 * HLS transcode, its RSS feed. Segments still reach S3 but only as working
 * storage for the join, and they are deleted as soon as the join succeeds.
 *
 * ## Every failure gives the credit back
 *
 * `reserveCredits` DEBITS on the way in. The previous version answered three of
 * its failure paths with `finalizeCredits(reservation, { totalTokens: 0 })`, and
 * `calculateCreditsFromTokens` returns `MIN_CREDITS_PER_REQUEST` for zero
 * tokens — so a show that produced nothing at all still charged its owner one
 * credit, silently, on the path where nothing worked. Every exit here either
 * charges what the episode cost or refunds the reservation, and `settled` is
 * what stops an exit doing both.
 */

import { generateText } from 'ai';
import { getDb } from '../../db/index.js';
import {
  findEpisodeById,
  findSeriesById,
  priorEpisodes,
  updateEpisode,
  type PriorEpisode,
  type ShowEpisodePatch,
  type ShowEpisodeRow,
  type ShowSeriesRow,
} from '../../db/shows/showRepository.js';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../chat-core.js';
import { synthesizeSpeech } from '../synthesize-speech.js';
import { synthesizeSoundEffect } from '../synthesize-sound-effect.js';
import { deleteS3Objects, uploadToS3 } from '../s3.js';
import {
  finalizeFixedCredits,
  refundReservation,
  reserveCredits,
  type CreditReservation,
} from '../credits-manager.js';
import { getOrCreateUserCredits } from '../user-credits-helpers.js';
import { sendNotification } from '../notification-service.js';
import { syraForTicket } from '../syra/syra.js';
import { buildScriptSystemPrompt, buildScriptUserPrompt } from './script-prompt.js';
import { cleanTitle } from './episode-title.js';
import { concatenateAudioSegments, measureAudioDurationMs } from './show-audio.js';
import { log } from '../logger.js';
import { getSafeErrorMessage } from '../errors/sanitize.js';
import { getIO } from '../../socket.js';
import type { ShowSegment, ShowSpeaker } from '../../db/schema/shows.js';

/** Max concurrent synthesis calls, to stay inside provider rate limits. */
const TTS_BATCH_SIZE = 3;

/** How many earlier episodes the script is given the FULL recap of. */
const RECAP_WINDOW = 3;

/**
 * How many earlier episodes contribute their subject to the "already covered"
 * list — the memory that stops a show repeating itself.
 *
 * Fifty, because a weekly show reaches fifty in a year and a subject it last
 * covered more than a year ago is a revisit rather than a repeat. It is a
 * ceiling, not a promise: past it the OLDEST fall out, so a show longer than
 * this can cover something it did in its first season and nothing will notice.
 * The alternative is a prompt that grows for the life of the series.
 */
const SUBJECT_LEDGER_LIMIT = 50;

/** What the model is asked to write, per episode. */
const TARGET_MINUTES = 3;

/**
 * The longest subject line stored on a row, matching what the route accepts
 * from a person. A model asked for one line occasionally writes a paragraph.
 */
const MAX_TOPIC_LENGTH = 2000;

/**
 * What one episode costs its owner.
 *
 * `durationMs` when it is known, which is the basis the product has always
 * stated: about one credit per thirty seconds of finished audio, plus two for
 * writing the script.
 *
 * When ffmpeg could not measure the file, the fall-back prices the SPEECH
 * instead, at the same rate `POST /v1/audio/speech` charges — one credit per
 * 200 characters. That is not a second opinion about the same quantity; it is
 * the other real cost driver, and a show is literally many of those calls. An
 * unmeasurable file must not be free, and it must not be billed from a number
 * nobody computed.
 *
 * Exported because it is the arithmetic worth testing directly. The bug it
 * replaces was invisible precisely because it lived inline in a call
 * expression.
 */
export function showCreditCost(input: {
  readonly durationMs: number | null;
  readonly spokenCharacters: number;
}): number {
  const SCRIPT_CREDITS = 2;

  if (input.durationMs !== null && input.durationMs > 0) {
    return Math.max(1, Math.ceil(input.durationMs / 30_000)) + SCRIPT_CREDITS;
  }

  return Math.max(1, Math.ceil(input.spokenCharacters / 200)) + SCRIPT_CREDITS;
}

/** What the model returns, having chosen the subject and named the result. */
interface ShowScript {
  /**
   * The subject the model settled on, or `null` when the row already had one
   * and the model's restatement of it was therefore never read.
   */
  topic: string | null;
  /** Read off the finished script. `null` when nothing usable came back. */
  title: string | null;
  description: string;
  summary: string;
  recap: string;
  segments: Array<{
    type: 'dialogue' | 'sfx' | 'transition';
    speaker: string;
    text: string;
    sfxPrompt?: string;
  }>;
}

interface ProgressUpdate {
  readonly status: string;
  readonly progress: number;
  readonly currentStep: string;
  readonly segmentIndex?: number;
  readonly totalSegments?: number;
}

/**
 * Tell the owner's own room where the episode has got to.
 *
 * Carries `seriesId` beside `episodeId` because the app renders episodes inside
 * a series and a bare episode id would send it looking for which list to update.
 *
 * And the TITLE, which is not merely progress: the route reserved the episode
 * under `Episode {n}` and the script renames it minutes before the run ends, so
 * without this the screen shows a placeholder for the whole recording while the
 * row already holds the real name. `episode` is rebound by every patch, so this
 * reads whatever the last write left — which is the name from the moment there
 * is one.
 */
function emitProgress(episode: ShowEpisodeRow, update: ProgressUpdate): void {
  const io = getIO();
  if (io) {
    io.to(`user:${episode.userId}`).emit('show:progress', {
      episodeId: episode.id,
      seriesId: episode.seriesId,
      title: episode.title,
      ...update,
    });
  }
}

/**
 * Produce one episode, from a queued row to a published Syra episode.
 */
export async function runShowPipeline(episodeId: string): Promise<void> {
  /**
   * `let`, and rebound by every patch.
   *
   * A row is a plain value, so the accumulation the old Mongoose document did
   * implicitly has to be explicit: `applyUpdate` writes the patch and rebinds
   * `episode` to what the database returned. Reads further down depend on it.
   */
  const loaded = await findEpisodeById(getDb(), episodeId);
  if (!loaded) throw new Error(`Show episode ${episodeId} not found`);
  // Explicitly typed non-null: `applyUpdate` reassigns it from inside a closure,
  // which discards the narrowing the check above would otherwise carry.
  let episode: ShowEpisodeRow = loaded;

  const series = await findSeriesById(getDb(), episode.seriesId);
  if (!series) throw new Error(`Show series ${episode.seriesId} not found`);

  const applyUpdate = async (patch: ShowEpisodePatch): Promise<void> => {
    const updated = await updateEpisode(getDb(), episodeId, patch);
    // A null means the row was deleted mid-run; the local copy stays as it was
    // so the remaining steps still have something to read.
    if (updated) episode = updated;
  };

  /**
   * Out here so every exit can see it, and `settled` so no exit can both charge
   * and refund. A reservation DEBITS immediately, so a path that does neither
   * silently keeps the owner's credit.
   */
  let reservation: CreditReservation | null = null;
  let settled = false;

  /** Keys this run wrote, deleted by key rather than by a computed prefix. */
  const segmentKeys: string[] = [];

  try {
    await getOrCreateUserCredits(episode.userId);
    reservation = await reserveCredits(episode.userId);
    if (!reservation) {
      // Nothing was reserved, so there is nothing to give back.
      settled = true;
      await applyUpdate({ status: 'failed', error: 'Insufficient credits' });
      emitProgress(episode, { status: 'failed', progress: 0, currentStep: 'Out of credits' });
      return;
    }

    // ── 1. Script ────────────────────────────────────────────────────────────
    await applyUpdate({ status: 'generating_script', progress: 5 });
    emitProgress(episode, {
      status: 'generating_script',
      progress: 5,
      currentStep: 'Writing the script...',
    });

    const previously = await priorEpisodes(
      getDb(),
      series.id,
      episode.episodeNumber,
      SUBJECT_LEDGER_LIMIT,
    );
    const script = await generateScript(series, episode, previously);
    if (!script) {
      settled = true;
      await refundReservation(reservation);
      await applyUpdate({ status: 'failed', error: 'Failed to generate the episode script' });
      emitProgress(episode, { status: 'failed', progress: 0, currentStep: 'Failed' });
      return;
    }

    /**
     * The subject and the name, written NOW rather than at the end of the run.
     *
     * The subject first: this row's `topic` is what the NEXT episode is told not
     * to cover again, and the rest of this run is minutes of synthesis. Writing
     * it here rather than after the audio is what stops an episode queued during
     * those minutes choosing the same subject. It does not close the window
     * altogether — three episodes whose scripts are being written at the same
     * moment still see the same list — but it shrinks it from the whole run to
     * one model call.
     *
     * `episode.topic` wins when it exists: an owner who said what this one
     * covers said it, and the model's restatement is not an improvement on their
     * own words.
     *
     * The name second, and it is the whole point of asking the model for one:
     * the placeholder the route reserved the Syra draft with is `Episode {n}`,
     * written before a word of the episode existed. `cleanTitle` answers `null`
     * for a reply that is an explanation rather than a title, and then the
     * placeholder stands — a plain name is a name, and refusing to publish over
     * one would be absurd.
     */
    const subject = episode.topic ?? script.topic;
    const title = script.title ?? episode.title;

    // ── 2. Audio ─────────────────────────────────────────────────────────────
    const segments: ShowSegment[] = script.segments.map((segment, index) => ({
      index,
      speaker: segment.speaker,
      text: segment.text,
      type: segment.type,
      ...(segment.sfxPrompt === undefined ? {} : { sfxPrompt: segment.sfxPrompt }),
    }));

    await applyUpdate({ status: 'generating_audio', segments, progress: 15, topic: subject, title });
    emitProgress(episode, {
      status: 'generating_audio',
      progress: 15,
      currentStep: 'Recording...',
    });

    const buffers = await renderSegments(episode, series.speakers, segments, segmentKeys, (done) => {
      const progress = 15 + Math.round((done / segments.length) * 60);
      void applyUpdate({ segments, progress });
      emitProgress(episode, {
        status: 'generating_audio',
        progress,
        currentStep: 'Recording...',
        segmentIndex: done,
        totalSegments: segments.length,
      });
    });

    if (buffers.length === 0) {
      settled = true;
      await refundReservation(reservation);
      await applyUpdate({ status: 'failed', error: 'No audio could be generated for this episode' });
      emitProgress(episode, { status: 'failed', progress: 0, currentStep: 'Failed' });
      return;
    }

    // ── 3. One file ──────────────────────────────────────────────────────────
    await applyUpdate({ status: 'concatenating', segments, progress: 80 });
    emitProgress(episode, { status: 'concatenating', progress: 80, currentStep: 'Assembling...' });

    const audio = await concatenateAudioSegments(buffers);
    // MEASURED, never inferred from the byte length. Syra writes the duration it
    // is handed and its transcode never revisits it, so a guess is what every
    // listener sees in the episode list and the feed, permanently.
    const durationMs = await measureAudioDurationMs(audio);

    // ── 4. Syra ──────────────────────────────────────────────────────────────
    await applyUpdate({ status: 'publishing', progress: 90 });
    emitProgress(episode, { status: 'publishing', progress: 90, currentStep: 'Publishing...' });

    /**
     * BOTH halves of the capability, checked before anything is sent.
     *
     * The route reserves the Syra episode and mints the ticket before it
     * inserts the row, so on a first run neither is null. A re-run of an
     * already-published episode finds a null ticket — the pipeline clears it
     * once spent — and must not produce a second recording nobody can attach.
     *
     * `syraEpisodeId` is checked rather than defaulted. `?? ''` would post to
     * `/episodes//ingest`, which is a 404 that reads as "Syra refused" instead
     * of as "this row is not what it claims to be".
     */
    const ticket = episode.ingestTicket;
    const syraEpisodeId = episode.syraEpisodeId;
    if (ticket === null || syraEpisodeId === null || syraEpisodeId === '') {
      settled = true;
      await refundReservation(reservation);
      await applyUpdate({
        status: 'failed',
        error:
          ticket === null
            ? 'This episode has already been published'
            : 'This episode has no Syra episode to publish to',
      });
      emitProgress(episode, { status: 'failed', progress: 0, currentStep: 'Failed' });
      return;
    }

    await syraForTicket().ingestEpisode(
      { episodeId: syraEpisodeId, ingestTicket: ticket },
      // `Blob` is global on Node 20 and is what the SDK's multipart body wants.
      new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }),
      {
        // SECONDS. Syra writes this straight into `<itunes:duration>`, so
        // milliseconds here would publish every episode as roughly fifty hours.
        ...(durationMs === null ? {} : { duration: Math.round(durationMs / 1000) }),
        episodeNumber: episode.episodeNumber,
        description: script.description,
        summary: script.summary,
      },
      `${series.title} — episode ${episode.episodeNumber}.mp3`,
    );

    // ── 5. Settle ────────────────────────────────────────────────────────────
    const spokenCharacters = segments
      .filter((segment) => segment.type === 'dialogue')
      .reduce((total, segment) => total + segment.text.length, 0);
    const credits = showCreditCost({ durationMs, spokenCharacters });

    // Before the charge, not after: a throw between the two would otherwise
    // refund a reservation that had already paid.
    settled = true;
    /**
     * The row records what the LEDGER settled.
     *
     * The pipeline this replaces stored its intended figure while the ledger
     * moved a laundered one, so a ten-minute show intended 22 credits, charged
     * 2, and stored 22 — and the two disagreed for as long as that code
     * existed, because nothing compared them.
     *
     * **The two numbers are equal TODAY**, and that is worth saying rather than
     * implying otherwise: `finalizeFixedCredits` floors at
     * `MIN_CREDITS_PER_REQUEST` and rounds up, and `showCreditCost` always
     * returns an integer of at least 3, so neither adjustment ever fires.
     * Measured — a mutation storing `credits` here instead SURVIVED the suite.
     * So this is not defending against a rounding difference that exists; it is
     * making the row true by CONSTRUCTION rather than by a coincidence of the
     * current pricing function, which is what stops the two drifting apart
     * again the next time that function changes.
     */
    const { creditsCharged } = await finalizeFixedCredits(reservation, credits, 'show');

    await applyUpdate({
      status: 'completed',
      progress: 100,
      segments,
      recap: script.recap,
      durationMs,
      creditsCharged,
      // The capability is spent. Storing it further would keep a live-looking
      // secret that Syra has already refused to honour a second time.
      ingestTicket: null,
    });

    emitProgress(episode, { status: 'completed', progress: 100, currentStep: 'Ready' });

    await sendNotification({
      userId: episode.userId,
      type: 'agent_task_complete',
      title: 'Episode Ready',
      body: `"${episode.title}" is ready to listen on ${series.title}.`,
      data: { seriesId: series.id, episodeId: episode.id, syraEpisodeId: episode.syraEpisodeId },
    }).catch((err: unknown) => {
      log.general.warn({ err }, 'Failed to send episode completion notification');
    });
  } catch (error: unknown) {
    log.general.error({ err: error, episodeId }, 'Show pipeline failed');
    if (reservation && !settled) {
      await refundReservation(reservation).catch((err: unknown) =>
        log.general.error({ err, episodeId }, 'refundReservation failed after a show pipeline error'),
      );
    }
    await applyUpdate({
      status: 'failed',
      error: getSafeErrorMessage(error, 'Episode generation failed'),
    });
    emitProgress(episode, { status: 'failed', progress: 0, currentStep: 'Failed' });
  } finally {
    /**
     * The segments were working storage for the join and nothing reads them
     * afterwards — not the app, not Syra, not a later re-run, which regenerates
     * from the script. Leaving them was how a three-minute show cost a
     * permanent thirty objects in a private bucket.
     *
     * By KEY, so nothing here computes a prefix out of `NODE_ENV` and a user id.
     * Best-effort: a failure to tidy up must not turn a published episode into a
     * failed one.
     */
    if (segmentKeys.length > 0) {
      await deleteS3Objects(segmentKeys).catch((err: unknown) =>
        log.general.warn({ err, episodeId }, 'Could not delete show working segments'),
      );
    }
  }
}

/**
 * Synthesise every segment, in bounded batches, in playback order.
 *
 * Dialogue is rendered before sound effects, deliberately: an SFX provider
 * timing out used to poison the key pool before the speech — which is the part a
 * listener cannot do without — had finished.
 *
 * A segment that fails is SKIPPED rather than fatal. One missing transition
 * whoosh is a slightly abrupt show; refusing to publish over it is no show — but
 * it is MARKED as it is skipped, so the episode carries what it could not make
 * instead of looking complete.
 */
async function renderSegments(
  episode: ShowEpisodeRow,
  cast: readonly ShowSpeaker[],
  segments: ShowSegment[],
  segmentKeys: string[],
  onProgress: (completed: number) => void,
): Promise<Buffer[]> {
  const rendered = new Map<number, Buffer>();
  const dialogue = segments.filter((segment) => segment.type === 'dialogue');
  const effects = segments.filter((segment) => segment.type !== 'dialogue');
  const ordered = [...dialogue, ...effects];
  let completed = 0;

  for (let start = 0; start < ordered.length; start += TTS_BATCH_SIZE) {
    const batch = ordered.slice(start, start + TTS_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (segment) =>
        segment.type === 'dialogue'
          ? renderSpeech(segment.text, cast, segment.speaker)
          : renderSoundEffect(segment.sfxPrompt ?? 'short transition sound, 2 seconds'),
      ),
    );

    for (const [offset, result] of results.entries()) {
      const segment = batch[offset];
      if (segment === undefined) continue;

      if (result.status === 'fulfilled' && result.value !== null) {
        rendered.set(segment.index, result.value.buffer);
        const key = await uploadToS3(
          result.value.buffer,
          `segment.${result.value.format}`,
          // A prefix of its OWN, not a folder inside `shows/`. The one-shot purge
          // deletes everything under `{env}/shows/`, and sharing that prefix
          // would make it unable to tell a dead recording from an episode being
          // assembled while it runs.
          `show-segments/${episode.userId}/${episode.id}`,
          `segment-${segment.index}`,
        );
        segmentKeys.push(key);
        segment.audioUrl = key;
      } else {
        /**
         * On the SEGMENT, not just in the log. Skipping is the right call and
         * saying nothing about it is not: an episode that quietly loses every
         * sound cue it asked for reads as a complete episode to everybody who
         * did not have the container's logs open.
         */
        segment.renderFailed = true;
        log.general.warn(
          {
            episodeId: episode.id,
            segmentIndex: segment.index,
            segmentType: segment.type,
            reason: result.status === 'rejected' ? result.reason : 'no audio returned',
          },
          'Show segment failed, skipping it',
        );
      }
    }

    completed += batch.length;
    onProgress(completed);
  }

  // Back into playback order. `rendered` is keyed by the segment's own index, so
  // this is the script's order rather than the order things happened to finish
  // in — and the sort the old version did on a parallel array could not survive
  // a skipped segment.
  return segments
    .map((segment) => rendered.get(segment.index))
    .filter((buffer): buffer is Buffer => buffer !== undefined);
}

/**
 * Ask a model for this episode's script, trying each provider once.
 */
async function generateScript(
  series: ShowSeriesRow,
  episode: ShowEpisodeRow,
  previously: readonly PriorEpisode[],
): Promise<ShowScript | null> {
  const MAX_ATTEMPTS = 3;
  const skipProviders = new Set<string>();

  const system = buildScriptSystemPrompt(series.format, series.speakers);
  const user = buildScriptUserPrompt({
    brief: series.brief,
    seriesTitle: series.title,
    topic: episode.topic,
    episodeNumber: episode.episodeNumber,
    notes: episode.notes ?? undefined,
    previously,
    recapWindow: RECAP_WINDOW,
    targetDurationMinutes: TARGET_MINUTES,
  });

  const castNames = new Set(series.speakers.map((speaker) => speaker.name));
  // A reply with no usable subject is only a failure when the row has none
  // either — otherwise the owner's own words are the subject and the model was
  // never being asked to choose.
  const needsTopic = episode.topic === null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const resolved = await resolveModel(getDefaultAliaModel(), skipProviders);
    if (!resolved) break;

    try {
      const result = await generateText({
        model: getAIModel(resolved, 'media'),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.8,
        maxRetries: 0,
      });

      const parsed = parseScript(result.text ?? '', castNames, needsTopic);
      if (parsed) return parsed;

      // The model's own answer; only its size distinguishes an empty reply from
      // a long one that never contained usable JSON.
      log.general.warn(
        { replyLength: (result.text ?? '').length, provider: resolved.provider },
        'Show script response was not usable',
      );
      skipProviders.add(resolved.provider);
    } catch (err: unknown) {
      log.general.error({ err, provider: resolved.provider, attempt }, 'Script generation failed');
      skipProviders.add(resolved.provider);
    }
  }

  return null;
}

/**
 * Read a script out of a model's reply, or answer `null`.
 *
 * Three rejections beyond "is it JSON", and the first two were failures the old
 * version shipped as degraded shows rather than as retries:
 *
 *  - fewer than three segments is not an episode;
 *  - a dialogue segment naming somebody who is not in the cast has no voice to
 *    be spoken in, so it would be dropped silently later. Rejecting the whole
 *    reply here retries with another provider instead, which is what a caller
 *    would want and what the old code could not do because it discovered the
 *    problem three steps downstream;
 *  - no usable `topic`, when the row has none either. That combination is an
 *    episode nothing can say the subject of: the row's `topic` is what the NEXT
 *    episode is told not to repeat, so accepting the script would publish this
 *    one and then let the show cover it again. `title` gets no such rejection —
 *    it has a placeholder to fall back on, and refusing a whole script over a
 *    name would be absurd.
 *
 * A dialogue line is stored and forwarded EXACTLY as the model wrote it, and
 * that is deliberate. `[laughs]` is a tag a tag-capable voice performs, so
 * taking it out here would rob the one model that could have voiced it;
 * `synthesize-speech.ts` decides per attempt, because only that loop knows
 * which model in the failover chain actually answered.
 */
function parseScript(
  reply: string,
  castNames: ReadonlySet<string>,
  needsTopic: boolean,
): ShowScript | null {
  const json = reply.match(/\{[\s\S]*\}/);
  if (!json) return null;

  let parsed: Partial<ShowScript>;
  try {
    parsed = JSON.parse(json[0]) as Partial<ShowScript>;
  } catch {
    return null;
  }

  const segments = parsed.segments;
  if (!Array.isArray(segments) || segments.length < 3) return null;

  const dialogue = segments.filter((segment) => segment.type === 'dialogue');
  if (dialogue.length === 0) return null;
  if (dialogue.some((segment) => !castNames.has(segment.speaker))) return null;

  // One line, so a model that answered with a paragraph contributes a marker
  // rather than a wall — and bounded, because this is what fifty later prompts
  // will each carry a slice of.
  const raw = typeof parsed.topic === 'string' ? parsed.topic.trim() : '';
  const firstLine = (raw.split('\n')[0] ?? '').trim();
  const topic = firstLine === '' ? null : firstLine.slice(0, MAX_TOPIC_LENGTH);
  if (needsTopic && topic === null) return null;

  return {
    topic,
    title: cleanTitle(typeof parsed.title === 'string' ? parsed.title : ''),
    description: typeof parsed.description === 'string' ? parsed.description : '',
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    recap: typeof parsed.recap === 'string' ? parsed.recap : '',
    segments,
  };
}

interface RenderedAudio {
  buffer: Buffer;
  format: string;
}

/**
 * Speak one line, in the voice the SERIES assigned to that speaker.
 */
async function renderSpeech(
  text: string,
  cast: readonly ShowSpeaker[],
  speakerName: string,
): Promise<RenderedAudio | null> {
  const speaker = cast.find((member) => member.name === speakerName);
  if (!speaker) {
    // The script parser already refuses a reply naming somebody outside the
    // cast, so reaching here means the cast changed under a queued episode.
    log.general.warn({ speakerName }, 'Speaker is not in this series\' cast');
    return null;
  }

  const synthesized = await synthesizeSpeech({
    input: text,
    voice: speaker.voiceId,
    format: 'mp3',
  });
  return synthesized ? { buffer: synthesized.audio, format: synthesized.format } : null;
}

/**
 * Generate one sound effect, in whichever provider in the SFX tier can.
 *
 * This function used to name `digitalocean` and one fal model INLINE, with no
 * tier and no failover, and that single route holds no credential in production
 * — so every sound cue in every episode was lost, permanently, while the
 * episode published and reported success. `synthesizeSoundEffect` is the same
 * shape `renderSpeech` gets from `synthesizeSpeech`: one loop that owns the
 * chain, and no provider named here.
 */
async function renderSoundEffect(prompt: string): Promise<RenderedAudio | null> {
  const effect = await synthesizeSoundEffect({ prompt });
  return effect ? { buffer: effect.audio, format: effect.format } : null;
}
