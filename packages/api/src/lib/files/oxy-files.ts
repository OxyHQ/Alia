/**
 * Where Alia's stored bytes live: Oxy Files (oxy ADR 0043), or — for what Oxy
 * cannot hold yet — Alia's own bucket, behind this one module.
 *
 * ## Who owns what
 *
 * | What                         | Owner                       | Visibility | Reference            |
 * |------------------------------|-----------------------------|------------|----------------------|
 * | A show's cover art           | ALIA (Alia draws it)        | public     | `show_series`/<id>   |
 * | A library upload             | the PERSON (their file)     | private    | `library_file`/<id>  |
 * | A spoken clip (cache)        | ALIA (a cache Alia expires) | private    | `speech_clip`/<key>  |
 * | A catalogue skill's file     | ALIA (no person owns it)    | private    | `skill_file`/<id>    |
 * | A person's own skill's file  | the PERSON                  | private    | `skill_file`/<id>    |
 *
 * A spoken clip is Alia's and not the person's on purpose: it is a cache Alia
 * deletes after 30 days unused and with the conversation it was spoken from.
 * An account's file is never deleted behind its owner's back (ADR 0043 D5), so
 * a clip stored as the person's could never be expired — it would pile up as
 * "not in use" in their file manager forever. As Alia's, removing the reference
 * is the expiry: Oxy trashes an unreferenced application file after 24 hours.
 *
 * Show working segments are not here at all: they were pipeline scratch that
 * nothing read, and the pipeline no longer stores them (`show-pipeline.ts`).
 *
 * ## What can move today, and what waits for Oxy stage 4c
 *
 * Covers move now: an application-owned public image is exactly what Oxy
 * stores today (they reach Syra as a file once Syra takes one —
 * `syraTakesCoverFiles`). Everything else in the table is private, much of it
 * audio or a script, and a person's private file is not something Alia can yet
 * store and read back; that is Oxy stage 4c. Every place that has to change
 * when it can is in THIS file, marked `TODO(oxy-4c)`; nothing outside this
 * module knows which backend a byte is in. See `docs/oxy-files.md` for the
 * exact list of what Oxy has to add.
 *
 * ## Reads are dual during the move
 *
 * A row may name an Oxy file, a legacy key, or both while it is being copied.
 * The Oxy file is read first; the legacy key only when there is none, and every
 * such read is counted (`legacy_storage_reads` and
 * `alia_legacy_storage_reads_total`) — the count that gates retiring the bucket.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { OxyServer } from '@oxy.so/core/server';
import type { LegacyReadKind, LegacyStoredObjectKind } from '../../domain/oxy-files.js';
import { getDb, type ApiDatabase } from '../../db/index.js';
import {
  countLegacyRead,
  markLegacyObjectsMaybeGarbage,
} from '../../db/files/oxyFileRepository.js';
import { log } from '../logger.js';
import { legacyStorageReadRecorded } from '../observability/metrics.js';
import { oxyServiceClient } from '../oxy-service-client.js';
import { readS3Object, uploadToS3Deterministic, type S3ObjectStream } from '../s3.js';

/** Raised when Alia has no Oxy service identity, so nothing can be stored in Oxy. */
export class OxyFilesUnavailableError extends Error {
  constructor() {
    super('Alia has no Oxy service identity, so it cannot store or read Oxy files');
    this.name = 'OxyFilesUnavailableError';
  }
}

/** Raised when Oxy stored bytes other than the ones Alia sent. Never expected; never ignored. */
export class OxyFileIntegrityError extends Error {
  constructor(expected: string, stored: string) {
    super(`Oxy stored sha256 ${stored} for bytes whose sha256 is ${expected}`);
    this.name = 'OxyFileIntegrityError';
  }
}

/** Injectable for tests; production uses Alia's own service identity. */
let clientOverride: (() => OxyServer | null) | null = null;

export function setOxyFilesClientForTests(factory: (() => OxyServer | null) | null): void {
  clientOverride = factory;
}

