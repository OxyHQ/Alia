/**
 * An agent's inbox and subscriptions (ADR 0026).
 *
 * Every transition is one conditional statement, so N instances routing events or waking the same agent
 * never double-deliver an item or wake it twice in one interval.
 */

import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { agentInboxItems, agentSubscriptions } from '../schema/agent-runtime';
import { agents } from '../schema/agents';

type Executor = Pick<ApiDatabase, 'select' | 'insert' | 'update' | 'delete'>;

export interface AgentSubscriptionRow {
  id: string;
  agentId: string;
  ownerAccountId: string;
  sourceAccountId: string;
  appId: string;
  eventType: string;
  enabled: boolean;
}

export interface AgentInboxItemRow {
  id: string;
  agentId: string;
  ownerAccountId: string;
  appId: string;
  eventType: string;
  summary: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'dismissed';
  receivedAt: Date;
}

/** The most a stored summary may weigh. A projection is a few fields, never a body. */
export const INBOX_SUMMARY_MAX_BYTES = 2_048;

/** Subscriptions an agent may hold: a bound on routing fan-out per event. */
export const MAX_SUBSCRIPTIONS_PER_AGENT = 25;

/** Items one wake-up hands the agent. The rest wait for the next one. */
export const INBOX_ITEMS_PER_WAKE = 20;

/** Pending items older than this are dismissed instead of delivered: stale news is not news. */
export const INBOX_ITEM_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function capSummary(data: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(data);
  if (json.length <= INBOX_SUMMARY_MAX_BYTES) return data;
  // Keep whole small fields, drop what does not fit: a truncated JSON string is not JSON.
  const kept: Record<string, unknown> = {};
  let size = 2;
  for (const [key, value] of Object.entries(data)) {
    const part = JSON.stringify({ [key]: value }).length;
    if (size + part > INBOX_SUMMARY_MAX_BYTES) continue;
    kept[key] = value;
    size += part;
  }
  return kept;
}

/** Subscriptions that an event of `appId`/`eventType` on `sourceAccountId` matches. */
export async function matchingAgentSubscriptions(
  db: Executor,
  event: { accountId: string; appId: string; eventType: string },
): Promise<AgentSubscriptionRow[]> {
  return db
    .select()
    .from(agentSubscriptions)
    .where(
      and(
        eq(agentSubscriptions.sourceAccountId, event.accountId),
        eq(agentSubscriptions.enabled, true),
        inArray(agentSubscriptions.appId, [event.appId, '*']),
        inArray(agentSubscriptions.eventType, [event.eventType, '*']),
      ),
    );
}

/** Add an item to an agent's inbox. False: this event was already there. */
export async function addInboxItem(
  db: Executor,
  input: {
    agentId: string;
    ownerAccountId: string;
    appId: string;
    eventType: string;
    dedupeKey: string;
    summary: Record<string, unknown>;
    now?: Date;
  },
): Promise<boolean> {
  const rows = await db
    .insert(agentInboxItems)
    .values({
      agentId: input.agentId,
      ownerAccountId: input.ownerAccountId,
      appId: input.appId,
      eventType: input.eventType,
      dedupeKey: input.dedupeKey,
      summary: capSummary(input.summary),
      status: 'pending',
      ...(input.now ? { receivedAt: input.now } : {}),
    })
    .onConflictDoNothing({ target: [agentInboxItems.agentId, agentInboxItems.dedupeKey] })
    .returning({ id: agentInboxItems.id });
  return rows.length === 1;
}

export async function countPendingInboxItems(db: Executor, agentId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentInboxItems)
    .where(and(eq(agentInboxItems.agentId, agentId), eq(agentInboxItems.status, 'pending')));
  return row?.n ?? 0;
}

/**
 * The agent's items, NEWEST first, for the owner to read: with a cap, what is cut is the oldest, not
 * what just arrived. (Delivery to the agent is the other way round: `takeInboxItems` hands the
 * oldest first.)
 */
