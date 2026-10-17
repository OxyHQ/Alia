/**
 * Spoken clips are made once.
 *
 * `POST /v1/audio/speech` used to synthesize every request: a reply read aloud
 * twice, and every sentence voice mode says again ("Claro.", "¡Hola!"), was
 * synthesized and paid for again. Here a clip is found by WHAT was asked for —
 * by whom, in which speech model, voice, speed and format, for which exact text
 * — and synthesized only when no such clip is stored.
 *
 * ## The key
 *
 * {@link speechClipKey}: SHA-256 over a versioned tuple. The person is in it, so
 * a clip is never shared between people — the speed of an answer must not tell
 * one person what another had read aloud. The text is in it exactly, not
 * trimmed or folded: a different string is a different clip. The speed is
 * normalized ({@link normalizeSpeechSpeed}) and the SAME normalized value is
 * what synthesis is sent, so the key describes the request that was made.
 * Bumping {@link SPEECH_CLIP_KEY_VERSION} retires every key at once.
 *
 * ## Which model
 *
 * The clip is keyed by the model that MADE it. Before synthesizing, a request
 * is looked up under every model `synthesizeSpeech` would try, in its order
 * (`speechModelCandidates`, from the cached catalogue — no inference call), and
 * the best-ranked stored clip answers. That is what makes a fallback pay once:
 * a first model that always refuses this voice or speed would otherwise make
 * every request a miss under its key while the clip sat under the second's. A
 * model no longer among the candidates is never served.
 *
 * ## Two identical requests at once
 *
 * Joined in this process: the second waits for the first's synthesis instead
 * of starting its own, and the synthesis is cancelled only when EVERY request
 * waiting for it has gone (a closed tab cancels; one of two does not). Across
 * the API's ECS tasks there is no lock: two tasks can each pay for the same
 * clip once, and {@link indexSpeechClip} then keeps one object and the loser
 * deletes its own. Bounded at one extra synthesis per task per race, which is
 * not worth a cross-task lock held for the length of a synthesis.
 *
 * ## Where clips go
 *
 * - **A deleted or cleared conversation** takes the clips spoken from it
 *   ({@link purgeConversationSpeechClips}): rows and objects, in one
 *   transaction, so the rows come back if the objects could not go.
 * - **Unused for {@link SPEECH_CLIP_RETENTION_DAYS}**, any clip goes
 *   ({@link sweepSpeechClips}) — this is what collects voice-call sentences,
 *   which no saved message asks for.
 * - **A deleted account**: Alia has no account-erasure path today. When it
 *   gets one, the clips are `speech_clips` rows by `oxy_user_id` and objects
 *   under `<env>/tts/<oxy user id>/`, and the sweep bounds them meanwhile.
 *
 * Nothing else deletes a `tts/` object, which is why a stored row is trusted
 * to name a playable one (`db/schema/speech.ts`).
 *
 * ## Where the bytes are
 *
 * `lib/files/oxy-files.ts` decides: Alia's own bucket today, an Oxy file ALIA
 * owns once Oxy can hold private audio (a clip is a cache Alia expires, so it
 * is Alia's, not the person's). Releasing an Oxy clip is releasing Alia's
 * reference in the same transaction as the row; Oxy collects the file.
 */

import { createHash } from 'node:crypto';
import {
  deleteConversationSpeechClips,
  deleteStaleSpeechClips,
  findSpeechClips,
  indexSpeechClip,
  touchSpeechClip,
} from '../db/chat/speechClipRepository.js';
import { getDb, type ApiDatabase, type Executor } from '../db/index.js';
import { log } from './logger.js';
import { deleteS3Objects } from './s3.js';
import { recordFileReferences } from '../db/files/oxyFileRepository.js';
import type { StoredSpeechClip } from '../db/chat/speechClipRepository.js';
import { storedLocator } from '../domain/oxy-files.js';
import { newLegacyKey, storePrivateContent, type StoredContent } from './files/oxy-files.js';
import { speechModelCandidates, synthesizeSpeech } from './synthesize-speech.js';

/** Part of every key: raising it makes every stored clip unreachable, and the sweep collects them. */
export const SPEECH_CLIP_KEY_VERSION = 1;

/** A clip nobody has used for this long is deleted. Every hit restarts the clock. */
export const SPEECH_CLIP_RETENTION_DAYS = 30;

/** The only format the route makes. */
const FORMAT = 'mp3';

/** What a clip is, for its key. */
export interface SpeechClipKeyParts {
  readonly userId: string;
  readonly model: string;
  readonly voice: string;
  /** Already normalized; `undefined` is the model's own speed. */
  readonly speed: number | undefined;
  readonly format: string;
  readonly input: string;
}

/**
 * Two decimals, and 1 means "the model's own speed", sent as no speed at all —
 * so `1`, `1.0`, `1.001` and an omitted speed are one clip, and a model that
 * takes no speed is never sent one it would refuse.
 */