function oxy(): OxyServer {
  const client = clientOverride ? clientOverride() : oxyServiceClient();
  if (client === null) throw new OxyFilesUnavailableError();
  return client;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── Show covers: in Oxy today ───────────────────────────────────────────────

/** What a stored cover is: the Oxy file, and the hash of the bytes it holds. */
export interface StoredCover {
  readonly fileId: string;
  readonly sha256: string;
}

/**
 * Store a cover Alia drew as ALIA's own public Oxy file.
 *
 * Unreferenced until the caller records the `show_series` reference in the
 * same transaction as the row that names it (`recordFileReferences`). That is
 * deliberate rather than a gap: if the series is never written, the file is an
 * unreferenced application file, and Oxy trashes it 24 hours later and purges
 * it 30 days after that (ADR 0043 D5). Nothing here has to clean up.
 *
 * Idempotent per bytes: Oxy answers the file Alia already holds for the same
 * bytes (`deduplicated`), so a retried cover is one file, not two.
 */
export async function storeShowCover(bytes: Uint8Array, mime: string): Promise<StoredCover> {
  const expected = sha256Hex(bytes);
  const { file } = await oxy().assets.uploadAppFile(bytes, mime, {
    visibility: 'public',
    originalName: mime === 'image/png' ? 'cover.png' : 'cover',
  });
  if (file.sha256 !== expected) throw new OxyFileIntegrityError(expected, file.sha256);
  return { fileId: file.id, sha256: file.sha256 };
}

/**
 * Whether Syra takes a show's cover as an Oxy file (`imageFileId`).
 *
 * Syra learns `imageFileId` in Syra #214 (`@syra.fm/sdk` 0.20.0), and accepts
 * one only from an application it trusts to supply covers. A Syra without it
 * would drop the field and leave the show without art, so until Syra is
 * deployed with it and trusts Alia, a cover is uploaded into Syra as before
 * (`uploadPodcastImage`) and Alia holds no file for it. Switch it with
 * `SYRA_COVER_FILE_IDS=enabled`, AFTER Syra (`docs/oxy-files.md`).
 */
export function syraTakesCoverFiles(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SYRA_COVER_FILE_IDS ?? '').trim() === 'enabled';
}

/** Where a newly drawn cover went: Alia's Oxy file, or Syra's own image store. */
export type ShowCover =
  | { readonly kind: 'oxy_file'; readonly fileId: string }
  | { readonly kind: 'syra_image'; readonly imageId: string };

/** The one Syra call `storeCoverForShow` may make. */
export interface SyraCoverUploader {
  uploadPodcastImage(image: Blob, filename?: string): Promise<{ readonly id: string }>;
}

/** Store a cover Alia drew wherever Syra can take it from today. */
export async function storeCoverForShow(
  syra: SyraCoverUploader,
  bytes: Uint8Array,
  mime: string,
): Promise<ShowCover> {
  if (syraTakesCoverFiles()) {
    const stored = await storeShowCover(bytes, mime);
    return { kind: 'oxy_file', fileId: stored.fileId };
  }
  const uploaded = await syra.uploadPodcastImage(
    new Blob([new Uint8Array(bytes)], { type: mime }),
    mime === 'image/png' ? 'cover.png' : 'cover',
  );
  return { kind: 'syra_image', imageId: uploaded.id };
}

/** The podcast field that names a cover, for `createPodcast` / `updatePodcast`. */
export function syraCoverFields(cover: ShowCover | null): { image?: string; imageFileId?: string } {
  if (cover === null) return {};
  return cover.kind === 'oxy_file' ? { imageFileId: cover.fileId } : { image: cover.imageId };
}

/**
 * The series columns that name a cover. Each kind clears the other: a new
 * cover supersedes whichever one the series had.
 */
export function seriesCoverColumns(cover: ShowCover): {
  coverFileId: string | null;
  coverImageAssetId: string | null;
} {
  return cover.kind === 'oxy_file'
    ? { coverFileId: cover.fileId, coverImageAssetId: null }
    : { coverFileId: null, coverImageAssetId: cover.imageId };
}

// ── Private content: the legacy bucket until Oxy stage 4c ───────────────────

/** The kinds of private content that wait for Oxy stage 4c. */
export type PrivateContentKind = LegacyStoredObjectKind;

/** Who owns a stored file: Alia itself, or one person. */
export type ContentOwner =
  | { readonly kind: 'alia' }
  | { readonly kind: 'person'; readonly oxyUserId: string };

