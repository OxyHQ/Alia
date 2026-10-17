/**
 * Where Alia's stored bytes live: Oxy Files (oxy ADR 0043), or — for what Oxy
 * does not take, and for rows the backfill has not reached — Alia's own bucket,
 * behind this one module.
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
 * ## How each kind reaches Oxy (stage 4c)
 *
 * - Covers: Alia's public image (`uploadAppFile`), handed to Syra as a file
 *   once Syra takes one (`syraTakesCoverFiles`).
 * - Private content (`storePrivateContent`), always `visibility: 'private'`:
 *   media (image, video, audio) of at most 40 MiB is streamed
 *   (`uploadAppFile` / `uploadUserMedia`); anything else — a PDF, a document,
 *   a skill bundle's binary, a file over 40 MiB — is a resumable large upload
 *   (`uploadAppFileLarge` / `uploadUserMediaLarge`, up to 8 GiB). A person's
 *   file stored this way is readable by Alia under the consent grant Oxy
 *   writes when Alia stores it for them, until the person revokes it.
 *
 * Private content always goes to Oxy first. A write Oxy does not take — a
 * refused type, a person's file not stored private, bytes other than the ones
 * sent, Oxy unreachable — is written to the legacy bucket instead, logged and
 * counted (`alia_oxy_files_fallback_writes_total`). Taken-down bytes (451) are
 * the one refusal never routed around. Nothing outside this module knows which
 * backend a byte is in.
 *
 * ## Reads are dual during the move
 *
 * A row may name an Oxy file, a legacy key, or both while it is being copied.
 * The Oxy file is read first; the legacy key only when there is none (or Oxy
 * failed to answer), and every such read is counted (`legacy_storage_reads` and
 * `alia_legacy_storage_reads_total`) — the count that gates retiring the bucket.
 * When Oxy answers that Alia may NOT read a file (the person revoked Alia's
 * access, or the file was taken down), that answer stands: the legacy copy is
 * not read around it.
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
import {
  legacyStorageReadRecorded,
  privateContentFallbackRecorded,
} from '../observability/metrics.js';
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
 * Syra learns `imageFileId` in Syra #214 (`@syra.fm/sdk` 0.21.0), and accepts
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

// ── Private content ─────────────────────────────────────────────────────────

/** The kinds of private content: library uploads, spoken clips, skill files. */
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

/** How long a legacy upload may take to be recorded before its object counts as garbage. */
const LEGACY_UPLOAD_GRACE_SECONDS = 60 * 60;

/** The largest file Oxy's streamed service uploads take; anything bigger is a large upload. */
export const STREAMED_UPLOAD_MAX_BYTES = 40 * 1024 * 1024;

/** How long one streamed upload, or one large upload's verification, may take. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export interface StoreContentInput {
  readonly kind: PrivateContentKind;
  readonly owner: ContentOwner;
  readonly bytes: Buffer;
  readonly mime: string;
  /** The file's own name, kept as Oxy's original name. */
  readonly name: string;
  /** The legacy key to write when Oxy does not hold it — unique per upload. */
  readonly legacyKey: string;
}

