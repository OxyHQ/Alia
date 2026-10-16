/**
 * Alia's bookkeeping for Oxy Files (oxy ADR 0043), on Postgres: the reference
 * outbox, the file-event dedupe, the reconciliation ledger, the legacy-read
 * counter and the legacy-object garbage candidates. `db/schema/oxy-files.ts`
 * says what each table is for; this module is the only writer of all five.
 *
 * Every instant compared or stored here is Postgres's `now()`, never a
 * JavaScript `Date`: several ECS tasks share these tables, and two whose clocks
 * disagreed would both believe a lease had lapsed.
 */

import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  LegacyReadKind,
  LegacyStoredObjectKind,
  OxyFileEntityType,
  OxyFileReferenceState,
} from '../../domain/oxy-files.js';
import type { ApiDatabase, Executor } from '../index';
import { libraryFiles } from '../schema/library';
import {
  legacyStorageReads,
  oxyFileEvents,
  oxyFileReconcileRuns,
  oxyFileReferenceSync,
  storageGcCandidates,
} from '../schema/oxy-files';
import { showSeries } from '../schema/shows';
import { skillFiles } from '../schema/skills';
import { speechClips } from '../schema/speech';

// ── The reference outbox ────────────────────────────────────────────────────

/** Raised when a reference intent is written outside a transaction. Never expected at runtime. */
export class ReferenceOutsideTransactionError extends Error {
  constructor() {
    super(
      'Refusing to record an Oxy file reference outside a transaction: the row that uses ' +
        'the file and the reference intent must commit together, or Oxy is told about a use ' +
        'that never happened (or never told about one that did).',
    );
    this.name = 'ReferenceOutsideTransactionError';
  }
}

/**
 * The executor, narrowed to one that is IN a transaction — the same structural
 * test as the moderation outbox: drizzle's transaction handle has `rollback`
 * and the root connection does not.
 */
function requireTransaction(executor: Executor): Executor {
  const rollback: unknown = (executor as { rollback?: unknown }).rollback;
  if (typeof rollback !== 'function') throw new ReferenceOutsideTransactionError();
  return executor;
}

export interface FileReferenceIntent {
  readonly fileId: string;
  readonly entityType: OxyFileEntityType;
  readonly entityId: string;
  readonly desired: OxyFileReferenceState;
}

/**
 * Record what Oxy should hold for these (file, entity) pairs, with the
 * CALLER's transaction. A later intent for the same pair replaces an earlier
 * one still pending — and bumps `generation`, so a worker that applied the old
 * one does not delete the new one — and revives a dead letter.
 */
export async function recordFileReferences(
  executor: Executor,
  intents: readonly FileReferenceIntent[],
): Promise<void> {
  if (intents.length === 0) return;
  const tx = requireTransaction(executor);
  await tx
    .insert(oxyFileReferenceSync)
    .values(intents.map((intent) => ({ ...intent })))
    .onConflictDoUpdate({
      target: [
        oxyFileReferenceSync.fileId,
        oxyFileReferenceSync.entityType,
        oxyFileReferenceSync.entityId,
      ],
      set: {
        desired: sql`excluded.desired`,
        status: 'pending',
        generation: sql`${oxyFileReferenceSync.generation} + 1`,
        attempts: 0,
        availableAt: sql`now()`,
        leaseOwner: null,
        leaseUntil: null,
        lastError: null,
        updatedAt: sql`now()`,
      },
    });
}

export interface ClaimedReferenceSync extends FileReferenceIntent {
  readonly generation: number;
  readonly attempts: number;
}

/**
 * Claim up to `limit` due rows, oldest first, under a lease. `FOR UPDATE SKIP
 * LOCKED` is what lets several tasks drain the table at once without taking
 * the same row; a dead task's lease simply lapses and its rows become due.
 */