export async function listInboxItems(
  db: Executor,
  agentId: string,
  options: { status?: AgentInboxItemRow['status']; limit?: number } = {},
): Promise<AgentInboxItemRow[]> {
  const rows = await db
    .select()
    .from(agentInboxItems)
    .where(
      and(
        eq(agentInboxItems.agentId, agentId),
        ...(options.status ? [eq(agentInboxItems.status, options.status)] : []),
      ),
    )
    .orderBy(desc(agentInboxItems.receivedAt))
    .limit(options.limit ?? 100);
  return rows as AgentInboxItemRow[];
}

/**
 * Take up to `limit` pending items for one wake-up, marking them `delivered` in the same statement so a
 * concurrent heartbeat gets different ones (the rows it picks are locked with `SKIP LOCKED`). Items past {@link INBOX_ITEM_MAX_AGE_MS} are dismissed
 * first and never handed over.
 */
export async function takeInboxItems(
  db: Executor,
  agentId: string,
  now: Date,
  limit: number = INBOX_ITEMS_PER_WAKE,
): Promise<AgentInboxItemRow[]> {
  await db
    .update(agentInboxItems)
    .set({ status: 'dismissed' })
    .where(
      and(
        eq(agentInboxItems.agentId, agentId),
        eq(agentInboxItems.status, 'pending'),
        lt(agentInboxItems.receivedAt, new Date(now.getTime() - INBOX_ITEM_MAX_AGE_MS)),
      ),
    );
  // The rows this taker will hand over, locked. `ARRAY(…)` makes the pick an init plan, evaluated once:
  // inside `id IN (SELECT … FOR UPDATE SKIP LOCKED)` the planner may run the subquery again per row,
  // and each run skips more locked rows, so the LIMIT would no longer bound the total.
  const picked = db
    .select({ id: agentInboxItems.id })
    .from(agentInboxItems)
    .where(and(eq(agentInboxItems.agentId, agentId), eq(agentInboxItems.status, 'pending')))
    .orderBy(asc(agentInboxItems.receivedAt))
    .limit(limit)
    // A concurrent taker skips the rows this one has locked instead of waiting for them and taking
    // them too: `UPDATE … WHERE id IN (SELECT … LIMIT n)` evaluates the pick once from a snapshot, so
    // without the lock two heartbeats both handed over the same items.
    .for('update', { skipLocked: true });
  const taken = await db
    .update(agentInboxItems)
    .set({ status: 'delivered', deliveredAt: now })
    .where(
      and(
        sql`${agentInboxItems.id} = ANY (ARRAY(${picked}))`,
        // Rechecked against the row as it is once its lock is free, as a second line.
        eq(agentInboxItems.status, 'pending'),
      ),
    )
    .returning();
  return (taken as AgentInboxItemRow[]).sort(
    (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
  );
}

/** Put delivered items back: the wake-up they were handed to could not be scheduled. */
export async function returnInboxItems(db: Executor, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(agentInboxItems)
    .set({ status: 'pending', deliveredAt: null })
    .where(and(inArray(agentInboxItems.id, [...ids]), eq(agentInboxItems.status, 'delivered')));
}

/** Delivered and dismissed rows past their use. */
export async function purgeInboxItems(
  db: Executor,
  options: { now: Date; keepMs: number },
): Promise<void> {
  await db
    .delete(agentInboxItems)
    .where(
      and(
        inArray(agentInboxItems.status, ['delivered', 'dismissed']),
        lt(agentInboxItems.receivedAt, new Date(options.now.getTime() - options.keepMs)),
      ),
    );
}

export async function listAgentSubscriptions(
  db: Executor,
  agentId: string,
): Promise<AgentSubscriptionRow[]> {
  return db
    .select()
    .from(agentSubscriptions)
    .where(eq(agentSubscriptions.agentId, agentId))
    .orderBy(asc(agentSubscriptions.createdAt));
}

export async function countAgentSubscriptions(db: Executor, agentId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentSubscriptions)
    .where(eq(agentSubscriptions.agentId, agentId));
  return row?.n ?? 0;
}

