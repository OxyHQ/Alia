/**
 * Oxy's file events (oxy ADR 0043 D9): Oxy tells Alia when a file it owns or
 * references is deleted, moved to trash, restored, taken down after a content
 * claim, or changes visibility.
 *
 * ## Mounted ABOVE `express.json()`, and that is load-bearing
 *
 * The signature covers the exact bytes Oxy sent. `index.ts` mounts this router
 * with `express.raw` before the JSON parser, so the body arrives as a Buffer;
 * if it ever arrives parsed, the handler refuses rather than verifying a
 * re-serialisation (`oxyFilesWebhookMount.test.ts`).
 *
 * ## Without a secret, only the challenge is answered
 *
 * `OXY_FILES_WEBHOOK_SECRET` is the `whsec_…` Oxy returns when the endpoint is
 * registered (console → Webhooks → File events, or `apps.setFilesWebhook`).
 * Registering it is what issues that secret, and Oxy registers the endpoint
 * only after it echoes a `webhook.challenge` — so the challenge MUST be
 * answered before any secret exists, or the endpoint can never be registered
 * (it shipped that way in #812: every registration was refused 422). The
 * challenge carries nothing to protect; `verifyFileEventSignature` returns it
 * without a signature check by contract. Every other request without a secret
 * is a 404 — never a 401.
 *
 * ## What each event does
 *
 * Only Alia's OWN references in the event are acted on (`event.references`):
 *
 * - `file.deleted`, `file.blocked`: the file can never be shown again, so what
 *   uses it lets go — a series loses its cover (the legacy Syra cover too: it
 *   is the same bytes, and showing it would route around a takedown), a library
 *   file or a spoken clip loses its row. A skill's bundled file cannot be
 *   removed from a published version, so it is logged for a person: the file
 *   route answers 404 for it from then on, because Oxy will not serve it.
 * - `file.trashed`, `file.restored`, `file.unblocked`, `file.visibility_changed`:
 *   recorded in the log. Nothing Alia uses is trashed while referenced; a
 *   person's trash is theirs to restore; a takedown that is lifted does not
 *   bring back a cover that was already cleared.
 *
 * Delivery is at least once. Every handler is idempotent, and an event is
 * remembered by id only after it was handled, so a failure answers 500 and Oxy
 * delivers it again.
 */

import { Router, type Request, type Response } from 'express';
import {
  FileEventVerificationError,
  verifyFileEventSignature,
  type FileEvent,
} from '@oxy.so/core/server';
import { getDb } from '../db/index.js';
import {
  claimFileEvent,
  isFileEventHandled,
  markLegacyObjectsMaybeGarbage,
  recordFileReferences,
} from '../db/files/oxyFileRepository.js';
import { deleteLibraryFilesByOxyFile } from '../db/library/libraryFileRepository.js';
import { deleteSpeechClipsByOxyFile } from '../db/chat/speechClipRepository.js';
import { dropSeriesCoverFile } from '../db/shows/showRepository.js';
import { log } from '../lib/logger.js';

/** Event types after which nothing may show the file again. */
const GONE = new Set(['file.deleted', 'file.blocked']);

export function oxyFilesWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = (env.OXY_FILES_WEBHOOK_SECRET ?? '').trim();
  return secret === '' ? null : secret;
}

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const secret = oxyFilesWebhookSecret();
  if (secret === null) {
    const challenge = unregisteredChallenge(req);
    return challenge === null ? res.status(404).end() : res.json({ challenge });
  }
  if (!Buffer.isBuffer(req.body)) {
    // Parsed upstream: the bytes the signature covers are gone. Refuse loudly
    // rather than verify a re-serialisation that happens to match today.
    log.files.error('Oxy file events reached the handler without their raw body');
    return res.status(500).json({ error: 'raw body unavailable' });
  }

  let event: ReturnType<typeof verifyFileEventSignature>;
  try {
    event = verifyFileEventSignature(req.body, req.headers, secret);
  } catch (error: unknown) {
    if (error instanceof FileEventVerificationError) {
      log.files.warn({ reason: error.message }, 'Refused an unverifiable Oxy file event');
      return res.status(401).json({ error: 'invalid signature' });
    }
    throw error;
  }

  if (event.type === 'webhook.challenge') {
    return res.json({ challenge: event.challenge });
  }

  try {
    // Remembered only once handled, so a redelivery after a failure is acted
    // on again; a redelivery of a handled event is answered and skipped.
    if (await isFileEventHandled(getDb(), event.id)) return res.status(204).end();
    await handleFileEvent(event);
    await claimFileEvent(getDb(), { id: event.id, type: event.type, fileId: event.file.id });
    return res.status(204).end();
  } catch (error: unknown) {
    log.files.error({ err: error, type: event.type }, 'Oxy file event could not be handled');
    return res.status(500).json({ error: 'not handled' });
  }
});

/**
 * The registration challenge, answered before Alia holds a secret; `null` for
 * anything else. `verifyFileEventSignature` returns a challenge without
 * checking its signature, and refuses every real event against a secret Oxy
 * never issued.
 */
function unregisteredChallenge(req: Request): string | null {
  if (!Buffer.isBuffer(req.body)) return null;
  try {
    const event = verifyFileEventSignature(req.body, req.headers, 'whsec_unregistered');
    return event.type === 'webhook.challenge' ? event.challenge : null;
  } catch {
    return null;
  }
}

/** Act on one verified event. Idempotent: a redelivery changes nothing more. */
export async function handleFileEvent(event: FileEvent): Promise<void> {
  const fileId = event.file.id;
  if (!GONE.has(event.type)) {
    log.files.info(
      { type: event.type, status: event.file.status, visibility: event.file.visibility },
      'Oxy file event recorded',
    );
    if (
      event.type === 'file.visibility_changed' &&
      event.file.visibility !== 'public' &&
      event.references.some((reference) => reference.entityType === 'show_series')
    ) {
      log.files.error('A show cover stopped being public; its artwork will not load');
    }
    return;
  }

  const types = new Set(event.references.map((reference) => reference.entityType));
  const db = getDb();
  if (types.has('show_series')) {
    const series = await dropSeriesCoverFile(db, fileId);
    log.files.warn({ type: event.type, series: series.length }, 'Series covers removed by Oxy');
  }
  if (types.has('library_file')) {
    const removed = await deleteLibraryFilesByOxyFile(db, fileId);
    log.files.warn({ type: event.type, removed }, 'Library files removed by Oxy');
  }
  if (types.has('speech_clip')) {
    await db.transaction(async (tx) => {
      const clips = await deleteSpeechClipsByOxyFile(tx, fileId);
      await recordFileReferences(
        tx,
        clips.map((clip) => ({
          fileId,
          entityType: 'speech_clip' as const,
          entityId: clip.cacheKey,
          desired: 'absent' as const,
        })),
      );
      await markLegacyObjectsMaybeGarbage(
        tx,
        clips.flatMap((clip) =>
          clip.objectKey === null ? [] : [{ key: clip.objectKey, kind: 'speech_clip' as const }],
        ),
        0,
      );
    });
  }
  if (types.has('skill_file')) {
    log.files.error(
      {
        type: event.type,
        files: event.references.filter((r) => r.entityType === 'skill_file').length,
      },
      'A bundled skill file was removed by Oxy and can no longer be served',
    );
  }
}

export default router;
