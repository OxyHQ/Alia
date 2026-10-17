import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, uuidv7 } from '@oxy.so/db';
import type { OxyServer } from '@oxy.so/core/server';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  claimReconcileRun,
  claimReferenceSyncs,
  completeReferenceSync,
  countLegacyRead,
  dueGarbageCandidates,
  failReferenceSync,
  isFileEventHandled,
  claimFileEvent,
  isLegacyObjectReferenced,
  legacyReadsInWindow,
  markLegacyObjectsMaybeGarbage,
  recordFileReferences,
  ReferenceOutsideTransactionError,
  referenceInventory,
} from '../files/oxyFileRepository';
import { oxyFileReferenceSync, storageGcCandidates } from '../schema/oxy-files';
import { libraryFiles } from '../schema/library';
import { showSeries } from '../schema/shows';
import { skillFiles } from '../schema/skills';
import { speechClips } from '../schema/speech';
import {
  adoptSeriesCoverFile,
  createSeries,
  deleteSeriesForUser,
  dropSeriesCoverFile,
  updateSeriesForUser,
} from '../shows/showRepository';
import { createLibraryFile, deleteLibraryFile } from '../library/libraryFileRepository';
import { createSkill, deleteOwnedSkill, insertSkillVersion } from '../agents/skillRepository';
import {
  collectLegacyGarbageOnce,
  drainReferenceSyncOnce,
  setOxyFileSyncClientForTests,
} from '../../lib/files/oxy-file-sync';

/**
 * Alia's Oxy Files bookkeeping against a real Postgres (oxy ADR 0043): the
 * reference outbox and its claim, the storage CHECKs, the transactional
 * reference writes of every row that names a file, the legacy garbage
 * collector, the legacy-read gate and the event dedupe.
 *
 * Every id here is this file's own (`RUN`), so parallel files never see — or
 * sweep — these rows.
 */

let db: ApiDatabase;
const RUN = `oxyfiles-${uuidv7()}`;
const USER = `${RUN}-user`;

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  setOxyFileSyncClientForTests(null);
  await db
    .delete(oxyFileReferenceSync)
    .where(sql`${oxyFileReferenceSync.fileId} like ${`${RUN}%`}`);
  await db.delete(storageGcCandidates).where(sql`${storageGcCandidates.key} like ${`${RUN}%`}`);
  await closePostgres();
});

const intentsFor = (fileId: string) =>
  db
    .select({
      entityId: oxyFileReferenceSync.entityId,
      desired: oxyFileReferenceSync.desired,
      generation: oxyFileReferenceSync.generation,
    })
    .from(oxyFileReferenceSync)
    .where(eq(oxyFileReferenceSync.fileId, fileId));

async function expectCheck(promise: Promise<unknown>, constraint: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isCheckViolation(error)).toBe(true);
  expect(constraintNameOf(error)).toBe(constraint);
}

