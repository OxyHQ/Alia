/**
 * Copying what Alia already stored into Oxy Files (oxy ADR 0043 stage 4) —
 * the logic behind `src/scripts/migrate-to-oxy-files.ts`, kept here so it is
 * tested without a database or a network.
 *
 * ## The rules every kind follows
 *
 * - **Preview by default.** Without `apply` nothing is written anywhere: each
 *   item is read and hashed and reported, so the report says exactly what an
 *   apply would copy.
 * - **Resumable by construction.** The work list is "rows that name a legacy
 *   object and no Oxy file". An applied item sets the Oxy column in the same
 *   transaction as its reference, so a run stopped anywhere resumes at the next
 *   item and never copies one twice; Oxy dedupes the bytes per owner anyway.
 * - **Verified.** The bytes are hashed as they are read, Oxy's reported sha256
 *   must equal that hash before anything is recorded, and a skill file must
 *   also match the sha256 its row was written with.
 * - **Reports carry hashes, never URLs.** A URL can be a credential and is
 *   always somebody's layout; the sha256 is what proves the copy.
 * - **The legacy copy stays.** It is the dual-read fallback until the bucket is
 *   retired (`docs/oxy-files.md`), never deleted here.
 */

import type { Readable } from 'node:stream';
import type { ApiDatabase } from '../../db/index.js';
import { adoptSeriesCoverFile, listSeriesOnLegacyCover } from '../../db/shows/showRepository.js';
import {
  adoptLibraryOxyFile,
  listLibraryFilesOnLegacyStorage,
} from '../../db/library/libraryFileRepository.js';
import {
  adoptSpeechClipOxyFile,
  listSpeechClipsOnLegacyStorage,
} from '../../db/chat/speechClipRepository.js';
import {
  adoptSkillFileOxyFile,
  listSkillFilesOnLegacyStorage,
} from '../../db/agents/skillRepository.js';
import { showSeries } from '../../db/schema/shows.js';
import { and, isNotNull } from 'drizzle-orm';
import { copyIntoOxy, oxyHoldsPrivateContent, sha256Hex, storeShowCover } from './oxy-files.js';
import { readS3Object } from '../s3.js';

export const MIGRATION_KINDS = ['show-covers', 'library', 'speech', 'skills'] as const;
export type MigrationKind = (typeof MIGRATION_KINDS)[number];

/** One line of the report: what was (or would be) copied, by hash. */
export interface MigrationLine {
  readonly kind: MigrationKind;
  readonly entityId: string;
  readonly outcome: 'would_copy' | 'copied' | 'skipped' | 'failed';
  readonly sha256?: string;
  readonly bytes?: number;
  readonly fileId?: string;
  readonly reason?: string;
}

/**
 * One line of the operator's record of the cover handover: a podcast whose
 * legacy Syra cover is now Alia's Oxy file. Syra does not read it — its
 * `migrate:alia-covers` hashes its own legacy object, finds the Oxy file with
 * that sha256 and repoints only to one ALIA owns — which is why the copy must
 * upload the exact bytes Syra serves, never a re-encoding.
 */
export interface SyraCoverMappingLine {
  readonly syraPodcastId: string;
  readonly legacyImageAssetId: string;
  readonly fileId: string;
  readonly sha256: string;
}

export interface MigrationDeps {
  readonly db: ApiDatabase;
  /** The bytes of a legacy Syra cover, from Syra's public image route. */
  readonly fetchSyraImage: (imageAssetId: string) => Promise<{ bytes: Buffer; mime: string }>;
  /** Oxy's sha256 for files Alia owns — for the handoff of covers copied by an earlier run. */
  readonly oxySha256: (fileIds: string[]) => Promise<Map<string, string>>;
  readonly readLegacy?: (key: string) => Promise<Buffer | null>;
}

const PAGE = 100;

export async function* migrateKind(
  kind: MigrationKind,
  deps: MigrationDeps,
  options: { apply: boolean; limit?: number },
): AsyncGenerator<MigrationLine> {
  if (kind !== 'show-covers' && !oxyHoldsPrivateContent()) {
    // The backfill follows the switch: it is turned on once Oxy's stage 4c is
    // deployed (`oxyHoldsPrivateContent` in `oxy-files.ts`), so new writes go
    // to Oxy before old ones are copied there.
    throw new Error(
      `${kind} does not move while OXY_FILES_PRIVATE_CONTENT is off: switch it on once Oxy stage 4c is deployed`,
    );
  }
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let done = 0;
  let after = '';
  for (;;) {
    const page = await workPage(kind, deps.db, after);
    if (page.length === 0) return;
    for (const item of page) {
      if (done >= limit) return;
      after = item.cursor;
      // In preview the work list never shrinks, so the cursor is what moves;
      // in apply a copied row leaves the list, and the cursor moves the same.
      yield await migrateItem(kind, item, deps, options.apply);
      done += 1;
    }
    if (page.length < PAGE) return;
  }
}

interface WorkItem {
  readonly cursor: string;
  readonly entityId: string;
  readonly legacy: string;
  readonly owner: { kind: 'alia' } | { kind: 'person'; oxyUserId: string };
  readonly mime?: string;
  readonly name?: string;
  readonly expectedSha256?: string;
}

