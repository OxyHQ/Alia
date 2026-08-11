/**
 * The autonomy context graph on Postgres: nodes, edges, sources and strategies.
 *
 * Four tables written by two files — `lib/autonomy/context-graph.ts` and
 * `routes/oxy-service-events.ts` — which is why they move together. Nothing
 * else in the package reads them.
 *
 * ## An OMITTED patch key is not written — and drizzle, not this file, is why
 *
 * `learnFromRun` sets exactly one of `lastSuccessAt` / `lastErrorAt` per run
 * and left the other `undefined`. Mongo drops an `undefined` from a `$set`, so
 * the stored value survived; the schema comment warns that the same statement
 * in Postgres would write NULL and erase the opposite timestamp.
 *
 * It does not, and that was MEASURED rather than assumed: drizzle omits an
 * `undefined` value from the `do update set` entirely. Compiling
 * `set: { lastErrorAt: undefined }` emits `do update set "last_success_at" =
 * $7, "updated_at" = $8` with `last_error_at` named nowhere, while the same
 * statement with `null` emits `"last_error_at" = $8` — so the builder already
 * has Mongo's semantics, and a guard spreading each key in only when defined
 * SURVIVES a mutation deleting it, because no input makes the two disagree.
 * The honest reading of that survivor is dead code, so there is no such guard.
 *
 * What remains load-bearing is the TYPE: every patch key below is optional and
 * none accepts `null`, so "leave it alone" is the only thing a caller can
 * express and an explicit NULL cannot be written by accident.
 *
 * ## `$setOnInsert` is expressed by OMISSION from the conflict clause
 *
 * `kind`, `label` and `type` are insert-only in the source. They appear in the
 * `values` and NOT in `onConflictDoUpdate.set`, which is exactly Mongo's
 * `$setOnInsert`. Adding them to the conflict clause would silently start
 * relabelling existing rows.
 *
 * ## `$inc` on an upsert increments from the INSERTED value
 *
 * Mongo applies `$inc` when the upsert inserts, so a first run stores the delta
 * itself. That is reproduced by putting the delta in `values` and
 * `existing + delta` in the conflict clause.
 */

import { and, eq, getTableName, inArray, sql, type Column, type Table } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import type { ContextEdgeType } from '../../domain/context-edge.js';
import type { ContextNodeType } from '../../domain/context-node.js';
import type { ContextSourceKind } from '../../domain/context-source.js';
import type { AutonomyIntent } from '../../domain/retrieval-strategy.js';
import type { ApiDatabase } from '../index';
import {
  contextEdges,
  contextNodes,
  contextSources,
  retrievalStrategies,
} from '../schema/context-graph';

/** The four score columns `ensureSources` reads, under the names it uses. */
export interface SourceScores {
  readonly sourceKey: string;
  readonly freshnessScore: number;
  readonly precisionScore: number;
  readonly avgCostScore: number;
}

export type ContextNodeRow = typeof contextNodes.$inferSelect;
export type RetrievalStrategyRow = typeof retrievalStrategies.$inferSelect;

/**
 * A TABLE-QUALIFIED column reference, for the right-hand side of an increment.
 *
 * The qualifier is not decoration. Inside `on conflict do update set`, an
 * UNQUALIFIED name is ambiguous between the target table and `excluded`, and
 * Postgres refuses the statement with `42702` — so `successful_reads =
 * successful_reads + 1` does not run at all. Qualifying names the existing row,
 * which is what an increment means, and the same form is valid in a plain
 * `update … set`, so both call sites use one spelling.
 *
 * The column name comes from `sqlColumnName`, never `column.name`: the latter
 * is the TypeScript property and would produce `column "successfulReads" does
 * not exist`.
 */
function existingValue(table: Table, column: Column) {
  return sql.raw(`"${getTableName(table)}"."${sqlColumnName(column)}"`);
}

const successfulReads = existingValue(contextSources, contextSources.successfulReads);
const failedReads = existingValue(contextSources, contextSources.failedReads);
const successCount = existingValue(retrievalStrategies, retrievalStrategies.successCount);
const failureCount = existingValue(retrievalStrategies, retrievalStrategies.failureCount);

/** The scores for whichever of `sourceKeys` this user already has rows for. */
export async function findSourceScores(
  db: ApiDatabase,
  oxyUserId: string,
  sourceKeys: string[],
): Promise<SourceScores[]> {
  if (sourceKeys.length === 0) return [];
  return db
    .select({
      sourceKey: contextSources.sourceKey,
      freshnessScore: contextSources.freshnessScore,
      precisionScore: contextSources.precisionScore,
      avgCostScore: contextSources.avgCostScore,
    })
    .from(contextSources)
    .where(
      and(eq(contextSources.oxyUserId, oxyUserId), inArray(contextSources.sourceKey, sourceKeys)),
    );
}