describe('the reference outbox', () => {
  it('refuses to be written outside a transaction', async () => {
    await expect(
      recordFileReferences(db, [
        { fileId: `${RUN}-f0`, entityType: 'show_series', entityId: 'e', desired: 'present' },
      ]),
    ).rejects.toBeInstanceOf(ReferenceOutsideTransactionError);
  });

  it('keeps one desired state per (file, entity), bumping the generation on every change', async () => {
    const file = `${RUN}-f1`;
    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'show_series', entityId: 's1', desired: 'present' },
      ]),
    );
    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'show_series', entityId: 's1', desired: 'absent' },
      ]),
    );
    expect(await intentsFor(file)).toEqual([{ entityId: 's1', desired: 'absent', generation: 2 }]);
  });

  it('a worker never deletes an intent rewritten while it held the claim', async () => {
    const file = `${RUN}-f2`;
    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'library_file', entityId: 'l1', desired: 'present' },
      ]),
    );
    const owner = `${RUN}-worker`;
    const claimed = (
      await claimReferenceSyncs(db, { leaseOwner: owner, limit: 1000, leaseSeconds: 60 })
    ).filter((row) => row.fileId === file);
    expect(claimed).toHaveLength(1);
    // A second claimer sees nothing while the lease is live.
    const again = await claimReferenceSyncs(db, {
      leaseOwner: `${owner}-2`,
      limit: 1000,
      leaseSeconds: 60,
    });
    expect(again.some((row) => row.fileId === file)).toBe(false);

    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'library_file', entityId: 'l1', desired: 'absent' },
      ]),
    );
    expect(await completeReferenceSync(db, claimed[0]!, owner)).toBe(false);
    expect(await intentsFor(file)).toEqual([{ entityId: 'l1', desired: 'absent', generation: 2 }]);
  });

  it('backs off a failure and dead-letters it after the last attempt', async () => {
    const file = `${RUN}-f3`;
    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'skill_file', entityId: 'k1', desired: 'present' },
      ]),
    );
    const owner = `${RUN}-failer`;
    const [row] = (
      await claimReferenceSyncs(db, { leaseOwner: owner, limit: 1000, leaseSeconds: 60 })
    ).filter((claimed) => claimed.fileId === file);
    await failReferenceSync(db, row!, owner, 'Oxy said 503', 1);
    const [stored] = await db
      .select({ status: oxyFileReferenceSync.status, lastError: oxyFileReferenceSync.lastError })
      .from(oxyFileReferenceSync)
      .where(eq(oxyFileReferenceSync.fileId, file));
    expect(stored).toEqual({ status: 'dead_letter', lastError: 'Oxy said 503' });
  });

  it('drains present and absent intents into references.add / remove, and forgets them', async () => {
    const file = `${RUN}-f4`;
    await db.transaction((tx) =>
      recordFileReferences(tx, [
        { fileId: file, entityType: 'show_series', entityId: 'a', desired: 'present' },
        { fileId: file, entityType: 'show_series', entityId: 'b', desired: 'absent' },
      ]),
    );
    const calls: { method: string; references: { entityId: string }[] }[] = [];
    const answer =
      (method: string, result: string) =>
      async (references: { fileId: string; entityType: string; entityId: string }[]) => {
        calls.push({ method, references });
        return references.map((reference) => ({ ...reference, result }));
      };
    setOxyFileSyncClientForTests(
      () =>
        ({
          assets: {
            references: { add: answer('add', 'created'), remove: answer('remove', 'removed') },
          },
        }) as unknown as OxyServer,
    );
    // Other files' rows may be due too; drain until this file's are gone.
    for (let pass = 0; pass < 20 && (await intentsFor(file)).length > 0; pass += 1) {
      await drainReferenceSyncOnce(db);
    }
    expect(await intentsFor(file)).toEqual([]);
    expect(
      calls.some(
        (call) => call.method === 'add' && call.references.some((r) => r.entityId === 'a'),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.method === 'remove' && call.references.some((r) => r.entityId === 'b'),
      ),
    ).toBe(true);
  });
});

