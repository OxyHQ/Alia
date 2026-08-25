/**
 * Agent sessions and the resources they claim, on Postgres.
 *
 * `agent_sessions` and `agent_session_resources` move together for the reason
 * the schema states: the resources WERE the session document, an embedded array,
 * so every writer of one is a writer of the other and the child cascades.
 *
 * ## The runner mutates a DOCUMENT; this file exposes STATEMENTS
 *
 * `lib/agent/runner.ts` was written against a hydrated Mongoose document — it
 * assigns `session.status`, `session.stats.totalSteps`, pushes onto
 * `session.resources` and calls `save()` eleven times across one run. That
 * surface has no Postgres counterpart, and reproducing it (a dirty-tracking
 * wrapper that diffs and flushes) would be a second ORM.
 *
 * So the shape here is: one READ hands back a plain record, and every mutation
 * is a named function taking exactly the columns it writes. The runner keeps its
 * in-memory copy for the reads it does between saves, which is what the document
 * was giving it anyway — `save()` never re-read.
 *
 * ## `stats.*` and `config.*` are rebuilt on the way OUT, not stored grouped
 *
 * The wire shape is `{stats: {totalSteps, …}, config: {maxSteps, …}}` and the
 * app reads `task.stats.totalTokens` (`packages/app/lib/hooks/use-tasks.ts:25`),
 * so {@link toAgentSessionRecord} regroups the flattened columns. The columns
 * stay flat because that is what a `WHERE stats_completed_at IS NULL` can index.
 *
 * ## `agentId` is an OBJECT in the two listings, and that is a response contract
 *
 * `populate('agentId', 'name handle avatar')` REPLACED the id with a document,
 * and `packages/app/components/tasks/task-card.tsx:66` reads
 * `task.agentId._id`, `.name` and `.avatar`. A listing that handed back a bare
 * string would type-check on both sides and render an empty card. Hence
 * {@link AgentSessionListing}, which is deliberately a different type from
 * {@link AgentSessionRecord} rather than a widened one.
 *
 * What that object carries from SQL is now `_id` and `oxy_account_id` only: the
 * name, the handle and the avatar are the bot account's, so the ROUTE fills
 * them in with one batched Oxy call (`attachAgentIdentities`) rather than this
 * query joining columns that no longer exist.
 *
 * ## Deleting an agent does NOT delete its sessions
 *
 * `agent_sessions.agent_id` carries no foreign key (see the schema), so a
 * session survives its agent and its `agentId` dangles. Every listing therefore
 * LEFT joins `agents` and answers `agentId: null` — which is exactly what
 * `populate` did for a missing ref, and what `TaskSession.agentId` is already
 * typed to accept.
 */