export interface NewContextSource {
  readonly oxyUserId: string;
  readonly sourceKey: string;
  readonly kind: ContextSourceKind;
  readonly label: string;
  readonly freshnessScore: number;
  readonly precisionScore: number;
  readonly avgCostScore: number;
}

/**
 * Seed the default sources a user is missing.
 *
 * The source was `insertMany(…, { ordered: false }).catch(() => {})`: insert
 * what you can, ignore duplicates, and swallow everything else. `do nothing` on
 * the unique expresses the duplicate half structurally, so only a genuine
 * failure now propagates — the caller decides what to do with it, as it always
 * did with the surrounding `catch`.
 */
export async function insertMissingSources(
  db: ApiDatabase,
  rows: NewContextSource[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(contextSources)
    .values(rows)
    .onConflictDoNothing({ target: [contextSources.oxyUserId, contextSources.sourceKey] });
}

/** What a run may record about a source. An omitted key is left untouched. */
export interface ContextSourceRun {
  readonly oxyUserId: string;
  readonly sourceKey: string;
  /** Insert-only, per `$setOnInsert`. */
  readonly kind: ContextSourceKind;
  readonly label: string;
  readonly successfulReadsDelta?: number;
  readonly failedReadsDelta?: number;
  readonly freshnessScore?: number;
  readonly precisionScore?: number;
  readonly avgLatencyMs?: number;
  readonly lastSuccessAt?: Date;
  readonly lastErrorAt?: Date;
}

/** Record a read against a source, creating the row if this is the first one. */
export async function recordSourceRun(db: ApiDatabase, run: ContextSourceRun): Promise<void> {
  const successDelta = run.successfulReadsDelta ?? 0;
  const failureDelta = run.failedReadsDelta ?? 0;
  // An `undefined` here is omitted from the statement by drizzle, not written
  // as NULL. See the file comment — that is measured, and it is what lets this
  // be a plain object rather than a conditional one.
  const patch = {
    freshnessScore: run.freshnessScore,
    precisionScore: run.precisionScore,
    avgLatencyMs: run.avgLatencyMs,
    lastSuccessAt: run.lastSuccessAt,
    lastErrorAt: run.lastErrorAt,
  };

  await db
    .insert(contextSources)
    .values({
      oxyUserId: run.oxyUserId,
      sourceKey: run.sourceKey,
      kind: run.kind,
      label: run.label,
      successfulReads: successDelta,
      failedReads: failureDelta,
      ...patch,
    })
    .onConflictDoUpdate({
      target: [contextSources.oxyUserId, contextSources.sourceKey],
      set: {
        ...patch,
        successfulReads: sql`${successfulReads} + ${successDelta}`,
        failedReads: sql`${failedReads} + ${failureDelta}`,
      },
    });
}

/** The user's active strategy for an intent, if they have one. */
export async function findActiveStrategy(
  db: ApiDatabase,
  oxyUserId: string,
  intent: AutonomyIntent,
): Promise<RetrievalStrategyRow | undefined> {
  const rows = await db
    .select()
    .from(retrievalStrategies)
    .where(
      and(
        eq(retrievalStrategies.oxyUserId, oxyUserId),
        eq(retrievalStrategies.intent, intent),
        eq(retrievalStrategies.active, true),
      ),
    )
    .limit(1);
  return rows[0];
}

export interface NewRetrievalStrategy {
  readonly oxyUserId: string;
  readonly intent: AutonomyIntent;
  readonly name: string;
  readonly sourceSteps: unknown[];
}

/**
 * Create a strategy unless one with the same `(user, intent, name)` exists.
 *
 * `ensureIntentStrategy` reads first and creates on a miss, which leaves a race
 * the source resolved by throwing: a concurrent creator made Mongoose's
 * `create` fail with E11000, uncaught, rejecting the whole recall. `do nothing`
 * makes the loser a no-op instead. That is a BEHAVIOUR CHANGE, in the direction
 * the guard was reaching for — recorded here rather than absorbed silently.
 */
export async function createStrategyIfAbsent(
  db: ApiDatabase,
  strategy: NewRetrievalStrategy,
): Promise<void> {
  await db
    .insert(retrievalStrategies)
    .values({
      oxyUserId: strategy.oxyUserId,
      intent: strategy.intent,
      name: strategy.name,
      active: true,
      sourceSteps: strategy.sourceSteps,
    })
    .onConflictDoNothing({
      target: [
        retrievalStrategies.oxyUserId,
        retrievalStrategies.intent,
        retrievalStrategies.name,
      ],
    });
}

export interface RetrievalStrategyRun {
  readonly oxyUserId: string;
  readonly intent: AutonomyIntent;
  /** Insert-only. Only reached when the user has no ACTIVE strategy yet. */
  readonly name: string;
  readonly sourceSteps: unknown[];
  readonly successDelta: number;
  readonly failureDelta: number;
  readonly lastUsedAt: Date;
  readonly avgLatencyMs: number;
}

/**
 * Record a run against the user's active strategy for an intent.
 *
 * Two statements rather than one upsert, because the source's filter and the
 * table's unique are DIFFERENT keys: `updateOne` matched
 * `{oxyUserId, intent, active: true}` while the unique is
 * `(oxy_user_id, intent, name)`. An `on conflict` on the unique would target
 * the `<intent>-default` row by name and miss an active strategy stored under
 * any other name — so the update runs against the source's own predicate first,
 * and the insert is the upsert half, reached only when nothing active existed.
 *
 * The insert still carries `on conflict … do update`, which is what closes the
 * gap between the two statements: a concurrent creator makes this one apply its
 * deltas to the winner's row instead of failing.
 *
 * No transaction. The source had none, and the conflict clause is the interlock.
 */
export async function recordStrategyRun(
  db: ApiDatabase,
  run: RetrievalStrategyRun,
): Promise<void> {
  const updated = await db
    .update(retrievalStrategies)
    .set({
      successCount: sql`${successCount} + ${run.successDelta}`,
      failureCount: sql`${failureCount} + ${run.failureDelta}`,
      lastUsedAt: run.lastUsedAt,
      avgLatencyMs: run.avgLatencyMs,
    })
    .where(
      and(
        eq(retrievalStrategies.oxyUserId, run.oxyUserId),
        eq(retrievalStrategies.intent, run.intent),
        eq(retrievalStrategies.active, true),
      ),
    )
    .returning({ id: retrievalStrategies.id });

  if (updated.length > 0) return;

  await db
    .insert(retrievalStrategies)
    .values({
      oxyUserId: run.oxyUserId,
      intent: run.intent,
      name: run.name,
      active: true,
      sourceSteps: run.sourceSteps,
      successCount: run.successDelta,
      failureCount: run.failureDelta,
      lastUsedAt: run.lastUsedAt,
      avgLatencyMs: run.avgLatencyMs,
    })
    .onConflictDoUpdate({
      target: [
        retrievalStrategies.oxyUserId,
        retrievalStrategies.intent,
        retrievalStrategies.name,
      ],
      set: {
        successCount: sql`${successCount} + ${run.successDelta}`,
        failureCount: sql`${failureCount} + ${run.failureDelta}`,
        lastUsedAt: run.lastUsedAt,
        avgLatencyMs: run.avgLatencyMs,
      },
    });
}

export interface ContextNodeUpsert {
  readonly oxyUserId: string;
  readonly nodeKey: string;
  /** Insert-only, per `$setOnInsert`. */
  readonly type: ContextNodeType;
  readonly label: string;
  readonly lastSeenAt: Date;
  readonly freshnessScore?: number;
}

/**
 * Record that a node was seen, creating it on the first sighting.
 *
 * Returns the row because `learnFromRun` needs both endpoint ids to write the
 * edge between them — the `new: true` on the source's `findOneAndUpdate`.
 */
export async function upsertContextNode(
  db: ApiDatabase,
  node: ContextNodeUpsert,
): Promise<ContextNodeRow> {
  const patch = { lastSeenAt: node.lastSeenAt, freshnessScore: node.freshnessScore };
  const rows = await db
    .insert(contextNodes)
    .values({
      oxyUserId: node.oxyUserId,
      nodeKey: node.nodeKey,
      type: node.type,
      label: node.label,
      ...patch,
    })
    .onConflictDoUpdate({
      target: [contextNodes.oxyUserId, contextNodes.nodeKey],
      set: patch,
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('context node upsert returned no row');
  return row;
}

export interface ContextEdgeUpsert {
  readonly oxyUserId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly edgeType: ContextEdgeType;
  readonly lastSeenAt: Date;
  readonly weight?: number;
}

/** Record that a relation between two nodes was seen. */
export async function upsertContextEdge(
  db: ApiDatabase,
  edge: ContextEdgeUpsert,
): Promise<void> {
  const patch = { lastSeenAt: edge.lastSeenAt, weight: edge.weight };
  await db
    .insert(contextEdges)
    .values({
      oxyUserId: edge.oxyUserId,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      edgeType: edge.edgeType,
      ...patch,
    })
    .onConflictDoUpdate({
      target: [
        contextEdges.oxyUserId,
        contextEdges.fromNodeId,
        contextEdges.toNodeId,
        contextEdges.edgeType,
      ],
      set: patch,
    });
}