describe('rows that name a stored file', () => {
  it('a library file names a legacy object or an Oxy file, never neither', async () => {
    await expectCheck(
      db.insert(libraryFiles).values({
        ownerOxyUserId: USER,
        name: 'x',
        url: null,
        oxyFileId: null,
        type: 'application/pdf',
        size: 1,
        category: 'documents',
      }),
      'library_files_storage_check',
    );
  });

  it('a spoken clip names a legacy object or an Oxy file, never neither', async () => {
    await expectCheck(
      db.insert(speechClips).values({ cacheKey: `${RUN}-clip`, oxyUserId: USER, objectKey: null }),
      'speech_clips_storage_check',
    );
  });

  it('a skill file is inline XOR stored, and stored may be legacy, Oxy, or both', async () => {
    const skill = await db.transaction((tx) =>
      createSkill(tx, {
        name: `${RUN}-skill`,
        displayName: 'S',
        description: 'd',
        source: 'authored',
        ownerOxyUserId: USER,
      }),
    );
    const version = await db.transaction((tx) =>
      insertSkillVersion(
        tx,
        { skillId: skill._id, body: 'b', frontmatter: {}, checksum: 'c', bytes: 1 },
        [
          {
            path: 'a.bin',
            kind: 'asset',
            mime: 'application/zip',
            bytes: 1,
            sha256: 's',
            oxyFileId: `${RUN}-sf1`,
          },
          {
            path: 'b.bin',
            kind: 'asset',
            mime: 'application/zip',
            bytes: 1,
            sha256: 's',
            s3Key: `${RUN}/skills/b`,
            oxyFileId: `${RUN}-sf2`,
          },
        ],
      ),
    );
    // The version's Oxy files were referenced with the version.
    expect(await intentsFor(`${RUN}-sf1`)).toEqual([
      expect.objectContaining({ desired: 'present' }),
    ]);
    await expectCheck(
      db.insert(skillFiles).values({
        versionId: version._id,
        path: 'c.txt',
        kind: 'reference',
        mime: 'text/plain',
        bytes: 1,
        sha256: 's',
        contentText: 'inline',
        oxyFileId: `${RUN}-sf3`,
      }),
      'skill_files_storage_check',
    );

    // Deleting the skill releases every stored file of every version.
    expect(await deleteOwnedSkill(db, skill._id, USER)).toBe(1);
    expect(await intentsFor(`${RUN}-sf1`)).toEqual([
      expect.objectContaining({ desired: 'absent' }),
    ]);
    const candidates = await db
      .select({ key: storageGcCandidates.key, kind: storageGcCandidates.kind })
      .from(storageGcCandidates)
      .where(eq(storageGcCandidates.key, `${RUN}/skills/b`));
    expect(candidates).toEqual([{ key: `${RUN}/skills/b`, kind: 'skill_file' }]);
  });

  it('a series records, replaces and releases its cover reference with its own writes', async () => {
    const id = uuidv7();
    await createSeries(db, {
      id,
      userId: USER,
      syraPodcastId: `${RUN}-pod-${id}`,
      title: 'T',
      format: 'podcast',
      brief: 'brief long enough',
      speakers: [],
      visibility: 'private',
      coverFileId: `${RUN}-cover-1`,
    });
    expect(await intentsFor(`${RUN}-cover-1`)).toEqual([
      { entityId: id, desired: 'present', generation: 1 },
    ]);

    await updateSeriesForUser(db, id, USER, {
      coverFileId: `${RUN}-cover-2`,
      coverImageAssetId: null,
    });
    expect(await intentsFor(`${RUN}-cover-1`)).toEqual([
      expect.objectContaining({ desired: 'absent' }),
    ]);
    expect(await intentsFor(`${RUN}-cover-2`)).toEqual([
      expect.objectContaining({ desired: 'present' }),
    ]);

    expect(await deleteSeriesForUser(db, id, USER)).toBe(true);
    expect(await intentsFor(`${RUN}-cover-2`)).toEqual([
      expect.objectContaining({ desired: 'absent' }),
    ]);
  });

  it('a taken-down cover clears the legacy cover too, and the migration adopts only an unmoved one', async () => {
    const id = uuidv7();
    await db.insert(showSeries).values({
      id,
      userId: USER,
      syraPodcastId: `${RUN}-pod-${id}`,
      title: 'T',
      brief: 'brief long enough',
      coverImageAssetId: 'syra-legacy',
    });
    expect(await adoptSeriesCoverFile(db, id, 'some-other-legacy', `${RUN}-cover-3`)).toBe(false);
    expect(await adoptSeriesCoverFile(db, id, 'syra-legacy', `${RUN}-cover-3`)).toBe(true);
    expect(await adoptSeriesCoverFile(db, id, 'syra-legacy', `${RUN}-cover-4`)).toBe(false);

    expect(await dropSeriesCoverFile(db, `${RUN}-cover-3`)).toEqual([id]);
    const [row] = await db
      .select({ file: showSeries.coverFileId, legacy: showSeries.coverImageAssetId })
      .from(showSeries)
      .where(eq(showSeries.id, id));
    expect(row).toEqual({ file: null, legacy: null });
    expect(await intentsFor(`${RUN}-cover-3`)).toEqual([
      expect.objectContaining({ desired: 'absent' }),
    ]);
  });

  it('deleting a library file releases what it named in the same transaction', async () => {
    const legacy = await createLibraryFile(db, {
      ownerOxyUserId: USER,
      name: 'a.pdf',
      url: `${RUN}/library/a.pdf`,
      type: 'application/pdf',
      size: 3,
      category: 'documents',
    });
    const moved = await createLibraryFile(db, {
      ownerOxyUserId: USER,
      name: 'b.pdf',
      url: null,
      oxyFileId: `${RUN}-lib-b`,
      type: 'application/pdf',
      size: 3,
      category: 'documents',
    });
    expect(await intentsFor(`${RUN}-lib-b`)).toEqual([
      expect.objectContaining({ desired: 'present' }),
    ]);

    expect(await deleteLibraryFile(db, legacy.id, USER)).toBe(1);
    expect(await deleteLibraryFile(db, moved.id, USER)).toBe(1);
    expect(await intentsFor(`${RUN}-lib-b`)).toEqual([
      expect.objectContaining({ desired: 'absent' }),
    ]);
    const due = await dueGarbageCandidates(db, 10_000);
    expect(due.some((candidate) => candidate.key === `${RUN}/library/a.pdf`)).toBe(true);
  });
});