import { and, asc, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../index';
import {
  agentSessionResources,
  agentSessions,
  type AgentSessionEventStreamEntry,
  type AgentSessionMessage,
  type AgentSessionPlanItem,
} from '../schema/agent-sessions';
import { agents } from '../schema/agents';
import { fundingSourceOf, type CreditFundingSource } from '../../domain/credit-funding';
import type {
  AgentSessionResourceStatus,
  AgentSessionResourceType,
  AgentSessionStatus,
} from '../../domain/agent-session';

type AgentSessionRow = typeof agentSessions.$inferSelect;
type AgentSessionResourceRow = typeof agentSessionResources.$inferSelect;

/** The plan, as `TodoManager.toJSON()` produces it and `loadFromPersisted` takes it. */
export interface AgentSessionPlan {
  objective: string;
  items: AgentSessionPlanItem[];
}

/**
 * What a session reserved, and against whom. Absent until credits are taken.
 *
 * Structurally `lib/credits-manager.ts`'s `CreditReservation`, so a session
 * reloaded from the queue settles or refunds through the same functions the
 * request that took the reservation would have. It is declared here rather than
 * imported because `db/` does not depend on `lib/`; `grantKind`'s type comes
 * from `domain/`, which is a leaf both layers may read.
 */
export interface AgentSessionCreditReservation {
  userId: string;
  creditsReserved: number;
  initialFreeCredits: number;
  initialPaidCredits: number;
  /**
   * DERIVED on the way out, not stored.
   *
   * `fundingSourceOf` decides it from the free balance left after the spend,
   * which is exactly `credit_reservation_initial_free_credits` — so the verdict
   * is recoverable from the row and no column is added for it. Persisting it
   * would create a second authority for a value that already has one, free to
   * disagree with the columns beside it.
   */
  grantKind: CreditFundingSource;
}

export interface AgentSessionStats {
  totalTokens: number;
  totalSteps: number;
  creditsCharged: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lastActivityAt: Date | null;
}

export interface AgentSessionConfig {
  maxSteps: number;
  maxTokens: number;
  maxVMs: number;
}

/** A VM or container the session claimed. */
export interface AgentSessionResource {
  _id: string;
  type: AgentSessionResourceType;
  resourceId: string;
  ip: string | null;
  previewUrl: string | null;
  status: AgentSessionResourceStatus;
  createdAt: Date;
}

/** A session in the shape the API and the runner have always seen. */
export interface AgentSessionRecord {
  _id: string;
  id: string;
  agentId: string;
  oxyUserId: string;
  parentSessionId: string | null;
  status: AgentSessionStatus;
  task: string;
  result: string | null;
  /** ABSENT until a plan is created, and cleared as a unit — see the CHECK. */
  plan?: AgentSessionPlan;
  messages: AgentSessionMessage[];
  eventStream: AgentSessionEventStreamEntry[];
  /** ABSENT when the session took no credits. */
  creditReservation?: AgentSessionCreditReservation;
  stats: AgentSessionStats;
  config: AgentSessionConfig;
  depth: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The agent an `agentId` object stands for, before identity is attached.
 *
 * `oxyAccountId` is what a caller feeds to `attachAgentIdentities`; nothing
 * renderable is here, deliberately, so a route that forgets to hydrate produces
 * an obviously empty card rather than a plausible wrong one.
 */
export interface AgentSessionAgentRef {
  _id: string;
  oxyAccountId: string;
}

/** A session as the task listings render it. See the file comment. */
export interface AgentSessionListing {
  _id: string;
  agentId: AgentSessionAgentRef | null;
  status: AgentSessionStatus;
  task: string;
  result: string | null;
  plan?: AgentSessionPlan;
  stats: AgentSessionStats;
  createdAt: Date;
}

function toPlan(row: Pick<AgentSessionRow, 'planObjective' | 'planItems'>): AgentSessionPlan | undefined {
  // The CHECK keeps the pair together, so either column answers the question.
  if (row.planObjective === null || row.planItems === null) return undefined;
  return { objective: row.planObjective, items: row.planItems };
}

function toStats(row: AgentSessionRow): AgentSessionStats {
  return {
    totalTokens: row.statsTotalTokens,
    totalSteps: row.statsTotalSteps,
    creditsCharged: row.statsCreditsCharged,
    startedAt: row.statsStartedAt,
    completedAt: row.statsCompletedAt,
    lastActivityAt: row.statsLastActivityAt,
  };
}

function toCreditReservation(row: AgentSessionRow): AgentSessionCreditReservation | undefined {
  // `default: undefined` in Mongoose, so the group is absent or whole. The
  // account id is the member every writer sets first, and it is `notNull` in
  // every write path here, so it is the one the absence test reads.
  if (row.creditReservationOxyUserId === null) return undefined;
  const initialFreeCredits = row.creditReservationInitialFreeCredits ?? 0;
  return {
    userId: row.creditReservationOxyUserId,
    creditsReserved: row.creditReservationCreditsReserved ?? 0,
    initialFreeCredits,
    initialPaidCredits: row.creditReservationInitialPaidCredits ?? 0,
    grantKind: fundingSourceOf(initialFreeCredits),
  };
}

export function toAgentSessionRecord(row: AgentSessionRow): AgentSessionRecord {
  return {
    _id: row.id,
    id: row.id,
    agentId: row.agentId,
    oxyUserId: row.oxyUserId,
    parentSessionId: row.parentSessionId,
    status: row.status as AgentSessionStatus,
    task: row.task,
    result: row.result,
    plan: toPlan(row),
    messages: row.messages,
    eventStream: row.eventStream,
    creditReservation: toCreditReservation(row),
    stats: toStats(row),
    config: {
      maxSteps: row.configMaxSteps,
      maxTokens: row.configMaxTokens,
      maxVMs: row.configMaxVms,
    },
    depth: row.depth,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toResource(row: AgentSessionResourceRow): AgentSessionResource {
  return {
    _id: row.id,
    type: row.type as AgentSessionResourceType,
    resourceId: row.resourceId,
    ip: row.ip,
    previewUrl: row.previewUrl,
    status: row.status as AgentSessionResourceStatus,
    createdAt: row.createdAt,
  };
}

/* ------------------------------ reads ------------------------------ */

export async function findAgentSessionById(
  db: Executor,
  id: string,
): Promise<AgentSessionRecord | null> {
  const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  return row ? toAgentSessionRecord(row) : null;
}

/**
 * A session owned by a named account.
 *
 * The ownership predicate is in the WHERE and not in the caller: five routes
 * addressed a session as `{_id, userId}` and one that fetched by id and compared
 * afterwards is one edit away from serving somebody else's task history.
 */
export async function findAgentSessionOwnedBy(
  db: Executor,
  id: string,
  oxyUserId: string,
): Promise<AgentSessionRecord | null> {
  const [row] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.oxyUserId, oxyUserId)))
    .limit(1);
  return row ? toAgentSessionRecord(row) : null;
}

/**
 * The session's status, and nothing else.
 *
 * The runner asks this once per iteration purely to notice a cancellation
 * (`runner.ts`'s loop head). Loading the whole row would pull the event-stream
 * `jsonb` — which is the largest column in the table and grows all run — over
 * the wire on every step.
 */
export async function findAgentSessionStatus(
  db: Executor,
  id: string,
): Promise<AgentSessionStatus | null> {
  const [row] = await db
    .select({ status: agentSessions.status })
    .from(agentSessions)
    .where(eq(agentSessions.id, id))
    .limit(1);
  return row ? (row.status as AgentSessionStatus) : null;
}

/** Does this account own this session? A BOOLEAN, never the row. */
export async function agentSessionIsOwnedBy(
  db: Executor,
  id: string,
  oxyUserId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ ok: sql<number>`1` })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.oxyUserId, oxyUserId)))
    .limit(1);
  return row !== undefined;
}