async function workPage(kind: MigrationKind, db: ApiDatabase, after: string): Promise<WorkItem[]> {
  switch (kind) {
    case 'show-covers':
      return (await listSeriesOnLegacyCover(db, after, PAGE)).flatMap((row) =>
        row.coverImageAssetId === null
          ? []
          : [
              {
                cursor: row.id,
                entityId: row.id,
                legacy: row.coverImageAssetId,
                owner: { kind: 'alia' } as const,
              },
            ],
      );
    case 'library':
      return (await listLibraryFilesOnLegacyStorage(db, after, PAGE)).flatMap((row) =>
        row.url === null
          ? []
          : [
              {
                cursor: row.id,
                entityId: row.id,
                legacy: row.url,
                owner: { kind: 'person', oxyUserId: row.ownerOxyUserId } as const,
                mime: row.type,
                name: row.name,
              },
            ],
      );
    case 'speech':
      return (await listSpeechClipsOnLegacyStorage(db, after, PAGE)).flatMap((row) =>
        row.objectKey === null
          ? []
          : [
              {
                cursor: row.cacheKey,
                entityId: row.cacheKey,
                legacy: row.objectKey,
                owner: { kind: 'alia' } as const,
                mime: 'audio/mpeg',
                name: 'speech.mp3',
              },
            ],
      );
    case 'skills':
      return (await listSkillFilesOnLegacyStorage(db, after, PAGE)).map((row) => ({
        cursor: row.id,
        entityId: row.id,
        legacy: row.s3Key,
        owner:
          row.ownerOxyUserId === null
            ? ({ kind: 'alia' } as const)
            : ({ kind: 'person', oxyUserId: row.ownerOxyUserId } as const),
        mime: row.mime,
        name: row.path.split('/').pop() ?? row.path,
        expectedSha256: row.sha256,
      }));
  }
}

async function migrateItem(
  kind: MigrationKind,
  item: WorkItem,
  deps: MigrationDeps,
  apply: boolean,
): Promise<MigrationLine> {
  const base = { kind, entityId: item.entityId };
  try {
    const read =
      kind === 'show-covers'
        ? await deps.fetchSyraImage(item.legacy)
        : await readLegacyBytes(deps, item.legacy, item.mime ?? 'application/octet-stream');
    if (read === null) return { ...base, outcome: 'failed', reason: 'legacy object missing' };
    const sha256 = sha256Hex(read.bytes);
    if (item.expectedSha256 !== undefined && item.expectedSha256 !== sha256) {
      return {
        ...base,
        outcome: 'failed',
        sha256,
        reason: 'legacy bytes differ from the recorded sha256',
      };
    }
    if (!apply) return { ...base, outcome: 'would_copy', sha256, bytes: read.bytes.length };

    let fileId: string;
    let adopted: boolean;
    if (kind === 'show-covers') {
      const stored = await storeShowCover(read.bytes, read.mime);
      fileId = stored.fileId;
      adopted = await adoptSeriesCoverFile(deps.db, item.entityId, item.legacy, fileId);
    } else {
      // `copyIntoOxy` refuses unless Oxy stored exactly these bytes.
      fileId = await copyIntoOxy({
        kind:
          kind === 'library' ? 'library_file' : kind === 'speech' ? 'speech_clip' : 'skill_file',
        owner: item.owner,
        bytes: read.bytes,
        mime: read.mime,
        name: item.name ?? 'file',
      });
      adopted =
        kind === 'library'
          ? await adoptLibraryOxyFile(deps.db, item.entityId, fileId)
          : kind === 'speech'
            ? await adoptSpeechClipOxyFile(deps.db, item.entityId, fileId)
            : await adoptSkillFileOxyFile(deps.db, item.entityId, fileId);
    }
    if (!adopted) {
      // Changed meanwhile (a regenerated cover, a deleted row): nothing named
      // the new file, and Oxy collects an unreferenced application file.
      return { ...base, outcome: 'skipped', sha256, fileId, reason: 'row changed during the copy' };
    }
    return { ...base, outcome: 'copied', sha256, bytes: read.bytes.length, fileId };
  } catch (error: unknown) {
    return {
      ...base,
      outcome: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readLegacyBytes(
  deps: MigrationDeps,
  key: string,
  mime: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const read = deps.readLegacy ?? defaultReadLegacy;
  const bytes = await read(key);
  return bytes === null ? null : { bytes, mime };
}

async function defaultReadLegacy(key: string): Promise<Buffer | null> {
  const object = await readS3Object(key);
  if (object === null) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of object.body as Readable) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/**
 * The Syra handoff for EVERY series whose cover moved and whose legacy Syra
 * cover is still recorded — not only those copied by this run — so the mapping
 * is complete whenever it is produced, however many runs the copy took. The
 * sha256 is Oxy's, for the file Oxy holds.
 */
export async function syraCoverMapping(deps: MigrationDeps): Promise<SyraCoverMappingLine[]> {
  const rows = await deps.db
    .select({
      syraPodcastId: showSeries.syraPodcastId,
      legacyImageAssetId: showSeries.coverImageAssetId,
      fileId: showSeries.coverFileId,
    })
    .from(showSeries)
    .where(and(isNotNull(showSeries.coverFileId), isNotNull(showSeries.coverImageAssetId)))
    .orderBy(showSeries.id);
  const hashes = await deps.oxySha256(
    rows.flatMap((row) => (row.fileId === null ? [] : [row.fileId])),
  );
  return rows.flatMap((row) => {
    if (row.fileId === null || row.legacyImageAssetId === null) return [];
    const sha256 = hashes.get(row.fileId);
    if (sha256 === undefined) return [];
    return [
      {
        syraPodcastId: row.syraPodcastId,
        legacyImageAssetId: row.legacyImageAssetId,
        fileId: row.fileId,
        sha256,
      },
    ];
  });
}
