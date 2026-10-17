/**
 * The three loops that keep Alia's stored files honest (oxy ADR 0043):
 *
 * - **Reference sync** drains `oxy_file_reference_sync` — every use of an Oxy
 *   file that a transaction recorded — into `references.add` / `remove`. Not
 *   leader-gated: rows are claimed under a lease with `SKIP LOCKED`, so every
 *   task shares the work and a dead task's claim lapses.
 * - **Nightly reconciliation** sends Oxy the full inventory of each entity type
 *   (`references.reconcile`, D6): the net under the outbox, and how existing
 *   rows first enter the model. Once a day per type, decided by a conditional
 *   write in `oxy_file_reconcile_runs`, so restarts and several tasks still run
 *   it once.
 * - **Legacy garbage collection** deletes objects in Alia's own bucket that no
 *   row names any more (`storage_gc_candidates`). Leader-gated: deletes should
 *   not race each other, and the volume is small.
 *
 * Every loop logs a line per run with what it did — including when it did
 * nothing, because "nothing to do" and "never ran" otherwise look the same.
 */

import { randomUUID } from 'node:crypto';
import { OXY_FILE_ENTITY_TYPES, type OxyFileEntityType } from '../../domain/oxy-files.js';
import { getDb, type ApiDatabase } from '../../db/index.js';
import {
  claimReconcileRun,
  claimReferenceSyncs,
  completeReferenceSync,
  deferGarbageCandidate,
  dropGarbageCandidates,
  dueGarbageCandidates,
  failReferenceSync,
  finishReconcileRun,
  isLegacyObjectReferenced,
  referenceInventory,
  type ClaimedReferenceSync,
} from '../../db/files/oxyFileRepository.js';
import type { OxyServer } from '@oxy.so/core/server';
import { log } from '../logger.js';
import { oxyServiceClient } from '../oxy-service-client.js';
import { deleteS3Objects } from '../s3.js';

/** A reference intent that fails this many times is dead-lettered for a person to read. */
export const REFERENCE_SYNC_MAX_ATTEMPTS = 16;
const REFERENCE_SYNC_BATCH = 100;
const REFERENCE_SYNC_LEASE_SECONDS = 120;
const REFERENCE_SYNC_INTERVAL_MS = 15_000;

const RECONCILE_INTERVAL_HOURS = 24;
const RECONCILE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const GC_BATCH = 200;
const GC_INTERVAL_MS = 5 * 60 * 1000;

/** Injectable for tests. */
let clientFactory: () => OxyServer | null = oxyServiceClient;
export function setOxyFileSyncClientForTests(factory: (() => OxyServer | null) | null): void {
  clientFactory = factory ?? oxyServiceClient;
}

// ── Reference sync ──────────────────────────────────────────────────────────

/**
 * Apply one batch of due reference intents. Answers how many were applied and
 * how many failed, for the log line and for tests.
 *
 * `not_found` on an add is not retried: it means the file does not exist or
 * Alia may not reference it, which no retry will change — the row is dropped
 * and the next reconciliation reports it as `refused`. On a remove it means
 * the reference was already gone, which is the goal.
 */
export async function drainReferenceSyncOnce(
  db: ApiDatabase = getDb(),
  leaseOwner = `oxy-files:${process.pid}:${randomUUID()}`,
): Promise<{ applied: number; failed: number; refused: number }> {
  const client = clientFactory();
  if (client === null) return { applied: 0, failed: 0, refused: 0 };

  const claimed = await claimReferenceSyncs(db, {
    leaseOwner,
    limit: REFERENCE_SYNC_BATCH,
    leaseSeconds: REFERENCE_SYNC_LEASE_SECONDS,
  });
  let applied = 0;
  let failed = 0;
  let refused = 0;

  for (const desired of ['present', 'absent'] as const) {
    const rows = claimed.filter((row) => row.desired === desired);
    if (rows.length === 0) continue;
    const references = rows.map(({ fileId, entityType, entityId }) => ({
      fileId,
      entityType,
      entityId,
    }));
    let results: { fileId: string; entityType: string; entityId: string; result: string }[];
    try {
      results =
        desired === 'present'
          ? await client.assets.references.add(references)
          : await client.assets.references.remove(references);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      for (const row of rows) {
        await failReferenceSync(db, row, leaseOwner, message, REFERENCE_SYNC_MAX_ATTEMPTS);
        failed += 1;
      }
      continue;
    }
    for (const row of rows) {
      const answer = results.find(
        (result) =>
          result.fileId === row.fileId &&
          result.entityType === row.entityType &&
          result.entityId === row.entityId,
      );
      if (answer === undefined) {
        await failReferenceSync(
          db,
          row,
          leaseOwner,
          'Oxy did not answer for this reference',
          REFERENCE_SYNC_MAX_ATTEMPTS,
        );
        failed += 1;
        continue;
      }
      if (desired === 'present' && answer.result === 'not_found') {
        refused += 1;
        logRefusal(row);
      }
      await completeReferenceSync(db, row, leaseOwner);
      applied += 1;
    }
  }
  if (claimed.length > 0) {
    log.files.info({ applied, failed, refused }, 'Oxy file references synced');
  }
  return { applied, failed, refused };
}