/** Has this account ever run this agent? The socket-room permission gate. */
export async function accountHasSessionWithAgent(
  db: Executor,
  agentId: string,
  oxyUserId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ ok: sql<number>`1` })
    .from(agentSessions)
    .where(and(eq(agentSessions.agentId, agentId), eq(agentSessions.oxyUserId, oxyUserId)))
    .limit(1);
  return row !== undefined;
}

const AGENT_REF = {
  _id: agents.id,
  oxyAccountId: agents.oxyAccountId,
} as const;

const LISTING_COLUMNS = {
  _id: agentSessions.id,
  status: agentSessions.status,
  task: agentSessions.task,
  result: agentSessions.result,
  planObjective: agentSessions.planObjective,
  planItems: agentSessions.planItems,
  statsTotalTokens: agentSessions.statsTotalTokens,
  statsTotalSteps: agentSessions.statsTotalSteps,
  statsCreditsCharged: agentSessions.statsCreditsCharged,
  statsStartedAt: agentSessions.statsStartedAt,
  statsCompletedAt: agentSessions.statsCompletedAt,
  statsLastActivityAt: agentSessions.statsLastActivityAt,
  createdAt: agentSessions.createdAt,
  agent: AGENT_REF,
} as const;

function toListing(row: {
  _id: string;
  status: string;
  task: string;
  result: string | null;
  planObjective: string | null;
  planItems: AgentSessionPlanItem[] | null;
  statsTotalTokens: number;
  statsTotalSteps: number;
  statsCreditsCharged: number | null;
  statsStartedAt: Date | null;
  statsCompletedAt: Date | null;
  statsLastActivityAt: Date | null;
  createdAt: Date;
  agent: AgentSessionAgentRef | null;
}): AgentSessionListing {
  return {
    _id: row._id,
    /**
     * A LEFT join over a column with NO foreign key: null means the agent was
     * deleted out from under the session, which is representable here and which
     * `populate` also answered with null. drizzle nulls the whole nested object
     * rather than each of its members, so there is no partial-object case to
     * reject — and `TaskSession.agentId` is already typed to accept it.
     */
    agentId: row.agent,
    status: row.status as AgentSessionStatus,
    task: row.task,
    result: row.result,
    plan: toPlan({ planObjective: row.planObjective, planItems: row.planItems }),
    stats: {
      totalTokens: row.statsTotalTokens,
      totalSteps: row.statsTotalSteps,
      creditsCharged: row.statsCreditsCharged,
      startedAt: row.statsStartedAt,
      completedAt: row.statsCompletedAt,
      lastActivityAt: row.statsLastActivityAt,
    },
    createdAt: row.createdAt,
  };
}

