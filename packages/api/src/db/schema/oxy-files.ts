/**
 * Alia's side of Oxy Files (oxy ADR 0043): which file uses Oxy has to be told
 * about, which file events it has already handled, when each entity type was
 * last reconciled, how often the legacy bucket is still read, and which legacy
 * objects may be garbage.
 *
 * `lib/files/` owns the rules; `docs/oxy-files.md` is the operator's view.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from '@oxy.so/db';
import {
  LEGACY_READ_KINDS,
  LEGACY_STORED_OBJECT_KINDS,
  OXY_FILE_ENTITY_TYPES,
  OXY_FILE_REFERENCE_STATES,
  OXY_FILE_SYNC_STATUSES,
  type LegacyReadKind,
  type LegacyStoredObjectKind,
  type OxyFileEntityType,
  type OxyFileReferenceState,
  type OxyFileSyncStatus,
} from '../../domain/oxy-files.js';
import { checkOneOf } from './columns';

/**
 * The durable outbox of Alia's file references: one row per (file, entity)
 * whose reference Oxy has not been told about yet.
 *
 * ## A desired STATE, not a queue of operations
 *
 * The row says what Oxy should hold — `present` or `absent` — and a later
 * change to the same (file, entity) OVERWRITES it rather than queueing behind
 * it. A queue of `add` then `remove` would have to be applied in order across
 * several ECS tasks, and the order is exactly what concurrent workers lose; a
 * state is idempotent in any order and the last write wins. `generation` is
 * bumped on every overwrite, so a worker that applied generation 3 deletes the
 * row only if nobody wrote generation 4 while it worked.
 *
 * ## Written in the SAME transaction as the row that uses the file
 *
 * The domain write and this row commit together, so "the series points at the
 * file but Oxy was never told" and "the series is gone but Oxy keeps the
 * reference" are not states a crash can produce. The worker
 * (`lib/files/oxy-file-sync.ts`) drains it with retries; nightly
 * reconciliation is the net under both.
 *
 * Applied rows are DELETED, so the table holds only work still owed and the
 * dead letters someone must look at — no retention rule is needed.
 */
export const oxyFileReferenceSync = pgTable(
  'oxy_file_reference_sync',
  {
    /** An Oxy file id. No foreign key: Oxy owns files. */
    fileId: text().notNull(),
    entityType: text({ enum: OXY_FILE_ENTITY_TYPES as unknown as [string, ...string[]] })
      .$type<OxyFileEntityType>()
      .notNull(),
    entityId: text().notNull(),
    desired: text({ enum: OXY_FILE_REFERENCE_STATES as unknown as [string, ...string[]] })
      .$type<OxyFileReferenceState>()
      .notNull(),
    status: text({ enum: OXY_FILE_SYNC_STATUSES as unknown as [string, ...string[]] })
      .$type<OxyFileSyncStatus>()
      .notNull()
      .default('pending'),
    generation: integer().notNull().default(1),
    attempts: integer().notNull().default(0),
    /** When the row may next be claimed. The SERVER's clock. */
    availableAt: timestamptz().notNull().default(sql`now()`),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: 'oxy_file_reference_sync_pkey',
      columns: [t.fileId, t.entityType, t.entityId],
    }),
    index('oxy_file_reference_sync_claim_idx').on(t.status, t.availableAt),
    checkOneOf('oxy_file_reference_sync_entity_type_check', t.entityType, OXY_FILE_ENTITY_TYPES),
    checkOneOf('oxy_file_reference_sync_desired_check', t.desired, OXY_FILE_REFERENCE_STATES),
    checkOneOf('oxy_file_reference_sync_status_check', t.status, OXY_FILE_SYNC_STATUSES),
  ],
);

/**
 * File events Oxy delivered and Alia handled — the dedupe for an at-least-once
 * webhook. The primary key IS Oxy's event id, so the claim is an
 * `INSERT … ON CONFLICT DO NOTHING RETURNING`. Kept 30 days (`EXPIRY_TARGETS`):
 * Oxy stops retrying long before, and nothing else reads these rows.
 */
export const oxyFileEvents = pgTable(
  'oxy_file_events',
  {
    id: text().primaryKey(),
    type: text().notNull(),
    fileId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('oxy_file_events_created_at_idx').on(t.createdAt)],
);

/**
 * The last reconciliation of each entity type with Oxy (ADR 0043 D6) — what
 * makes the nightly run once a day across restarts and tasks, and what an
 * operator reads to see that it ran and what it changed.
 */
export const oxyFileReconcileRuns = pgTable(
  'oxy_file_reconcile_runs',
  {
    entityType: text({ enum: OXY_FILE_ENTITY_TYPES as unknown as [string, ...string[]] })
      .$type<OxyFileEntityType>()
      .primaryKey(),
    lastStartedAt: timestamptz(),
    lastFinishedAt: timestamptz(),
    /** `{ added, removed, unchanged, refused }` of the last successful run. */
    lastResult: jsonb(),
    lastError: text(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('oxy_file_reconcile_runs_entity_type_check', t.entityType, OXY_FILE_ENTITY_TYPES),
  ],
);

/**
 * Reads served from Alia's own bucket, per kind per day — the metric that
 * gates retiring the bucket (`docs/oxy-files.md`).
 *
 * In Postgres rather than only in the process's `/metrics`, because the gate is
 * "zero reads for N days across every task and every restart", and an
 * in-memory counter forgets both. One row per (kind, UTC day): tiny forever,
 * so it carries no retention rule.
 */
export const legacyStorageReads = pgTable(
  'legacy_storage_reads',
  {
    kind: text({ enum: LEGACY_READ_KINDS as unknown as [string, ...string[]] })
      .$type<LegacyReadKind>()
      .notNull(),
    day: date({ mode: 'string' }).notNull(),
    reads: bigint({ mode: 'number' }).notNull().default(0),
    lastReadAt: timestamptz().notNull().default(sql`now()`),
  },
  (t) => [
    primaryKey({ name: 'legacy_storage_reads_pkey', columns: [t.kind, t.day] }),
    checkOneOf('legacy_storage_reads_kind_check', t.kind, LEGACY_READ_KINDS),
  ],
);

/**
 * Objects in Alia's own bucket that may have become garbage.
 *
 * Written BEFORE an upload (the object is about to exist and nothing names it
 * yet) and whenever a row naming one is deleted. The collector
 * (`lib/files/storage-gc.ts`) deletes an object only when `not_before` has
 * passed AND no row of its kind names it any more — so the candidate is a hint,
 * never an instruction, and a candidate for an object that did get used is
 * simply dropped. That is what closes the window between an upload and the
 * transaction that records it: a crash or a rolled-back transaction leaves a
 * candidate, and the object goes an hour later instead of living forever.
 */
export const storageGcCandidates = pgTable(
  'storage_gc_candidates',
  {
    /** The object key in Alia's bucket. */
    key: text().primaryKey(),
    kind: text({ enum: LEGACY_STORED_OBJECT_KINDS as unknown as [string, ...string[]] })
      .$type<LegacyStoredObjectKind>()
      .notNull(),
    notBefore: timestamptz().notNull(),
    attempts: integer().notNull().default(0),
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('storage_gc_candidates_not_before_idx').on(t.notBefore),
    checkOneOf('storage_gc_candidates_kind_check', t.kind, LEGACY_STORED_OBJECT_KINDS),
  ],
);