export async function claimReferenceSyncs(
  db: ApiDatabase,
  options: { leaseOwner: string; limit: number; leaseSeconds: number },
): Promise<ClaimedReferenceSync[]> {
  const due = and(
    eq(oxyFileReferenceSync.status, 'pending'),
    lte(oxyFileReferenceSync.availableAt, sql`now()`),
    or(isNull(oxyFileReferenceSync.leaseUntil), lte(oxyFileReferenceSync.leaseUntil, sql`now()`)),
  );
  const picked = sql`(
    select ${oxyFileReferenceSync.fileId}, ${oxyFileReferenceSync.entityType}, ${oxyFileReferenceSync.entityId}
    from ${oxyFileReferenceSync}
    where ${due}
    order by ${oxyFileReferenceSync.availableAt} asc
    limit ${options.limit}
    for update skip locked
  )`;
  const rows = await db
    .update(oxyFileReferenceSync)
    .set({
      leaseOwner: options.leaseOwner,
      leaseUntil: sql`now() + make_interval(secs => ${options.leaseSeconds}::double precision)`,
      attempts: sql`${oxyFileReferenceSync.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      sql`(${oxyFileReferenceSync.fileId}, ${oxyFileReferenceSync.entityType}, ${oxyFileReferenceSync.entityId}) in ${picked}`,
    )
    .returning({
      fileId: oxyFileReferenceSync.fileId,
      entityType: oxyFileReferenceSync.entityType,
      entityId: oxyFileReferenceSync.entityId,
      desired: oxyFileReferenceSync.desired,
      generation: oxyFileReferenceSync.generation,
      attempts: oxyFileReferenceSync.attempts,
    });
  return rows;
}

function sameClaim(row: ClaimedReferenceSync, leaseOwner: string) {
  return and(
    eq(oxyFileReferenceSync.fileId, row.fileId),
    eq(oxyFileReferenceSync.entityType, row.entityType),
    eq(oxyFileReferenceSync.entityId, row.entityId),
    eq(oxyFileReferenceSync.generation, row.generation),
    eq(oxyFileReferenceSync.leaseOwner, leaseOwner),
  );
}

/**
 * The intent was applied: forget it — unless a newer one was written while
 * this worker held the claim, which stays for the next pass.
 */
export async function completeReferenceSync(
  db: ApiDatabase,
  row: ClaimedReferenceSync,
  leaseOwner: string,
): Promise<boolean> {
  const result = await db.delete(oxyFileReferenceSync).where(sameClaim(row, leaseOwner));
  return result.count > 0;
}

/**
 * The intent could not be applied: back off (1 minute doubling, capped at six
 * hours) or, after `maxAttempts`, dead-letter it for a person to read.
 */
export async function failReferenceSync(
  db: ApiDatabase,
  row: ClaimedReferenceSync,
  leaseOwner: string,
  error: string,
  maxAttempts: number,
): Promise<void> {
  const delaySeconds = Math.min(60 * 2 ** Math.max(0, row.attempts - 1), 6 * 60 * 60);
  await db
    .update(oxyFileReferenceSync)
    .set({
      status: row.attempts >= maxAttempts ? 'dead_letter' : 'pending',
      availableAt: sql`now() + make_interval(secs => ${delaySeconds}::double precision)`,
      leaseOwner: null,
      leaseUntil: null,
      lastError: error.slice(0, 1000),
      updatedAt: sql`now()`,
    })
    .where(sameClaim(row, leaseOwner));
}

/** Counts for an operator: what is still owed, and what gave up. */
export async function referenceSyncBacklog(
  db: ApiDatabase,
): Promise<{ pending: number; deadLetter: number }> {
  const rows = await db
    .select({ status: oxyFileReferenceSync.status, n: sql<number>`count(*)::int` })
    .from(oxyFileReferenceSync)
    .groupBy(oxyFileReferenceSync.status);
  return {
    pending: rows.find((row) => row.status === 'pending')?.n ?? 0,
    deadLetter: rows.find((row) => row.status === 'dead_letter')?.n ?? 0,
  };
}

// ── Reconciliation inventories ──────────────────────────────────────────────

/** How many inventory rows one keyset page reads. */
const INVENTORY_PAGE = 1000;

/**
 * Every (file, entity) pair Alia uses for one entity type, streamed by keyset
 * pages so a large table is never held in memory — the inventory
 * `references.reconcile` sends to Oxy (ADR 0043 D6). One query per type; the
 * entity id is each table's own primary key.
 */
export async function* referenceInventory(
  db: ApiDatabase,
  entityType: OxyFileEntityType,
): AsyncGenerator<{ fileId: string; entityId: string }> {
  let after = '';
  for (;;) {
    const page = await inventoryPage(db, entityType, after);
    for (const row of page) yield row;
    const last = page.at(-1);
    if (last === undefined || page.length < INVENTORY_PAGE) return;
    after = last.entityId;
  }
}

async function inventoryPage(
  db: ApiDatabase,
  entityType: OxyFileEntityType,
  after: string,
): Promise<{ fileId: string; entityId: string }[]> {
  switch (entityType) {
    case 'show_series':
      return pageOf(db, showSeries, showSeries.id, showSeries.coverFileId, after);
    case 'library_file':
      return pageOf(db, libraryFiles, libraryFiles.id, libraryFiles.oxyFileId, after);
    case 'speech_clip':
      return pageOf(db, speechClips, speechClips.cacheKey, speechClips.oxyFileId, after);
    case 'skill_file':
      return pageOf(db, skillFiles, skillFiles.id, skillFiles.oxyFileId, after);
  }
}

async function pageOf(
  db: ApiDatabase,
  // biome-ignore lint/suspicious/noExplicitAny: four concrete tables share one keyset query.
  table: any,
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  idColumn: any,
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  fileColumn: any,
  after: string,
): Promise<{ fileId: string; entityId: string }[]> {
  const rows: { fileId: string | null; entityId: string }[] = await db
    .select({ fileId: fileColumn, entityId: idColumn })
    .from(table)
    .where(and(isNotNull(fileColumn), sql`${idColumn} > ${after}`))
    .orderBy(asc(idColumn))
    .limit(INVENTORY_PAGE);
  return rows.flatMap((row) =>
    row.fileId === null ? [] : [{ fileId: row.fileId, entityId: row.entityId }],
  );
}

// ── Reconciliation ledger ───────────────────────────────────────────────────

/**
 * Claim today's reconciliation of `entityType`: answers `true` to exactly one
 * caller per `intervalHours`, across tasks and restarts, by one conditional
 * upsert on the server's clock.
 */
export async function claimReconcileRun(
  db: ApiDatabase,
  entityType: OxyFileEntityType,
  intervalHours: number,
): Promise<boolean> {
  const rows = await db
    .insert(oxyFileReconcileRuns)
    .values({ entityType, lastStartedAt: sql`now()` })
    .onConflictDoUpdate({
      target: oxyFileReconcileRuns.entityType,
      set: { lastStartedAt: sql`now()`, updatedAt: sql`now()` },
      setWhere: or(
        isNull(oxyFileReconcileRuns.lastStartedAt),
        lte(
          oxyFileReconcileRuns.lastStartedAt,
          sql`now() - make_interval(hours => ${intervalHours})`,
        ),
      ),
    })
    .returning({ entityType: oxyFileReconcileRuns.entityType });
  return rows.length > 0;
}

export async function finishReconcileRun(
  db: ApiDatabase,
  entityType: OxyFileEntityType,
  outcome: { result: Record<string, unknown> } | { error: string },
): Promise<void> {
  await db
    .update(oxyFileReconcileRuns)
    .set(
      'result' in outcome
        ? {
            lastFinishedAt: sql`now()`,
            lastResult: outcome.result,
            lastError: null,
            updatedAt: sql`now()`,
          }
        : { lastError: outcome.error.slice(0, 1000), updatedAt: sql`now()` },
    )
    .where(eq(oxyFileReconcileRuns.entityType, entityType));
}

// ── File events ─────────────────────────────────────────────────────────────

/**
 * Claim an Oxy file event for handling. `false` means it was already handled:
 * delivery is at least once, and the event id is the same on every retry.
 * The conflict is the answer, not an error to catch.
 */
export async function claimFileEvent(
  executor: Executor,
  event: { id: string; type: string; fileId: string },
): Promise<boolean> {
  const rows = await executor
    .insert(oxyFileEvents)
    .values(event)
    .onConflictDoNothing()
    .returning({ id: oxyFileEvents.id });
  return rows.length > 0;
}

/** Whether an event with this id was already handled. */
export async function isFileEventHandled(db: ApiDatabase, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: oxyFileEvents.id })
    .from(oxyFileEvents)
    .where(eq(oxyFileEvents.id, id))
    .limit(1);
  return rows.length > 0;
}

// ── Legacy reads ────────────────────────────────────────────────────────────

/** Count one read served from the legacy bucket, on today's (UTC) row. */
export async function countLegacyRead(db: ApiDatabase, kind: LegacyReadKind): Promise<void> {
  await db
    .insert(legacyStorageReads)
    .values({ kind, day: sql`(now() at time zone 'utc')::date`, reads: 1 })
    .onConflictDoUpdate({
      target: [legacyStorageReads.kind, legacyStorageReads.day],
      set: { reads: sql`${legacyStorageReads.reads} + 1`, lastReadAt: sql`now()` },
    });
}

/** Legacy reads per kind over the last `days` UTC days, today included — the retirement gate. */
export async function legacyReadsInWindow(
  db: ApiDatabase,
  days: number,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      kind: legacyStorageReads.kind,
      reads: sql<number>`sum(${legacyStorageReads.reads})::bigint`,
    })
    .from(legacyStorageReads)
    .where(sql`${legacyStorageReads.day} > (now() at time zone 'utc')::date - ${days}::int`)
    .groupBy(legacyStorageReads.kind);
  return Object.fromEntries(rows.map((row) => [row.kind, Number(row.reads)]));
}

/** Rows still naming a legacy object and no Oxy file — the second half of the retirement gate. */
export async function rowsStillOnLegacyStorage(db: ApiDatabase): Promise<Record<string, number>> {
  const count = async (
    // biome-ignore lint/suspicious/noExplicitAny: four concrete tables share one count.
    table: any,
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    legacy: any,
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    oxy: any,
  ): Promise<number> => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(and(isNotNull(legacy), isNull(oxy)));
    return row?.n ?? 0;
  };
  return {
    show_series: await count(showSeries, showSeries.coverImageAssetId, showSeries.coverFileId),
    library_file: await count(libraryFiles, libraryFiles.url, libraryFiles.oxyFileId),
    speech_clip: await count(speechClips, speechClips.objectKey, speechClips.oxyFileId),
    skill_file: await count(skillFiles, skillFiles.s3Key, skillFiles.oxyFileId),
  };
}

// ── Legacy object garbage ───────────────────────────────────────────────────

/**
 * Mark legacy objects as possible garbage once `delaySeconds` have passed.
 * Called BEFORE an upload (delay: an hour, the bound on the transaction that
 * will record it) and with the transaction that deletes a row naming one
 * (delay: zero). A repeat keeps the LATER deadline, so a re-upload of a key
 * that was about to be collected buys it a fresh hour.
 */
export async function markLegacyObjectsMaybeGarbage(
  executor: Executor,
  objects: readonly { key: string; kind: LegacyStoredObjectKind }[],
  delaySeconds: number,
): Promise<void> {
  if (objects.length === 0) return;
  await executor
    .insert(storageGcCandidates)
    .values(
      objects.map((object) => ({
        key: object.key,
        kind: object.kind,
        notBefore: sql`now() + make_interval(secs => ${delaySeconds}::double precision)`,
      })),
    )
    .onConflictDoUpdate({
      target: storageGcCandidates.key,
      set: {
        notBefore: sql`greatest(${storageGcCandidates.notBefore}, excluded.not_before)`,
        attempts: 0,
        lastError: null,
      },
    });
}

/** Up to `limit` candidates whose deadline has passed, oldest first. */
export async function dueGarbageCandidates(
  db: ApiDatabase,
  limit: number,
): Promise<{ key: string; kind: LegacyStoredObjectKind; attempts: number }[]> {
  return db
    .select({
      key: storageGcCandidates.key,
      kind: storageGcCandidates.kind,
      attempts: storageGcCandidates.attempts,
    })
    .from(storageGcCandidates)
    .where(lte(storageGcCandidates.notBefore, sql`now()`))
    .orderBy(asc(storageGcCandidates.notBefore))
    .limit(limit);
}

/** Whether any row of `kind` still names `key` — the question that makes a candidate garbage or not. */
export async function isLegacyObjectReferenced(
  db: ApiDatabase,
  kind: LegacyStoredObjectKind,
  key: string,
): Promise<boolean> {
  const exists = async (query: Promise<unknown[]>) => (await query).length > 0;
  switch (kind) {
    case 'library_file':
      return exists(
        db
          .select({ id: libraryFiles.id })
          .from(libraryFiles)
          .where(or(eq(libraryFiles.url, key), eq(libraryFiles.thumbnail, key)))
          .limit(1),
      );
    case 'speech_clip':
      return exists(
        db
          .select({ key: speechClips.cacheKey })
          .from(speechClips)
          .where(eq(speechClips.objectKey, key))
          .limit(1),
      );
    case 'skill_file':
      return exists(
        db.select({ id: skillFiles.id }).from(skillFiles).where(eq(skillFiles.s3Key, key)).limit(1),
      );
  }
}

/**
 * Forget candidates — collected, or found to be in use — but only if their
 * deadline still has passed: a re-upload that pushed it forward meanwhile wins.
 */
export async function dropGarbageCandidates(
  db: ApiDatabase,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  await db
    .delete(storageGcCandidates)
    .where(
      and(
        inArray(storageGcCandidates.key, [...keys]),
        lte(storageGcCandidates.notBefore, sql`now()`),
      ),
    );
}

/** A delete that failed: try again in five minutes, the error kept for an operator. */
export async function deferGarbageCandidate(
  db: ApiDatabase,
  key: string,
  error: string,
): Promise<void> {
  await db
    .update(storageGcCandidates)
    .set({
      attempts: sql`${storageGcCandidates.attempts} + 1`,
      lastError: error.slice(0, 1000),
      notBefore: sql`now() + interval '5 minutes'`,
    })
    .where(eq(storageGcCandidates.key, key));
}