/** One agent's sessions for one account, newest first. */
export async function listAgentSessionsForOwner(
  db: Executor,
  agentId: string,
  oxyUserId: string,
  limit: number,
): Promise<AgentSessionListing[]> {
  const rows = await db
    .select(LISTING_COLUMNS)
    .from(agentSessions)
    .leftJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(and(eq(agentSessions.agentId, agentId), eq(agentSessions.oxyUserId, oxyUserId)))
    .orderBy(desc(agentSessions.createdAt))
    .limit(limit);
  return rows.map(toListing);
}

/** The account's queued and running sessions. */
export async function listActiveAgentSessions(
  db: Executor,
  oxyUserId: string,
  limit: number,
): Promise<AgentSessionListing[]> {
  const rows = await db
    .select(LISTING_COLUMNS)
    .from(agentSessions)
    .leftJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(
      and(
        eq(agentSessions.oxyUserId, oxyUserId),
        inArray(agentSessions.status, ['queued', 'running']),
      ),
    )
    .orderBy(desc(agentSessions.createdAt))
    .limit(limit);
  return rows.map(toListing);
}

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/**
 * The account's finished sessions, newest completion first.
 *
 * `stats.completedAt` is nullable and Mongo sorted `{'stats.completedAt': -1,
 * createdAt: -1}`, which put missing values LAST — Mongo sorts null before
 * everything on ascending, so descending puts it after. Postgres defaults the
 * other way (`NULLS FIRST` on DESC), so `nulls last` is spelled out; without it
 * a cancelled session that never completed would head the page.
 */
export async function listAgentSessionHistory(
  db: Executor,
  oxyUserId: string,
  page: { limit: number; offset: number },
): Promise<{ sessions: AgentSessionListing[]; total: number }> {
  const where = and(
    eq(agentSessions.oxyUserId, oxyUserId),
    inArray(agentSessions.status, [...TERMINAL_STATUSES]),
  );
  const [rows, [counted]] = await Promise.all([
    db
      .select(LISTING_COLUMNS)
      .from(agentSessions)
      .leftJoin(agents, eq(agentSessions.agentId, agents.id))
      .where(where)
      .orderBy(sql`${agentSessions.statsCompletedAt} desc nulls last`, desc(agentSessions.createdAt))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(agentSessions).where(where),
  ]);
  return { sessions: rows.map(toListing), total: counted?.total ?? 0 };
}

/** A delegating session's children, with the agent each one ran. */
export interface AgentSessionChild {
  parentSessionId: string;
  agent: AgentSessionAgentRef;
}

/**
 * The children of a page of sessions, in ONE query.
 *
 * `attachChildAgents` walked the page and issued a `$in` — the same call shape,
 * kept, because the alternative is a query per row. A child whose agent has been
 * deleted is DROPPED rather than reported with a null agent: the caller renders
 * a row of avatars, and `TaskSession.childAgents[]` is not nullable.
 *
 * ## The ORDER BY is not decoration — the caller renders this array
 *
 * `packages/app/components/tasks/task-card.tsx:69` iterates `task.childAgents`
 * to draw a row of avatars, so the order is on screen. An `inArray` with no
 * `ORDER BY` lets Postgres return rows however the plan happens to produce
 * them, and the tasks list polls every ten seconds — the visible symptom is
 * avatars silently reshuffling between polls, which reads as a rendering glitch
 * rather than as a query with no ordering.
 *
 * Delegation order is what the card means, so it is `created_at`, with `id` as
 * the tiebreak: `created_at` is truncated to milliseconds, and two children
 * delegated in the same millisecond would otherwise tie and reintroduce exactly
 * the non-determinism this removes.
 */