export function normalizeSpeechSpeed(speed: number | undefined): number | undefined {
  if (speed === undefined) return undefined;
  const rounded = Math.round(speed * 100) / 100;
  return rounded === 1 ? undefined : rounded;
}

/** The content address of one clip. JSON over an array, so no two tuples encode alike. */
export function speechClipKey(parts: SpeechClipKeyParts): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        SPEECH_CLIP_KEY_VERSION,
        parts.userId,
        parts.model,
        parts.voice,
        parts.speed ?? null,
        parts.format,
        parts.input,
      ]),
    )
    .digest('hex');
}

export interface SpeechClipRequest {
  readonly userId: string;
  readonly input: string;
  readonly voice: string;
  readonly speed?: number;
  /**
   * The conversation a saved message asking for this clip belongs to, already
   * checked to be this person's — or `null`. A clip with no conversation yet
   * is claimed by the first one that asks (`touchSpeechClip`).
   */
  readonly conversationId: string | null;
  /** The asker leaving. Cancels the synthesis only if nobody else waits for it. */
  readonly signal: AbortSignal;
}

export interface SpeechClip {
  /** Where the clip is, as a stored locator for `storedMediaUrl` — never an address. */
  readonly locator: string;
  readonly model: string;
  /** `miss` is a paid synthesis; anything else cost nothing. */
  readonly cache: 'hit' | 'miss';
  /** Answered by another request's synthesis, still running when this one asked. */
  readonly inflight: boolean;
  /** Oxy's request id, when this request's synthesis made the clip. */
  readonly requestId?: string;
}

interface MadeClip {
  readonly cacheKey: string;
  readonly locator: string;
  readonly model: string;
  readonly requestId: string;
}

interface Flight {
  readonly done: Promise<MadeClip>;
  readonly controller: AbortController;
  waiters: number;
}

/** Syntheses in progress in this process, by the key of the request's first-ranked model. */
const flights = new Map<string, Flight>();

/**
 * The clip for this request: stored, or made now and stored.
 *
 * @throws {SpeechSynthesisError} when it had to be made and could not be.
 * @throws the asker's abort reason when `signal` aborted first.
 */
export async function obtainSpeechClip(
  db: ApiDatabase,
  request: SpeechClipRequest,
): Promise<SpeechClip> {
  const speed = normalizeSpeechSpeed(request.speed);
  const models = await speechModelCandidates();
  const keyFor = (model: string) =>
    speechClipKey({
      userId: request.userId,
      model,
      voice: request.voice,
      speed,
      format: FORMAT,
      input: request.input,
    });
  const keys = models.map(keyFor);

  const stored = await findSpeechClips(db, request.userId, keys);
  const best = keys
    .map((key, rank) => ({ rank, row: stored.find((row) => row.cacheKey === key) }))
    .find((candidate) => candidate.row !== undefined);
  if (best?.row !== undefined) {
    await touchSpeechClip(db, request.userId, best.row.cacheKey, request.conversationId);
    return {
      locator: storedLocator(best.row.objectKey, best.row.oxyFileId) ?? '',
      model: models[best.rank] ?? '',
      cache: 'hit',
      inflight: false,
    };
  }

  const flightKey = keys[0];
  if (flightKey === undefined) throw new Error('No speech model to key the clip by');
  const joined = flights.has(flightKey);
  const made = await join(
    flightKey,
    (signal) => makeClip(db, { ...request, speed }, keyFor, signal),
    request.signal,
  );
  await touchSpeechClip(db, request.userId, made.cacheKey, request.conversationId);
  return {
    locator: made.locator,
    model: made.model,
    cache: joined ? 'hit' : 'miss',
    inflight: joined,
    ...(joined ? {} : { requestId: made.requestId }),
  };
}

/** Synthesize, store and index one clip. Runs once per flight, on the flight's own signal. */
async function makeClip(
  db: ApiDatabase,
  request: Omit<SpeechClipRequest, 'signal' | 'conversationId'>,
  keyFor: (model: string) => string,
  signal: AbortSignal,
): Promise<MadeClip> {
  const speech = await synthesizeSpeech({
    input: request.input,
    voice: request.voice,
    format: FORMAT,
    userId: request.userId,
    ...(request.speed === undefined ? {} : { speed: request.speed }),
    signal,
  });
  // Paid for from here on: the clip is stored even if every asker has left,
  // so the next one is a hit rather than a second payment.
  const cacheKey = keyFor(speech.model);
  const stored = await storePrivateContent({
    kind: 'speech_clip',
    owner: { kind: 'alia' },
    bytes: speech.audio,
    mime: 'audio/mpeg',
    name: 'speech.mp3',
    legacyKey: newLegacyKey(`tts/${request.userId}`, 'speech', 'speech.mp3'),
  });
  let standing: StoredSpeechClip;
  try {
    standing = await indexSpeechClip(db, { cacheKey, oxyUserId: request.userId, ...stored });
  } catch (error: unknown) {
    await discard(stored);
    throw error;
  }
  // Another task indexed the same clip first: theirs stands, ours is surplus.
  if (standing.objectKey !== stored.objectKey || standing.oxyFileId !== stored.oxyFileId) {
    await discard(stored);
  }
  return {
    cacheKey,
    locator: storedLocator(standing.objectKey, standing.oxyFileId) ?? '',
    model: speech.model,
    requestId: speech.requestId,
  };
}