describe('the legacy garbage collector', () => {
  it('deletes only what no row names, once the grace has passed', async () => {
    const used = `${RUN}/gc/used.mp3`;
    const orphan = `${RUN}/gc/orphan.mp3`;
    const fresh = `${RUN}/gc/fresh.mp3`;
    await db
      .insert(speechClips)
      .values({ cacheKey: `${RUN}-used`, oxyUserId: USER, objectKey: used });
    await markLegacyObjectsMaybeGarbage(
      db,
      [
        { key: used, kind: 'speech_clip' },
        { key: orphan, kind: 'speech_clip' },
      ],
      0,
    );
    await markLegacyObjectsMaybeGarbage(db, [{ key: fresh, kind: 'speech_clip' }], 3600);
    expect(await isLegacyObjectReferenced(db, 'speech_clip', used)).toBe(true);
    expect(await isLegacyObjectReferenced(db, 'speech_clip', orphan)).toBe(false);

    const deleted: string[] = [];
    // Other files' candidates may be due; this run's are asserted by key.
    await collectLegacyGarbageOnce(db, async (keys) => {
      deleted.push(...keys);
      return keys.length;
    });
    expect(deleted).toContain(orphan);
    expect(deleted).not.toContain(used);
    expect(deleted).not.toContain(fresh);
    const left = await db
      .select({ key: storageGcCandidates.key })
      .from(storageGcCandidates)
      .where(inArray(storageGcCandidates.key, [used, orphan, fresh]));
    expect(left).toEqual([{ key: fresh }]);
  });

  it('a re-upload pushes the deadline forward, never back', async () => {
    const key = `${RUN}/gc/again.mp3`;
    await markLegacyObjectsMaybeGarbage(db, [{ key, kind: 'speech_clip' }], 3600);
    await markLegacyObjectsMaybeGarbage(db, [{ key, kind: 'speech_clip' }], 0);
    const due = await dueGarbageCandidates(db, 10_000);
    expect(due.some((candidate) => candidate.key === key)).toBe(false);
  });
});

describe('the gate and the ledgers', () => {
  it('counts legacy reads per kind per day', async () => {
    const before = (await legacyReadsInWindow(db, 1)).audio_job ?? 0;
    await countLegacyRead(db, 'audio_job');
    await countLegacyRead(db, 'audio_job');
    expect((await legacyReadsInWindow(db, 1)).audio_job).toBeGreaterThanOrEqual(before + 2);
  });

  it('streams a reference inventory in keyset pages', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const id = `${RUN}-inv-${n}`;
      ids.push(id);
      await db
        .insert(speechClips)
        .values({ cacheKey: id, oxyUserId: USER, oxyFileId: `${RUN}-invf-${n}` });
    }
    const seen: string[] = [];
    for await (const item of referenceInventory(db, 'speech_clip')) {
      if (item.entityId.startsWith(`${RUN}-inv-`)) seen.push(`${item.entityId}:${item.fileId}`);
    }
    expect(seen).toEqual(ids.map((id, n) => `${id}:${RUN}-invf-${n}`));
  });

  it('a reconciliation is claimed once per interval', async () => {
    // The shared row: claim it twice in a row; the second must lose.
    await db.execute(
      sql`update oxy_file_reconcile_runs set last_started_at = null where entity_type = 'speech_clip'`,
    );
    expect(await claimReconcileRun(db, 'speech_clip', 24)).toBe(true);
    expect(await claimReconcileRun(db, 'speech_clip', 24)).toBe(false);
  });

  it('remembers an event only once', async () => {
    const event = { id: `${RUN}-evt`, type: 'file.deleted', fileId: 'f' };
    expect(await isFileEventHandled(db, event.id)).toBe(false);
    expect(await claimFileEvent(db, event)).toBe(true);
    expect(await claimFileEvent(db, event)).toBe(false);
    expect(await isFileEventHandled(db, event.id)).toBe(true);
  });
});