/** Subscribe (or re-enable). Returns the row. */
export async function upsertAgentSubscription(
  db: Executor,
  input: Omit<AgentSubscriptionRow, 'id' | 'enabled'>,
): Promise<AgentSubscriptionRow> {
  const [row] = await db
    .insert(agentSubscriptions)
    .values({ ...input, enabled: true })
    .onConflictDoUpdate({
      target: [
        agentSubscriptions.agentId,
        agentSubscriptions.sourceAccountId,
        agentSubscriptions.appId,
        agentSubscriptions.eventType,
      ],
      set: { enabled: true, ownerAccountId: input.ownerAccountId },
    })
    .returning();
  if (!row) throw new Error('subscription was not stored');
  return row;
}

export async function deleteAgentSubscription(
  db: Executor,
  agentId: string,
  subscriptionId: string,
): Promise<boolean> {
  const rows = await db
    .delete(agentSubscriptions)
    .where(and(eq(agentSubscriptions.agentId, agentId), eq(agentSubscriptions.id, subscriptionId)))
    .returning({ id: agentSubscriptions.id });
  return rows.length === 1;
}

export interface HeartbeatCandidate {
  agentId: string;
  ownerAccountId: string;
  intervalMinutes: number;
  lastHeartbeatAt: Date | null;
}

/**
 * Active agents whose heartbeat is due AND that have something pending. The empty case is the common one and
 * costs this one query, no model call and no run.
 */
export async function dueHeartbeats(db: Executor, now: Date): Promise<HeartbeatCandidate[]> {
  const rows = await db
    .select({
      agentId: agents.id,
      ownerAccountId: agents.ownerOxyAccountId,
      intervalMinutes: agents.scheduleInterval,
      lastHeartbeatAt: agents.lastHeartbeatAt,
    })
    .from(agents)
    .where(
      and(
        eq(agents.isPublished, true),
        // `idle` and `offline` are how an owner pauses an agent: a paused agent is not woken.
        eq(agents.status, 'active'),
        sql`${agents.scheduleInterval} > 0`,
        sql`${agents.ownerOxyAccountId} is not null`,
        or(
          sql`${agents.lastHeartbeatAt} is null`,
          sql`${agents.lastHeartbeatAt} <= ${now.toISOString()}::timestamptz - (${agents.scheduleInterval} * interval '1 minute')`,
        ),
        sql`exists (select 1 from ${agentInboxItems} where ${agentInboxItems.agentId} = ${agents.id} and ${agentInboxItems.status} = 'pending')`,
      ),
    )
    .limit(200);
  return rows.flatMap((row) =>
    row.ownerAccountId && row.intervalMinutes
      ? [{ ...row, ownerAccountId: row.ownerAccountId, intervalMinutes: row.intervalMinutes }]
      : [],
  );
}

/**
 * Claim this agent's heartbeat: set `last_heartbeat_at` only if it is still what the caller read.
 * True for exactly one of several concurrent callers.
 */
export async function claimHeartbeat(
  db: Executor,
  candidate: HeartbeatCandidate,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({ lastHeartbeatAt: now })
    .where(
      and(
        eq(agents.id, candidate.agentId),
        candidate.lastHeartbeatAt === null
          ? sql`${agents.lastHeartbeatAt} is null`
          : eq(agents.lastHeartbeatAt, candidate.lastHeartbeatAt),
      ),
    )
    .returning({ id: agents.id });
  return rows.length === 1;
}

export interface HeartbeatState {
  /** The heartbeat in minutes; null when the agent has none. */
  intervalMinutes: number | null;
  /** When the heartbeat last woke it for its inbox; null when it never has. */
  lastHeartbeatAt: Date | null;
}

/** What the owner needs to read the inbox: how often the agent looks and when it last did. */
export async function findHeartbeatState(
  db: Executor,
  agentId: string,
): Promise<HeartbeatState | null> {
  const [row] = await db
    .select({ intervalMinutes: agents.scheduleInterval, lastHeartbeatAt: agents.lastHeartbeatAt })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row ?? null;
}