function logRefusal(row: ClaimedReferenceSync): void {
  log.files.warn(
    { entityType: row.entityType, entityId: row.entityId },
    'Oxy refused a file reference: the file is gone or not one Alia may use',
  );
}

// ── Nightly reconciliation ──────────────────────────────────────────────────

/**
 * Reconcile every due entity type once. `force` ignores the daily ledger (the
 * operator script's `--reconcile`); `dryRun` reports without changing Oxy.
 */
export async function reconcileReferencesOnce(
  db: ApiDatabase = getDb(),
  options: { force?: boolean; dryRun?: boolean; entityTypes?: readonly OxyFileEntityType[] } = {},
): Promise<Partial<Record<OxyFileEntityType, unknown>>> {
  const client = clientFactory();
  if (client === null) return {};
  const outcomes: Partial<Record<OxyFileEntityType, unknown>> = {};
  for (const entityType of options.entityTypes ?? OXY_FILE_ENTITY_TYPES) {
    if (
      options.force !== true &&
      !(await claimReconcileRun(db, entityType, RECONCILE_INTERVAL_HOURS))
    ) {
      continue;
    }
    try {
      const result = await client.assets.references.reconcile(
        entityType,
        referenceInventory(db, entityType),
        { dryRun: options.dryRun === true },
      );
      const summary = {
        added: result.added,
        removed: result.removed,
        unchanged: result.unchanged,
        refused: result.refused,
        dryRun: result.dryRun,
      };
      if (options.dryRun !== true) await finishReconcileRun(db, entityType, { result: summary });
      outcomes[entityType] = summary;
      log.files.info(
        {
          entityType,
          added: summary.added,
          removed: summary.removed,
          unchanged: summary.unchanged,
          refused: summary.refused,
          dryRun: summary.dryRun,
        },
        'Oxy file references reconciled',
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await finishReconcileRun(db, entityType, { error: message });
      outcomes[entityType] = { error: message };
      log.files.error({ err: error, entityType }, 'Oxy file reference reconciliation failed');
    }
  }
  return outcomes;
}

// ── Legacy garbage collection ───────────────────────────────────────────────

/**
 * Delete legacy objects that no row names and whose grace has passed. A
 * candidate found in use is dropped — the upload it was marked for committed.
 */
export async function collectLegacyGarbageOnce(
  db: ApiDatabase = getDb(),
  remove: (keys: readonly string[]) => Promise<number> = deleteS3Objects,
): Promise<{ deleted: number; inUse: number; failed: number }> {
  const due = await dueGarbageCandidates(db, GC_BATCH);
  let deleted = 0;
  let inUse = 0;
  let failed = 0;
  const settled: string[] = [];
  for (const candidate of due) {
    try {
      if (await isLegacyObjectReferenced(db, candidate.kind, candidate.key)) {
        inUse += 1;
        settled.push(candidate.key);
        continue;
      }
      const count = await remove([candidate.key]);
      if (count !== 1) throw new Error('The bucket did not confirm the delete');
      deleted += 1;
      settled.push(candidate.key);
    } catch (error: unknown) {
      failed += 1;
      await deferGarbageCandidate(
        db,
        candidate.key,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  await dropGarbageCandidates(db, settled);
  log.files.info({ deleted, inUse, failed, due: due.length }, 'Legacy storage garbage collected');
  return { deleted, inUse, failed };
}

// ── Scheduling ──────────────────────────────────────────────────────────────

const timers: ReturnType<typeof setInterval>[] = [];
let syncing = false;

/**
 * Start the three loops. Reference sync runs on every task; reconciliation and
 * garbage collection only while `isLeader()` says so, consulted per tick so
 * leadership moving mid-process moves them.
 */
export function startOxyFileSync(isLeader: () => boolean): void {
  if (timers.length > 0) return;
  const every = (ms: number, run: () => Promise<unknown>) => {
    const timer = setInterval(() => {
      void run().catch((err: unknown) => log.files.error({ err }, 'Oxy file loop failed'));
    }, ms);
    timer.unref?.();
    timers.push(timer);
  };
  every(REFERENCE_SYNC_INTERVAL_MS, async () => {
    if (syncing) return;
    syncing = true;
    try {
      await drainReferenceSyncOnce();
    } finally {
      syncing = false;
    }
  });
  every(RECONCILE_CHECK_INTERVAL_MS, async () => {
    if (isLeader()) await reconcileReferencesOnce();
  });
  every(GC_INTERVAL_MS, async () => {
    if (isLeader() && (process.env.AWS_S3_BUCKET ?? '') !== '') await collectLegacyGarbageOnce();
  });
}

export function stopOxyFileSync(): void {
  for (const timer of timers.splice(0)) clearInterval(timer);
}