/**
 * Give up a clip no row names. A legacy object is deleted now — and was marked
 * as garbage before it was written, so a failed delete is retried by the
 * collector. An Oxy file needs nothing: no reference was recorded for it, so
 * Oxy trashes it as an unused application file.
 */
async function discard(stored: StoredContent): Promise<void> {
  if (stored.objectKey === null) return;
  await deleteS3Objects([stored.objectKey]).catch(() => {
    log.speech.error('Speech object cleanup failed');
  });
}

/**
 * Release the stored copies of clips whose rows this transaction deleted:
 * legacy objects are deleted inside it (so the rows come back if they could
 * not go), Oxy files lose Alia's reference with it.
 */
async function releaseClips(tx: Executor, clips: readonly StoredSpeechClip[]): Promise<number> {
  await recordFileReferences(
    tx,
    clips.flatMap((clip) =>
      clip.oxyFileId === null
        ? []
        : [
            {
              fileId: clip.oxyFileId,
              entityType: 'speech_clip' as const,
              entityId: clip.cacheKey,
              desired: 'absent' as const,
            },
          ],
    ),
  );
  return deleteS3Objects(
    clips.flatMap((clip) => (clip.objectKey === null ? [] : [clip.objectKey])),
  );
}

/**
 * Wait for the flight under `key`, starting it if there is none.
 *
 * The flight's own controller aborts when the last waiter leaves, and the
 * flight is forgotten at that moment, so a request arriving after it starts a
 * fresh one instead of joining a cancelled one.
 */
function join(
  key: string,
  start: (signal: AbortSignal) => Promise<MadeClip>,
  signal: AbortSignal,
): Promise<MadeClip> {
  signal.throwIfAborted();
  let flight = flights.get(key);
  if (flight === undefined) {
    const controller = new AbortController();
    const done = start(controller.signal);
    const started: Flight = { done, controller, waiters: 0 };
    const forget = () => {
      if (flights.get(key) === started) flights.delete(key);
    };
    // Also observes the rejection, so a flight every waiter left is not an unhandled one.
    done.then(forget, forget);
    flights.set(key, started);
    flight = started;
  }
  const current = flight;
  current.waiters += 1;
  return new Promise<MadeClip>((resolve, reject) => {
    const leave = () => {
      current.waiters -= 1;
      if (current.waiters === 0) {
        if (flights.get(key) === current) flights.delete(key);
        current.controller.abort(signal.reason);
      }
      reject(signal.reason);
    };
    signal.addEventListener('abort', leave, { once: true });
    current.done.then(
      (made) => {
        signal.removeEventListener('abort', leave);
        resolve(made);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', leave);
        reject(error);
      },
    );
  });
}

/**
 * Delete every clip spoken from this person's conversation: the rows and their
 * objects, in one transaction, so a failed storage delete leaves the rows to
 * try again rather than objects nothing points at.
 */
export async function purgeConversationSpeechClips(
  db: ApiDatabase,
  oxyUserId: string,
  conversationId: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    const clips = await deleteConversationSpeechClips(tx, oxyUserId, conversationId);
    await releaseClips(tx, clips);
    return clips.length;
  });
}

/** How many clips one sweep removes at most; the rest wait for the next run. */
const SWEEP_BATCH = 500;
/** Retention is measured in days, so an hourly sweep is plenty. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Remove the clips nobody has used for {@link SPEECH_CLIP_RETENTION_DAYS}, rows
 * and objects in one transaction. Logs every run, the empty ones included —
 * "nothing to sweep" and "never ran" are otherwise the same table. Never
 * throws: a failed sweep is retried next interval.
 */
export async function sweepSpeechClips(db: ApiDatabase): Promise<void> {
  try {
    const result = await db.transaction(async (tx) => {
      const stale = await deleteStaleSpeechClips(tx, SPEECH_CLIP_RETENTION_DAYS, SWEEP_BATCH);
      const objects = await releaseClips(tx, stale.clips);
      return { clips: stale.clips.length, objects, truncated: stale.truncated };
    });
    log.speech.info(
      { clips: result.clips, objects: result.objects, truncated: result.truncated },
      'Speech clip sweep complete',
    );
  } catch (error: unknown) {
    log.speech.error({ err: error }, 'Speech clip sweep failed');
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sweep hourly, on the leader only — `isLeader` is consulted per tick, like
 * `startExpirySweeper`, so leadership moving mid-process moves the sweep.
 */
export function startSpeechClipSweeper(isLeader: () => boolean): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    if (!isLeader()) return;
    void sweepSpeechClips(getDb());
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopSpeechClipSweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
