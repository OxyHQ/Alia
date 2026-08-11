/**
 * Task-router decisions, on Postgres.
 *
 * One row per inbound message a `task_router` agent classified and dispatched.
 * Swept at 90 days by `db/expiryTargets.ts`, replacing the Mongo TTL index on
 * `created_at`.
 *
 * ## The WIRE SHAPE is nested and the TABLE is flat
 *
 * The Mongoose schema nested `classification` and `routedTo` as sub-documents;
 * the Postgres schema flattens both into real columns, because their shape is
 * fixed and owned by this service and `jsonb` would only hide them from the
 * planner. But `packages/app` reads `item.classification.category`,
 * `item.routedTo?.name` and `item._id` off the JSON this API returns, and a
 * shipped mobile build cannot be recalled — so the read functions rebuild the
 * nested shape, including `_id`, and that reconstruction is the contract rather
 * than an accident of the old store. `routedTo` is null as a GROUP, matching
 * both the source and the client's `| null`.
 *
 * ## Ids are text on both sides now
 *
 * The Mongoose schema declared `agentId` and `oxyUserId` as `ObjectId`. One
 * caller matched on a route parameter (a string, which Mongoose cast) and
 * another on `agent._id` (an ObjectId, which an aggregation pipeline does NOT
 * cast). Both were the same agent's id reached two ways, and under a `text`
 * column they are simply the same string — so the two spellings unify instead of
 * diverging. There is no behaviour change here, which is worth recording because
 * the two call sites look like they disagree.
 */

import { desc, eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { ApiDatabase } from '../index';
import { routingLogs, type RoutingStatus, type RoutingTargetType } from '../schema/telemetry';

export interface RoutingTarget {
  readonly type: RoutingTargetType;
  readonly id: string;
  readonly name: string;
}

export interface NewRoutingLog {
  readonly agentId: string;
  readonly oxyUserId: string;
  readonly triggerId?: string;
  readonly inboundChannel: string;
  readonly inboundSummary: string;
  readonly classification: { category: string; priority: string; confidence: number };
  readonly routedTo: RoutingTarget | null;
  readonly reasoning: string;
  readonly status?: RoutingStatus;
}

/** The nested JSON shape `packages/app` consumes. Do not flatten this. */
export interface RoutingLogView {
  readonly _id: string;
  readonly agentId: string;
  readonly oxyUserId: string;
  readonly triggerId: string | null;
  readonly inboundChannel: string;
  readonly inboundSummary: string;
  readonly classification: { category: string; priority: string; confidence: number };
  readonly routedTo: RoutingTarget | null;
  readonly reasoning: string;
  readonly status: RoutingStatus;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

type Row = typeof routingLogs.$inferSelect;

function toView(row: Row): RoutingLogView {
  return {
    _id: row.id,
    agentId: row.agentId,
    oxyUserId: row.oxyUserId,
    triggerId: row.triggerId,
    inboundChannel: row.inboundChannel,
    inboundSummary: row.inboundSummary,
    classification: {
      category: row.classificationCategory,
      priority: row.classificationPriority,
      confidence: row.classificationConfidence,
    },
    // Null as a GROUP: a classified message that was routed nowhere is a real
    // state, and the client's type is `| null` rather than a partial object.
    routedTo: row.routedToType
      ? { type: row.routedToType, id: row.routedToId ?? '', name: row.routedToName ?? '' }
      : null,
    reasoning: row.reasoning,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

/** Append one decision and return it in the shape callers already log. */
export async function createRoutingLog(
  db: ApiDatabase,
  entry: NewRoutingLog,
): Promise<RoutingLogView> {
  const [row] = await db
    .insert(routingLogs)
    .values({
      agentId: entry.agentId,
      oxyUserId: entry.oxyUserId,
      triggerId: entry.triggerId ?? null,
      inboundChannel: entry.inboundChannel,
      inboundSummary: entry.inboundSummary,
      classificationCategory: entry.classification.category,
      classificationPriority: entry.classification.priority,
      classificationConfidence: entry.classification.confidence,
      routedToType: entry.routedTo?.type ?? null,
      routedToId: entry.routedTo?.id ?? null,
      routedToName: entry.routedTo?.name ?? null,
      reasoning: entry.reasoning,
      status: entry.status ?? 'routed',
    })
    .returning();
  return toView(row);
}

/** One agent's decisions, newest first, with the total for pagination. */
export async function listRoutingLogsForAgent(
  db: ApiDatabase,
  agentId: string,
  offset: number,
  limit: number,
): Promise<{ logs: RoutingLogView[]; total: number }> {
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(routingLogs)
      .where(eq(routingLogs.agentId, agentId))
      .orderBy(desc(routingLogs.createdAt))
      .offset(offset)
      .limit(limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(routingLogs)
      .where(eq(routingLogs.agentId, agentId)),
  ]);
  return { logs: rows.map(toView), total: counted.total };
}

/**
 * The routing-stats facets.
 *
 * The group key is served as `_id` because that is what the Mongo `$group`
 * produced and what the client destructures. Four independent groupings, run in
 * parallel rather than as one `$facet` — Postgres has no facet operator, and
 * four small aggregates over an indexed `agent_id` is cheaper to read than a
 * single query with four `FILTER`ed grouping sets that would have to be
 * unpivoted back into four lists anyway.
 */
export interface RoutingFacet {
  readonly _id: string;
  readonly count: number;
}

export interface RoutingStats {
  readonly byCategory: RoutingFacet[];
  readonly byPriority: RoutingFacet[];
  readonly byStatus: RoutingFacet[];
  readonly total: number;
}

export async function routingStatsForAgent(
  db: ApiDatabase,
  agentId: string,
): Promise<RoutingStats> {
  const facet = <TColumn extends AnyPgColumn>(column: TColumn) =>
    db
      .select({ _id: column, count: sql<number>`count(*)::int` })
      .from(routingLogs)
      .where(eq(routingLogs.agentId, agentId))
      .groupBy(column)
      .orderBy(desc(sql`count(*)`), column);

  const [byCategory, byPriority, byStatus, [counted]] = await Promise.all([
    facet(routingLogs.classificationCategory),
    facet(routingLogs.classificationPriority),
    facet(routingLogs.status),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(routingLogs)
      .where(eq(routingLogs.agentId, agentId)),
  ]);

  return { byCategory, byPriority, byStatus, total: counted.total };
}
