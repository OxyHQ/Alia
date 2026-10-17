/**
 * Closed value sets for Alia's use of Oxy Files (oxy ADR 0043).
 *
 * A LEAF module, like every file in `src/domain/`: the schema renders its CHECK
 * constraints from these tuples and the code that writes the same columns
 * imports the same tuples, so the two cannot drift apart.
 */

/**
 * The entity classes Alia registers Oxy file references under — the
 * `entityType` of `OxyServer.assets.references`. Each one is reconciled on its
 * own (`references.reconcile` takes one entity type), and each has exactly one
 * inventory query in `lib/files/oxy-file-sync.ts`.
 *
 * - `show_series` — a series' cover art (`show_series.cover_file_id`).
 * - `library_file` — a person's library upload (`library_files.oxy_file_id`).
 * - `speech_clip` — a stored spoken clip (`speech_clips.oxy_file_id`).
 * - `skill_file` — one bundled file of a skill version (`skill_files.oxy_file_id`).
 */
export const OXY_FILE_ENTITY_TYPES = [
  'show_series',
  'library_file',
  'speech_clip',
  'skill_file',
] as const;
export type OxyFileEntityType = (typeof OXY_FILE_ENTITY_TYPES)[number];

/** What a pending reference sync wants Oxy to hold: the reference, or its absence. */
export const OXY_FILE_REFERENCE_STATES = ['present', 'absent'] as const;
export type OxyFileReferenceState = (typeof OXY_FILE_REFERENCE_STATES)[number];

/** A sync row is `pending` until it is applied (and deleted) or gives up. */
export const OXY_FILE_SYNC_STATUSES = ['pending', 'dead_letter'] as const;
export type OxyFileSyncStatus = (typeof OXY_FILE_SYNC_STATUSES)[number];

/**
 * The kinds of object that still live in Alia's own bucket, and the only ones
 * the storage garbage collector may delete. Each has one "is it still
 * referenced?" query in `db/files/storageGcRepository.ts`.
 */
export const LEGACY_STORED_OBJECT_KINDS = ['library_file', 'speech_clip', 'skill_file'] as const;
export type LegacyStoredObjectKind = (typeof LEGACY_STORED_OBJECT_KINDS)[number];

/**
 * What a read from the legacy bucket was for — the label of the legacy-read
 * metric, and the key of `legacy_storage_reads`. `audio_job` is the retired
 * audio-generation feature's stored results, still served while rows name them.
 * `other` is a key no kind claims; it is counted rather than dropped, because a
 * read nobody can attribute is exactly the one that must block retiring the
 * bucket.
 */
export const LEGACY_READ_KINDS = [
  'library_file',
  'speech_clip',
  'skill_file',
  'audio_job',
  'other',
] as const;
export type LegacyReadKind = (typeof LEGACY_READ_KINDS)[number];

/** The prefix that marks a stored locator as an Oxy file rather than a legacy key. */
const OXY_LOCATOR_PREFIX = 'oxy:';

/**
 * One string naming where a stored file is, for the places that carry a single
 * value — a signed playback link, a library file's `url` before it is turned
 * into a link. An Oxy file reads `oxy:<fileId>`, followed by `|<legacy key>`
 * while the legacy copy still exists (the dual-read fallback); a legacy key
 * reads as itself. A legacy key never starts with `oxy:` — every one starts
 * with the environment name (`lib/s3.ts`).
 */
export function storedLocator(objectKey: string | null, oxyFileId: string | null): string | null {
  if (oxyFileId !== null) {
    return `${OXY_LOCATOR_PREFIX}${oxyFileId}${objectKey === null ? '' : `|${objectKey}`}`;
  }
  return objectKey;
}

/** The inverse of {@link storedLocator}. A file id never contains `|`. */
export function parseStoredLocator(locator: string): {
  objectKey: string | null;
  oxyFileId: string | null;
} {
  if (!locator.startsWith(OXY_LOCATOR_PREFIX)) return { objectKey: locator, oxyFileId: null };
  const rest = locator.slice(OXY_LOCATOR_PREFIX.length);
  const bar = rest.indexOf('|');
  if (bar === -1) return { objectKey: null, oxyFileId: rest };
  return { objectKey: rest.slice(bar + 1) || null, oxyFileId: rest.slice(0, bar) };
}