/** Where one stored file is. A row stores both columns; at least one is set. */
export interface StoredContent {
  readonly objectKey: string | null;
  readonly oxyFileId: string | null;
}

/**
 * Whether private content is written to Oxy Files.
 *
 * TODO(oxy-4c): OFF until Oxy can hold all of it. Stage 4b (deployed) added
 * large, any-type application uploads (`uploadAppFileLarge`), but three gaps
 * remain, each of which alone is enough (`docs/oxy-files.md`):
 *  1. private PERSON media is stage 4c: `/assets/service/user-media` stores a
 *     person's small upload PUBLIC, so a private library upload would become
 *     world-readable;
 *  2. audio (spoken clips) is stage 4c, and every upload path refuses scripts
 *     and active documents (415), which skill bundles carry;
 *  3. a service-made reference has no creator, so it never satisfies ADR
 *     0021's owner-linked read: Alia could store a person's private file and
 *     never read it back (`linkedDownloadUrls` omits it) — app read-back is
 *     stage 4c.
 * Turn it on with `OXY_FILES_PRIVATE_CONTENT=enabled` once Oxy ships 4c, after
 * migrating with `src/scripts/migrate-to-oxy-files.ts`. Until then no call
 * below this line reaches Oxy at runtime.
 */
export function oxyHoldsPrivateContent(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OXY_FILES_PRIVATE_CONTENT ?? '').trim() === 'enabled';
}

/** How long a legacy upload may take to be recorded before its object counts as garbage. */
const LEGACY_UPLOAD_GRACE_SECONDS = 60 * 60;

export interface StoreContentInput {
  readonly kind: PrivateContentKind;
  readonly owner: ContentOwner;
  readonly bytes: Buffer;
  readonly mime: string;
  /** The file's own name, kept as Oxy's original name. */
  readonly name: string;
  /** The legacy key to write when Oxy cannot hold it — unique per upload. */
  readonly legacyKey: string;
}

/**
 * Store private content, and answer where it went.
 *
 * Whatever the backend, NOTHING names the stored bytes yet: the caller records
 * the row that does in its own transaction. A legacy object is therefore marked
 * as possible garbage BEFORE it is written, with an hour's grace; if the row
 * never commits, `storage-gc.ts` deletes it after that hour. An Oxy file needs
 * no such mark — an unreferenced application file is Oxy's to collect — but a
 * PERSON's is never collected (ADR 0043 D5), which is why the reference is
 * recorded in the same transaction as the row, and why a person's file that
 * lost its row stays visible to them as "not in use" rather than vanishing.
 */
export async function storePrivateContent(input: StoreContentInput): Promise<StoredContent> {
  if (oxyHoldsPrivateContent()) {
    const fileId = await storeInOxy(input);
    return { objectKey: null, oxyFileId: fileId };
  }
  await markLegacyObjectsMaybeGarbage(
    getDb(),
    [{ key: input.legacyKey, kind: input.kind }],
    LEGACY_UPLOAD_GRACE_SECONDS,
  );
  await uploadToS3Deterministic(input.bytes, input.legacyKey, input.mime);
  return { objectKey: input.legacyKey, oxyFileId: null };
}

/**
 * Copy bytes into Oxy for an existing legacy row — the migration's write.
 * Answers the file and the sha256 Oxy reports, which the caller compares with
 * the hash of what it read before recording anything.
 */
export async function copyIntoOxy(input: Omit<StoreContentInput, 'legacyKey'>): Promise<string> {
  return storeInOxy(input);
}