export async function listChildAgentSessions(
  db: Executor,
  parentSessionIds: string[],
  oxyUserId: string,
): Promise<AgentSessionChild[]> {
  if (parentSessionIds.length === 0) return [];
  const rows = await db
    .select({ parentSessionId: agentSessions.parentSessionId, agent: AGENT_REF })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(
      and(
        inArray(agentSessions.parentSessionId, parentSessionIds),
        eq(agentSessions.oxyUserId, oxyUserId),
      ),
    )
    .orderBy(asc(agentSessions.createdAt), asc(agentSessions.id));
  return rows.flatMap((row) =>
    row.parentSessionId === null
      ? []
      : [
          {
            parentSessionId: row.parentSessionId,
            agent: { _id: row.agent._id, oxyAccountId: row.agent.oxyAccountId },
          },
        ],
  );
}

/** The newest session of an agent in any of the given states. */
export async function findLatestAgentSession(
  db: Executor,
  agentId: string,
  statuses: readonly AgentSessionStatus[],
): Promise<{ _id: string } | null> {
  if (statuses.length === 0) return null;
  const [row] = await db
    .select({ _id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.agentId, agentId), inArray(agentSessions.status, [...statuses])))
    .orderBy(desc(agentSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/** Every unfinished session of one agent — the ones a status change cancels. */
export async function listUnfinishedAgentSessions(
  db: Executor,
  agentId: string,
): Promise<AgentSessionRecord[]> {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(
      and(eq(agentSessions.agentId, agentId), inArray(agentSessions.status, ['queued', 'running'])),
    );
  return rows.map(toAgentSessionRecord);
}

/**
 * Sessions per calendar day, for the activity heat map.
 *
 * Grouped in SQL rather than in JavaScript, which is what the `$dateToString`
 * aggregation did. The date is rendered in UTC explicitly: `to_char` over a
 * `timestamptz` uses the SESSION time zone, so an unqualified version would put
 * a session in a different square depending on which server answered.
 */
export async function countAgentSessionsByDay(
  db: Executor,
  agentId: string,
  since: Date,
): Promise<Array<{ date: string; count: number }>> {
  const rows = await db
    .select({
      date: sql<string>`to_char(${agentSessions.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(agentSessions)
    .where(and(eq(agentSessions.agentId, agentId), gte(agentSessions.createdAt, since)))
    .groupBy(sql`1`);
  return rows;
}

/** The subset of a session the audit export joins onto its events. */
export interface AuditSessionRef {
  _id: string;
  agentId: string;
  task: string;
  status: AgentSessionStatus;
  stats: AgentSessionStats;
}

/** The account's sessions, optionally one agent's, optionally within a window. */
export async function listAgentSessionsForAudit(
  db: Executor,
  oxyUserId: string,
  filter: { agentId?: string; from?: Date; to?: Date },
): Promise<AuditSessionRef[]> {
  const clauses: SQL[] = [eq(agentSessions.oxyUserId, oxyUserId)];
  if (filter.agentId !== undefined) clauses.push(eq(agentSessions.agentId, filter.agentId));
  // `lte()`, not `sql\`… <= ${date}\``. A bare `Date` interpolated into a drizzle
  // `sql` template reaches postgres.js unmapped and throws at BIND time — the
  // operator carries the column's own mapper, so it serialises correctly.
  if (filter.from !== undefined) clauses.push(gte(agentSessions.createdAt, filter.from));
  if (filter.to !== undefined) clauses.push(lte(agentSessions.createdAt, filter.to));
  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(...clauses));
  return rows.map((row) => ({
    _id: row.id,
    agentId: row.agentId,
    task: row.task,
    status: row.status as AgentSessionStatus,
    stats: toStats(row),
  }));
}

/* ------------------------------ writes ------------------------------ */

export interface CreateAgentSessionInput {
  agentId: string;
  oxyUserId: string;
  task: string;
  parentSessionId?: string;
  status?: AgentSessionStatus;
  depth?: number;
  messages?: AgentSessionMessage[];
  creditReservation?: AgentSessionCreditReservation;
  config?: Partial<AgentSessionConfig>;
}

export async function createAgentSession(
  db: Executor,
  input: CreateAgentSessionInput,
): Promise<AgentSessionRecord> {
  const [row] = await db
    .insert(agentSessions)
    .values({
      agentId: input.agentId,
      oxyUserId: input.oxyUserId,
      task: input.task,
      parentSessionId: input.parentSessionId ?? null,
      ...(input.status !== undefined && { status: input.status }),
      ...(input.depth !== undefined && { depth: input.depth }),
      ...(input.messages !== undefined && { messages: input.messages }),
      ...(input.creditReservation !== undefined && {
        creditReservationOxyUserId: input.creditReservation.userId,
        creditReservationCreditsReserved: input.creditReservation.creditsReserved,
        creditReservationInitialFreeCredits: input.creditReservation.initialFreeCredits,
        creditReservationInitialPaidCredits: input.creditReservation.initialPaidCredits,
      }),
      ...(input.config?.maxSteps !== undefined && { configMaxSteps: input.config.maxSteps }),
      ...(input.config?.maxTokens !== undefined && { configMaxTokens: input.config.maxTokens }),
      ...(input.config?.maxVMs !== undefined && { configMaxVms: input.config.maxVMs }),
    })
    .returning();
  return toAgentSessionRecord(row);
}

/**
 * What a caller may change about a running session.
 *
 * `plan: null` CLEARS both plan columns, which the CHECK requires and which
 * `runner.ts` does when it finds a malformed plan. `plan: undefined` means "do
 * not touch" — `$set: {x: undefined}` is a no-op in Mongo and writes NULL here,
 * so the two have to stay distinguishable and the SET clause is built from
 * DEFINED keys only.
 */
export interface UpdateAgentSessionInput {
  status?: AgentSessionStatus;
  result?: string;
  plan?: AgentSessionPlan | null;
  eventStream?: AgentSessionEventStreamEntry[];
  stats?: Partial<AgentSessionStats>;
}

function buildSessionPatch(input: UpdateAgentSessionInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.status !== undefined) patch.status = input.status;
  if (input.result !== undefined) patch.result = input.result;
  if (input.plan !== undefined) {
    patch.planObjective = input.plan === null ? null : input.plan.objective;
    patch.planItems = input.plan === null ? null : input.plan.items;
  }
  if (input.eventStream !== undefined) patch.eventStream = input.eventStream;
  const stats = input.stats;
  if (stats !== undefined) {
    if (stats.totalTokens !== undefined) patch.statsTotalTokens = stats.totalTokens;
    if (stats.totalSteps !== undefined) patch.statsTotalSteps = stats.totalSteps;
    if (stats.creditsCharged !== undefined) patch.statsCreditsCharged = stats.creditsCharged;
    if (stats.startedAt !== undefined) patch.statsStartedAt = stats.startedAt;
    if (stats.completedAt !== undefined) patch.statsCompletedAt = stats.completedAt;
    if (stats.lastActivityAt !== undefined) patch.statsLastActivityAt = stats.lastActivityAt;
  }
  return patch;
}

/**
 * Patch a session. Returns the matched count, never the row.
 *
 * `rowCount` behaves like Mongo's `matchedCount` rather than `modifiedCount`, so
 * a patch that changes nothing still reports one — which is what every caller
 * here wants, since they all already hold the values they just wrote.
 */
export async function updateAgentSession(
  db: Executor,
  id: string,
  input: UpdateAgentSessionInput,
): Promise<number> {
  const patch = buildSessionPatch(input);
  if (Object.keys(patch).length === 0) return 0;
  const updated = await db
    .update(agentSessions)
    .set(patch)
    .where(eq(agentSessions.id, id))
    .returning({ id: agentSessions.id });
  return updated.length;
}

/**
 * Cancel a session that has not already settled.
 *
 * The status predicate is in the STATEMENT, which is what makes this safe to
 * call from an executor's timeout handler: the run it is trying to stop may have
 * completed between the timeout firing and this landing, and a read-then-write
 * would overwrite a real result with `cancelled`. Returns whether it landed.
 */
/**
 * A queued session this old was claimed by no worker.
 *
 * A BullMQ job is picked up in seconds and the no-Redis fallback runs the
 * session in-process immediately, so this is orders of magnitude beyond the
 * normal wait — it is a cutoff for "the process that enqueued this is gone",
 * not for "the queue is busy".
 */
const QUEUED_ORPHAN_AFTER_MS = 30 * 60 * 1000;

/** A stranded session and what it reserved, as the reclaim sweep needs them. */
export interface ClaimedOrphanedAgentSession {
  readonly id: string;
  readonly creditReservation: AgentSessionCreditReservation | undefined;
}

/**
 * Fail every session left in `queued` past the cutoff, and RETURN what each one
 * reserved.
 *
 * The UPDATE is the claim. Every API task runs the sweep at boot and a deploy
 * starts several at once; a `SELECT` followed by a refund would let two of them
 * read the same row and pay it twice, while a statement that moves the row out
 * of `queued` returns it to exactly one caller. This is `failOrphanedAudioJobs`
 * with a `RETURNING`, and the `RETURNING` is the whole difference: an audio job
 * only needed marking, a session's reservation has to be handed back.
 *
 * `now` is a parameter so a test can place the cutoff without waiting.
 */
export async function claimOrphanedQueuedAgentSessions(
  db: Executor,
  now: Date = new Date(),
): Promise<ClaimedOrphanedAgentSession[]> {
  const cutoff = new Date(now.getTime() - QUEUED_ORPHAN_AFTER_MS);
  const rows = await db
    .update(agentSessions)
    .set({ status: 'failed', result: 'Session was never picked up by a worker' })
    .where(and(eq(agentSessions.status, 'queued'), lt(agentSessions.createdAt, cutoff)))
    .returning();

  return rows.map((row) => ({ id: row.id, creditReservation: toCreditReservation(row) }));
}

export async function cancelUnsettledAgentSession(
  db: Executor,
  id: string,
  result: string,
): Promise<boolean> {
  const updated = await db
    .update(agentSessions)
    .set({ status: 'cancelled', result })
    .where(
      and(
        eq(agentSessions.id, id),
        inArray(agentSessions.status, ['queued', 'running', 'cancelled']),
      ),
    )
    .returning({ id: agentSessions.id });
  return updated.length > 0;
}

/* ---------------------------- resources ---------------------------- */

export async function listAgentSessionResources(
  db: Executor,
  sessionId: string,
): Promise<AgentSessionResource[]> {
  const rows = await db
    .select()
    .from(agentSessionResources)
    .where(eq(agentSessionResources.sessionId, sessionId))
    .orderBy(asc(agentSessionResources.createdAt));
  return rows.map(toResource);
}

/**
 * Claim a resource for a session, once.
 *
 * `runner.ts` and `tools.ts` both checked `resources.some(...)` before pushing,
 * which is a read-then-write two concurrent tool calls can both pass — Mongo
 * could not index inside a sub-document array, so that check was the only guard
 * there was. `ON CONFLICT DO NOTHING` makes it structural, and RETURNING
 * distinguishes "inserted" from "already there" without a second read.
 *
 * A real infrastructure failure still propagates, which is the reason this is
 * not a `catch` around a duplicate-key error: Postgres cannot tell a duplicate
 * from a dropped connection inside a `catch`.
 */
export async function claimAgentSessionResource(
  db: Executor,
  sessionId: string,
  resource: { type: AgentSessionResourceType; resourceId: string; ip?: string },
): Promise<AgentSessionResource | null> {
  const [row] = await db
    .insert(agentSessionResources)
    .values({
      sessionId,
      type: resource.type,
      resourceId: resource.resourceId,
      ip: resource.ip ?? null,
    })
    .onConflictDoNothing({
      target: [agentSessionResources.sessionId, agentSessionResources.resourceId],
    })
    .returning();
  return row ? toResource(row) : null;
}

/**
 * How many resources of a session are still active — the `maxVMs` gate.
 *
 * A COUNT rather than a filter over an in-memory list, which is what the
 * hydrated document gave `tools.ts`: that list was read once when the session was
 * loaded and never refreshed, so two tool calls in one run both saw the count
 * from before either of them created anything and both passed the limit.
 */
export async function countActiveAgentSessionResources(
  db: Executor,
  sessionId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(agentSessionResources)
    .where(
      and(
        eq(agentSessionResources.sessionId, sessionId),
        eq(agentSessionResources.status, 'active'),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Is this container active in THIS session? A boolean, never the row.
 *
 * Eight tools ask it before touching a container, and every one of them was
 * asking "did my own session claim this id" — which is the only thing standing
 * between a tool call and another session's sandbox, since the container id
 * comes from the model.
 */
export async function agentSessionHasActiveResource(
  db: Executor,
  sessionId: string,
  resourceId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ ok: sql<number>`1` })
    .from(agentSessionResources)
    .where(
      and(
        eq(agentSessionResources.sessionId, sessionId),
        eq(agentSessionResources.resourceId, resourceId),
        eq(agentSessionResources.status, 'active'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Mark one claimed resource destroyed. Returns whether a row matched. */
export async function markAgentSessionResourceDestroyed(
  db: Executor,
  sessionId: string,
  resourceId: string,
): Promise<boolean> {
  const updated = await db
    .update(agentSessionResources)
    .set({ status: 'destroyed' })
    .where(
      and(
        eq(agentSessionResources.sessionId, sessionId),
        eq(agentSessionResources.resourceId, resourceId),
      ),
    )
    .returning({ id: agentSessionResources.id });
  return updated.length > 0;
}

/** Record the public preview URL a port exposure produced. */
export async function setAgentSessionResourcePreviewUrl(
  db: Executor,
  sessionId: string,
  resourceId: string,
  previewUrl: string,
): Promise<boolean> {
  const updated = await db
    .update(agentSessionResources)
    .set({ previewUrl })
    .where(
      and(
        eq(agentSessionResources.sessionId, sessionId),
        eq(agentSessionResources.resourceId, resourceId),
      ),
    )
    .returning({ id: agentSessionResources.id });
  return updated.length > 0;
}

/**
 * Destroy every still-active resource of a session, in one statement.
 *
 * Returns the resource ids it changed, so the caller can tell the sandbox
 * provider about exactly those — `cleanupSessionResources` used to iterate the
 * embedded array and set each element, which cannot express "only the ones that
 * were active when I asked".
 */
export async function markAllAgentSessionResourcesDestroyed(
  db: Executor,
  sessionId: string,
): Promise<string[]> {
  const updated = await db
    .update(agentSessionResources)
    .set({ status: 'destroyed' })
    .where(
      and(
        eq(agentSessionResources.sessionId, sessionId),
        eq(agentSessionResources.status, 'active'),
      ),
    )
    .returning({ resourceId: agentSessionResources.resourceId });
  return updated.map((row) => row.resourceId);
}

/**
 * The container a session's workspace lives in.
 *
 * `routes/agents/files.ts` wants the one container it can serve files from, and
 * took the first resource whose status was `active` or `idle` — `idle` is not a
 * value `agent_session_resources.status` can hold (the CHECK admits `active` and
 * `destroyed` only), so that half of the predicate matched nothing and is not
 * carried. Recorded rather than silently dropped: it reads like a narrowing.
 */
export async function findAgentSessionContainerId(
  db: Executor,
  sessionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ resourceId: agentSessionResources.resourceId })
    .from(agentSessionResources)
    .where(
      and(
        eq(agentSessionResources.sessionId, sessionId),
        eq(agentSessionResources.type, 'container'),
        eq(agentSessionResources.status, 'active'),
      ),
    )
    .orderBy(asc(agentSessionResources.createdAt))
    .limit(1);
  return row?.resourceId ?? null;
}
