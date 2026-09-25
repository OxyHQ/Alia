/**
 * Agent sessions, on Postgres.
 *
 * ## The runner mutates a DOCUMENT; this file exposes STATEMENTS
 *
 * `lib/agent/runner.ts` was written against a hydrated Mongoose document — it
 * assigns `session.status`, `session.stats.totalSteps` and calls `save()`
 * eleven times across one run. That
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
 * app reads `task.stats.totalTokens` (`packages/app/src/features/automations/runtime/use-tasks.ts:25`),
 * so {@link toAgentSessionRecord} regroups the flattened columns. The columns
 * stay flat because that is what a `WHERE stats_completed_at IS NULL` can index.
 *
 * ## `agentId` is an OBJECT in the two listings, and that is a response contract
 *
 * `populate('agentId', 'name handle avatar')` REPLACED the id with a document,
 * and `packages/app/src/features/automations/ui/task-card.tsx:66` reads
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
  agentSessions,
  type AgentSessionEventStreamEntry,
  type AgentSessionMessage,
  type AgentSessionPlanItem,
} from '../schema/agent-sessions';
import { agents } from '../schema/agents';
import { fundingSourceOf, type CreditFundingSource } from '../../domain/credit-funding';
import type { AgentSessionStatus } from '../../domain/agent-session';

type AgentSessionRow = typeof agentSessions.$inferSelect;

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

/** A session in the shape the API and the runner have always seen. */
export interface AgentSessionRecord {
  _id: string;
  id: string;
  agentId: string;
  oxyUserId: string;
  threadId: string | null;
  conversationId: string | null;
  goalId: string | null;
  generation: number;
  parentSessionId: string | null;
  automationRunId: string | null;
  automationStage: number | null;
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
  /**
   * The automation run this session executes a stage of, or null for a
   * session somebody started by hand. The Tasks page folds a run's sessions
   * under the automation they belong to rather than listing the same work
   * twice (#537), and this is the only column that says which.
   */
  automationRunId: string | null;
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
    threadId: row.threadId,
    conversationId: row.conversationId,
    goalId: row.goalId,
    generation: row.generation,
    parentSessionId: row.parentSessionId,
    automationRunId: row.automationRunId,
    automationStage: row.automationStage,
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
  automationRunId: agentSessions.automationRunId,
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
  automationRunId: string | null;
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
    automationRunId: row.automationRunId,
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
 * `packages/app/src/features/automations/ui/task-card.tsx:69` iterates `task.childAgents`
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

/**
 * The newest session THIS user has with an agent, in any of the given states.
 *
 * The scoped twin of `findLatestAgentSession`, and the one an HTTP route
 * should reach for. Agent sessions carry tool calls, tool results, file changes
 * and screenshots, and a published agent is run by many people — so "the
 * newest session of this agent" is, for a published agent, usually somebody
 * else's. `oxy_user_id` is on the row; nothing but the caller has to remember
 * to filter on it.
 */
export async function findLatestAgentSessionOwnedBy(
  db: Executor,
  agentId: string,
  oxyUserId: string,
  statuses: readonly AgentSessionStatus[],
): Promise<{ _id: string } | null> {
  if (statuses.length === 0) return null;
  const [row] = await db
    .select({ _id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.agentId, agentId),
        eq(agentSessions.oxyUserId, oxyUserId),
        inArray(agentSessions.status, [...statuses]),
      ),
    )
    .orderBy(desc(agentSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * There is deliberately no unscoped `findLatestAgentSession` here.
 *
 * There was one, and its only caller was `GET /agents/:id/activity` behind
 * `optionalAuth` — which is how an unauthenticated request for a published
 * agent came to return whoever had run it last. A function that answers "the
 * newest session of this agent, across every user" reads as harmless and is
 * one call site away from being a cross-tenant read, so it is gone rather than
 * commented: what nobody can import, nobody can misuse.
 */

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
  threadId?: string;
  conversationId?: string;
  goalId?: string;
  generation?: number;
  parentSessionId?: string;
  automationRunId?: string;
  automationStage?: number;
  status?: AgentSessionStatus;
  /** Explicit ownership lease for synchronous product-chat turns only. */
  chatLeaseExpiresAt?: Date;
  depth?: number;
  messages?: AgentSessionMessage[];
  creditReservation?: AgentSessionCreditReservation;
  config?: Partial<AgentSessionConfig>;
}

function agentSessionValues(input: CreateAgentSessionInput): typeof agentSessions.$inferInsert {
  return {
    agentId: input.agentId,
    oxyUserId: input.oxyUserId,
    task: input.task,
    threadId: input.threadId ?? null,
    conversationId: input.conversationId ?? null,
    goalId: input.goalId ?? null,
    ...(input.generation !== undefined && { generation: input.generation }),
    parentSessionId: input.parentSessionId ?? null,
    automationRunId: input.automationRunId ?? null,
    automationStage: input.automationStage ?? null,
    ...(input.status !== undefined && { status: input.status }),
    ...(input.chatLeaseExpiresAt !== undefined && { chatLeaseExpiresAt: input.chatLeaseExpiresAt }),
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
  };
}

export async function createAgentSession(
  db: Executor,
  input: CreateAgentSessionInput,
): Promise<AgentSessionRecord> {
  const [row] = await db
    .insert(agentSessions)
    .values(agentSessionValues(input))
    .returning();
  return toAgentSessionRecord(row);
}

/** Idempotently create the one session allowed to execute a run stage. */
export async function createAutomationStageSession(
  db: Executor,
  input: CreateAgentSessionInput & { automationRunId: string; automationStage: number },
): Promise<{ session: AgentSessionRecord; created: boolean }> {
  const [inserted] = await db.insert(agentSessions)
    .values(agentSessionValues(input))
    .onConflictDoNothing({
      target: [agentSessions.automationRunId, agentSessions.automationStage],
    })
    .returning();
  if (inserted) return { session: toAgentSessionRecord(inserted), created: true };
  const [existing] = await db.select().from(agentSessions).where(and(
    eq(agentSessions.automationRunId, input.automationRunId),
    eq(agentSessions.automationStage, input.automationStage),
  )).limit(1);
  if (!existing) throw new Error('Automation stage session conflict did not identify an existing row');
  return { session: toAgentSessionRecord(existing), created: false };
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
  chatLeaseExpiresAt?: Date | null;
  plan?: AgentSessionPlan | null;
  eventStream?: AgentSessionEventStreamEntry[];
  stats?: Partial<AgentSessionStats>;
}

function buildSessionPatch(input: UpdateAgentSessionInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.status !== undefined) patch.status = input.status;
  if (input.result !== undefined) patch.result = input.result;
  if (input.chatLeaseExpiresAt !== undefined) patch.chatLeaseExpiresAt = input.chatLeaseExpiresAt;
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

// ---------------------------------------------------------------------------
// Background run ownership
// ---------------------------------------------------------------------------

/**
 * How long a claim holds without renewal. The runner renews far more often
 * (`RUNNER_LEASE_RENEW_MS` in the runner), so only a worker that stopped —
 * crashed, killed by a deploy, wedged — lets it lapse.
 */
export const RUNNER_LEASE_MS = 90_000;

/** Claims after which a run that keeps losing its worker is failed, not retried. */
export const RUNNER_MAX_ATTEMPTS = 3;

export type AgentSessionRunClaim =
  | { readonly claimed: true; readonly session: AgentSessionRecord; readonly attempt: number }
  | { readonly claimed: false };

/**
 * Take ownership of a background run, or learn that somebody else holds it.
 *
 * One statement, so two workers handed the same session — BullMQ redelivering a
 * stalled job while the reaper re-enqueues it, say — cannot both win. Claimable
 * is `queued`, or `running` with no live owner: a lapsed lease, or none at all
 * (a row a worker was driving before leases existed). A synchronous chat turn
 * (`chat_lease_expires_at` set) belongs to its HTTP request and is never taken.
 */
export async function claimAgentSessionRun(
  db: Executor,
  id: string,
  owner: string,
  now: Date = new Date(),
): Promise<AgentSessionRunClaim> {
  const [row] = await db
    .update(agentSessions)
    .set({
      status: 'running',
      runnerLeaseOwner: owner,
      runnerLeaseExpiresAt: new Date(now.getTime() + RUNNER_LEASE_MS),
      runnerAttempts: sql`${agentSessions.runnerAttempts} + 1`,
      statsStartedAt: sql`coalesce(${agentSessions.statsStartedAt}, ${now.toISOString()}::timestamptz)`,
      statsLastActivityAt: now,
    })
    .where(and(
      eq(agentSessions.id, id),
      inArray(agentSessions.status, ['queued', 'running']),
      sql`${agentSessions.chatLeaseExpiresAt} is null`,
      sql`(${agentSessions.runnerLeaseExpiresAt} is null or ${agentSessions.runnerLeaseExpiresAt} < ${now.toISOString()}::timestamptz)`,
    ))
    .returning();
  if (!row) return { claimed: false };
  return { claimed: true, session: toAgentSessionRecord(row), attempt: row.runnerAttempts };
}

/**
 * Extend this worker's lease. `false` means the lease is no longer ours — it
 * lapsed and another worker claimed the run, or the run was settled or
 * cancelled — and the caller must stop driving it.
 */
export async function renewAgentSessionRunLease(
  db: Executor,
  id: string,
  owner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(agentSessions)
    .set({ runnerLeaseExpiresAt: new Date(now.getTime() + RUNNER_LEASE_MS) })
    .where(and(
      eq(agentSessions.id, id),
      eq(agentSessions.runnerLeaseOwner, owner),
      eq(agentSessions.status, 'running'),
    ))
    .returning({ id: agentSessions.id });
  return updated.length > 0;
}

/** Drop this worker's lease on a run it is leaving, settled or not. */
export async function releaseAgentSessionRunLease(db: Executor, id: string, owner: string): Promise<void> {
  await db
    .update(agentSessions)
    .set({ runnerLeaseOwner: null, runnerLeaseExpiresAt: null })
    .where(and(eq(agentSessions.id, id), eq(agentSessions.runnerLeaseOwner, owner)));
}

/** A run whose worker stopped renewing, as the reaper needs it. */
export interface LapsedAgentSessionRun {
  readonly id: string;
  readonly oxyUserId: string;
  readonly agentId: string;
  readonly attempts: number;
  readonly creditReservation: AgentSessionCreditReservation | undefined;
}

/** Background runs whose lease lapsed: nobody is driving them any more. */
export async function listLapsedAgentSessionRuns(
  db: Executor,
  now: Date = new Date(),
  limit = 100,
): Promise<LapsedAgentSessionRun[]> {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(
      eq(agentSessions.status, 'running'),
      sql`${agentSessions.runnerLeaseExpiresAt} is not null`,
      lt(agentSessions.runnerLeaseExpiresAt, now),
    ))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    oxyUserId: row.oxyUserId,
    agentId: row.agentId,
    attempts: row.runnerAttempts,
    creditReservation: toCreditReservation(row),
  }));
}

/**
 * Fail a run that has lost its worker too many times, and RETURN its hold.
 *
 * Conditional on the lease still being lapsed, so a worker that claimed it in
 * the meantime keeps it; the row is returned to exactly one caller, which is
 * the one that refunds.
 */
export async function failExhaustedAgentSessionRun(
  db: Executor,
  id: string,
  now: Date = new Date(),
): Promise<ClaimedOrphanedAgentSession | null> {
  const [row] = await db
    .update(agentSessions)
    .set({
      status: 'failed',
      result: 'The run was interrupted too many times and was stopped',
      runnerLeaseOwner: null,
      runnerLeaseExpiresAt: null,
      statsCompletedAt: now,
    })
    .where(and(
      eq(agentSessions.id, id),
      eq(agentSessions.status, 'running'),
      lt(agentSessions.runnerLeaseExpiresAt, now),
      sql`${agentSessions.runnerAttempts} >= ${RUNNER_MAX_ATTEMPTS}`,
    ))
    .returning();
  return row ? { id: row.id, creditReservation: toCreditReservation(row) } : null;
}