/** Raised when Oxy stored a private file as something other than private. Never recorded. */
export class OxyFileVisibilityError extends Error {
  constructor(kind: PrivateContentKind, visibility: string) {
    super(`Oxy stored a private ${kind} as ${visibility}`);
    this.name = 'OxyFileVisibilityError';
  }
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
  try {
    const fileId = await storeInOxy(input);
    return { objectKey: null, oxyFileId: fileId };
  } catch (error: unknown) {
    // Taken-down bytes are refused for every owner (ADR 0043 D10); storing
    // them in the bucket instead would route around the takedown.
    if (isContentBlocked(error)) throw error;
    privateContentFallbackRecorded(input.kind, fallbackReason(error));
    log.files.warn(
      { err: error, kind: input.kind, reason: fallbackReason(error) },
      'Oxy did not take private content; storing it in the legacy bucket',
    );
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
 * Copy bytes into Oxy for an existing legacy row — the migration's write. No
 * fallback: an item Oxy does not take stays on legacy storage and is reported.
 * Answers the file id only when Oxy stored exactly these bytes, privately.
 */
export async function copyIntoOxy(input: Omit<StoreContentInput, 'legacyKey'>): Promise<string> {
  return storeInOxy(input);
}

/** Whether a type is one Oxy's streamed service uploads take (image, video, audio). */
export function isStreamedMedia(mime: string): boolean {
  const type = mime.toLowerCase();
  return type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/');
}

/** Which Oxy upload a file takes: streamed for small media, the large upload for the rest. */
export function uploadRoute(mime: string, size: number): 'streamed' | 'large' {
  return isStreamedMedia(mime) && size <= STREAMED_UPLOAD_MAX_BYTES ? 'streamed' : 'large';
}

async function storeInOxy(input: Omit<StoreContentInput, 'legacyKey'>): Promise<string> {
  const expected = sha256Hex(input.bytes);
  const file = await uploadPrivate(input, expected);
  // A deduplicated file comes back as it already was, visibility included, and
  // an Oxy without stage 4c stores a person's small upload public whatever it
  // asks: either way, recording it would publish private content.
  if (file.visibility !== 'private') throw new OxyFileVisibilityError(input.kind, file.visibility);
  // An SVG is stored sanitized, so its hash is not the one sent; every other
  // mismatch is a fault. Either way the exact bytes stay where they can be read.
  if (file.sha256 !== expected) throw new OxyFileIntegrityError(expected, file.sha256);
  return file.id;
}

interface UploadedPrivateFile {
  readonly id: string;
  readonly sha256: string;
  readonly visibility: string;
}

async function uploadPrivate(
  input: Omit<StoreContentInput, 'legacyKey'>,
  sha256: string,
): Promise<UploadedPrivateFile> {
  const assets = oxy().assets;
  const route = uploadRoute(input.mime, input.bytes.length);
  if (input.owner.kind === 'alia') {
    if (route === 'streamed') {
      const { file } = await assets.uploadAppFile(input.bytes, input.mime, {
        visibility: 'private',
        originalName: input.name,
        timeout: UPLOAD_TIMEOUT_MS,
      });
      return file;
    }
    const { file } = await assets.uploadAppFileLarge(input.bytes, {
      mime: input.mime,
      sha256,
      filename: input.name,
      visibility: 'private',
      verifyTimeoutMs: UPLOAD_TIMEOUT_MS,
    });
    return file;
  }
  if (route === 'streamed') {
    return assets.uploadUserMedia(input.owner.oxyUserId, input.bytes, input.mime, {
      visibility: 'private',
      originalName: input.name,
      timeout: UPLOAD_TIMEOUT_MS,
    });
  }
  const { file } = await assets.uploadUserMediaLarge(input.owner.oxyUserId, input.bytes, {
    mime: input.mime,
    sha256,
    filename: input.name,
    visibility: 'private',
    verifyTimeoutMs: UPLOAD_TIMEOUT_MS,
  });
  return file;
}

/** The HTTP status an Oxy SDK error carries, when it carries one. */
export function errorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as { status?: unknown; response?: { status?: unknown } };
  if (typeof record.status === 'number') return record.status;
  if (typeof record.response?.status === 'number') return record.response.status;
  return undefined;
}

/** Whether Oxy refused the bytes because they were taken down (451 `CONTENT_BLOCKED`). */
export function isContentBlocked(error: unknown): boolean {
  if (errorStatus(error) === 451) return true;
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'CONTENT_BLOCKED'
  );
}

/** A closed label for why a write fell back, for the metric and the log. */
function fallbackReason(error: unknown): string {
  if (error instanceof OxyFilesUnavailableError) return 'no_service_identity';
  if (error instanceof OxyFileVisibilityError) return 'not_private';
  if (error instanceof OxyFileIntegrityError) return 'hash_mismatch';
  const status = errorStatus(error);
  if (status !== undefined) return status >= 500 ? 'oxy_5xx' : `oxy_${status}`;
  if (error instanceof Error && error.name === 'LargeUploadFailedError')
    return 'large_upload_failed';
  return 'unreachable';
}

/** One readable stored file. */
export type StoredContentStream = S3ObjectStream;

/**
 * Open stored content for streaming: the Oxy file first, the legacy object
 * when there is no Oxy file, or when Oxy failed to answer during the move.
 * Oxy's REFUSAL — the person revoked Alia's access, the file is gone or taken
 * down — is final and answers `null`, never the legacy copy.
 */
export async function openStoredContent(
  stored: StoredContent,
  kind: LegacyReadKind,
): Promise<StoredContentStream | null> {
  if (stored.oxyFileId !== null) {
    try {
      return await openOxyFile(stored.oxyFileId);
    } catch (error: unknown) {
      if (stored.objectKey === null) throw error;
      log.files.warn(
        { err: error, kind },
        'Oxy did not serve a migrated file; reading the legacy copy',
      );
    }
  }
  if (stored.objectKey === null) return null;
  return openLegacyObject(stored.objectKey, kind);
}

/** Raised when an Oxy download link Alia was given did not serve the file. */
export class OxyDownloadError extends Error {
  constructor(readonly status: number) {
    super(`An Oxy download link answered ${status}`);
    this.name = 'OxyDownloadError';
  }
}

/**
 * Stream one Oxy file Alia may read: its own files, and a person's file Alia
 * stored for them or that they attached to Alia, until they revoke that
 * (`linkedDownloadUrls`, ADR 0043 stage 4c). `null` is Oxy's refusal; a
 * failure to answer throws.
 */
export async function openOxyFile(fileId: string): Promise<StoredContentStream | null> {
  const [link] = await oxy().assets.linkedDownloadUrls([fileId]);
  if (link === undefined) return null;
  const response = await fetch(link.url);
  if (!response.ok || response.body === null) throw new OxyDownloadError(response.status);
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