async function storeInOxy(input: Omit<StoreContentInput, 'legacyKey'>): Promise<string> {
  const expected = sha256Hex(input.bytes);
  const originalName = input.name;
  // TODO(oxy-4c): both calls are written against the API stage 4c completes —
  // private person media, audio and app read-back. Files beyond 40 MiB need
  // the 4b large-upload calls (`uploadAppFileLarge` / `uploadUserMediaLarge`)
  // when this is switched on; `oxyHoldsPrivateContent()` keeps this path off.
  if (input.owner.kind === 'alia') {
    const { file } = await oxy().assets.uploadAppFile(input.bytes, input.mime, {
      visibility: 'private',
      originalName,
      timeout: 10 * 60_000,
    });
    if (file.sha256 !== expected) throw new OxyFileIntegrityError(expected, file.sha256);
    return file.id;
  }
  const file = await oxy().assets.uploadUserMedia(input.owner.oxyUserId, input.bytes, input.mime, {
    originalName,
    timeout: 10 * 60_000,
  });
  if (file.visibility !== 'private') {
    // Refuse rather than record: a person's private file that Oxy stored as
    // public is exactly the leak the switch exists to prevent.
    throw new Error(`Oxy stored a private ${input.kind} as ${file.visibility}`);
  }
  if (file.sha256 !== expected) throw new OxyFileIntegrityError(expected, file.sha256);
  return file.id;
}

/** One readable stored file. */
export type StoredContentStream = S3ObjectStream;

/**
 * Open stored content for streaming: the Oxy file first, the legacy object
 * only when there is no Oxy file (or Oxy will not serve it during the move).
 */
export async function openStoredContent(
  stored: StoredContent,
  kind: LegacyReadKind,
): Promise<StoredContentStream | null> {
  if (stored.oxyFileId !== null) {
    const fromOxy = await openOxyFile(stored.oxyFileId);
    if (fromOxy !== null || stored.objectKey === null) return fromOxy;
    log.files.warn({ kind }, 'Oxy did not serve a migrated file; reading the legacy copy');
  }
  if (stored.objectKey === null) return null;
  return openLegacyObject(stored.objectKey, kind);
}

/**
 * Stream one Oxy file Alia may read.
 *
 * TODO(oxy-4c): `linkedDownloadUrls` answers for Alia's OWN files (catalogue
 * skills, spoken clips) today, but omits a PERSON's private file Alia stored
 * for them — the owner-linked predicate needs a reference the owner made. Oxy
 * must let the application that stored an account's file read it back (4c).
 */
export async function openOxyFile(fileId: string): Promise<StoredContentStream | null> {
  const [link] = await oxy().assets.linkedDownloadUrls([fileId]);
  if (link === undefined) return null;
  const response = await fetch(link.url);
  if (!response.ok || response.body === null) {
    log.files.warn({ status: response.status }, 'An Oxy download link did not answer');
    return null;
  }
  return {
    body: Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    contentType: link.mime,
    contentLength: link.size,
  };
}

/** Read one legacy object, and count the read. */
async function openLegacyObject(
  key: string,
  kind: LegacyReadKind,
): Promise<StoredContentStream | null> {
  noteLegacyRead(kind);
  return readS3Object(key);
}

/**
 * Count one legacy read — in the process's `/metrics` at once and in Postgres
 * for the retirement gate. The durable count is best effort: a read must not
 * fail because its bookkeeping did.
 */
function noteLegacyRead(kind: LegacyReadKind, db?: ApiDatabase): void {
  legacyStorageReadRecorded(kind);
  void Promise.resolve()
    .then(() => countLegacyRead(db ?? getDb(), kind))
    .catch((err: unknown) =>
      log.files.warn({ err, kind }, 'Could not count a legacy storage read'),
    );
}

/**
 * Which kind a legacy key holds, from the folder `lib/s3.ts` wrote it under
 * (`<env>/<folder>/…`). Only the playback route needs it: it is handed a key
 * and nothing else.
 */
export function legacyKindOfKey(key: string): LegacyReadKind {
  const folder = key.split('/')[1] ?? '';
  if (folder === 'library') return 'library_file';
  if (folder === 'tts') return 'speech_clip';
  if (folder === 'skills') return 'skill_file';
  if (folder.startsWith('audio')) return 'audio_job';
  return 'other';
}

/** A fresh, unique legacy key: `<env>/<folder>/<descriptor>-<uuid>.<ext>`, as `uploadToS3` writes. */
export function newLegacyKey(folder: string, descriptor: string, filename: string): string {
  const env = process.env.NODE_ENV || 'development';
  const base = filename.split('/').pop() ?? '';
  const ext = base.includes('.') ? (base.split('.').pop() ?? '') : '';
  return `${env}/${folder}/${descriptor}-${randomUUID()}${ext === '' ? '' : `.${ext}`}`;
}
