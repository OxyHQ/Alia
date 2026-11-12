import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index';
import { agents } from '../schema/agents';
import { agentWorkAuthorities, agentWorkItems } from '../schema/agent-work';
import { agentSessions } from '../schema/agent-sessions';
import {
  claimHeartbeat,
  takeInboxItems,
  type AgentInboxItemRow,
  type HeartbeatCandidate,
} from './agentInboxRepository';

export async function findWorkAuthority(db: Executor, agentId: string, ownerAccountId: string) {
  const [row] = await db
    .select()
    .from(agentWorkAuthorities)
    .where(
      and(
        eq(agentWorkAuthorities.agentId, agentId),
        eq(agentWorkAuthorities.ownerAccountId, ownerAccountId),
      ),
    );
  return row ?? null;
}

/** Serialize admission for this actor, including across replicas. No network calls while held. */
export async function lockAgentWork(db: Executor, agentId: string) {
  await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update');
}

export async function hasActiveWork(db: Executor, agentId: string) {
  const [row] = await db
    .select({ id: agentWorkItems.id })
    .from(agentWorkItems)
    .where(
      and(
        eq(agentWorkItems.agentId, agentId),
        inArray(agentWorkItems.status, ['pending', 'running']),
        eq(agentWorkItems.kind, 'heartbeat'),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The acknowledgement and durable wake commit together, or neither does. */
export async function acceptHeartbeat(
  db: ApiDatabase,
  candidate: HeartbeatCandidate,
  now: Date,
  render: (items: AgentInboxItemRow[]) => string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockAgentWork(tx, candidate.agentId);
    const authority = await findWorkAuthority(tx, candidate.agentId, candidate.ownerAccountId);
    if (!authority || authority.expiresAt <= now || (await hasActiveWork(tx, candidate.agentId)))
      return false;
    const [pending] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, candidate.agentId),
          sql`exists (select 1 from agent_inbox_items where agent_id = ${candidate.agentId} and status = 'pending' and received_at >= ${new Date(now.getTime() - 3 * 86400000).toISOString()}::timestamptz)`,
        ),
      );
    if (!pending || !(await claimHeartbeat(tx, candidate, now))) return false;
    const items = await takeInboxItems(tx, candidate.agentId, now);
    if (!items.length) throw new Error('Heartbeat claim lost its pending events');
    const id = randomUUID();
    await tx.insert(agentWorkItems).values({
      id,
      rootId: id,
      agentId: candidate.agentId,
      ownerAccountId: candidate.ownerAccountId,
      oxyTaskId: authority.oxyTaskId,
      kind: 'heartbeat',
      dueAt: now,
      objective: render(items),
    });
    return true;
  });
}

export async function pendingWork(db: Executor, now: Date) {
  return db
    .select()
    .from(agentWorkItems)
    .where(
      and(
        eq(agentWorkItems.status, 'pending'),
        lte(agentWorkItems.dueAt, now),
        sql`not exists (select 1 from agent_sessions s where s.agent_id = ${agentWorkItems.agentId} and s.oxy_user_id = ${agentWorkItems.ownerAccountId} and s.status in ('queued', 'running'))`,
      ),
    )
    .orderBy(agentWorkItems.dueAt, agentWorkItems.id)
    .limit(100);
}

/** A future continuation remains associated with the original task and bounded history. */
export async function addAgentFollowUp(
  db: ApiDatabase,
  input: {
    agentId: string;
    ownerAccountId: string;
    sourceSessionId: string;
    at: Date;
    note: string;
  },
) {
  return db.transaction(async (tx) => {
    await lockAgentWork(tx, input.agentId);
    const [source] = await tx
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, input.sourceSessionId),
          eq(agentSessions.agentId, input.agentId),
          eq(agentSessions.oxyUserId, input.ownerAccountId),
        ),
      );
    if (!source?.oxyTaskId || source.oxyTaskRetiredAt) return null;
    const [agent] = await tx.select().from(agents).where(eq(agents.id, input.agentId));
    if (!agent || agent.status !== 'active') return null;
    const [parent] = await tx
      .select()
      .from(agentWorkItems)
      .where(eq(agentWorkItems.sessionId, source.id));
    if (parent && (parent.status === 'cancelled' || parent.status === 'failed')) return null;
    // A tool replay must not schedule the same continuation twice.
    const [existing] = await tx
      .select()
      .from(agentWorkItems)
      .where(
        and(
          eq(agentWorkItems.sourceSessionId, source.id),
          eq(agentWorkItems.dueAt, input.at),
          eq(agentWorkItems.objective, input.note),
        ),
      );
    if (existing) return existing;
    const pending = await tx
      .select({ id: agentWorkItems.id })
      .from(agentWorkItems)
      .where(
        and(
          eq(agentWorkItems.agentId, input.agentId),
          eq(agentWorkItems.kind, 'follow_up'),
          eq(agentWorkItems.status, 'pending'),
        ),
      );
    if (pending.length >= 5) return null;
    const id = randomUUID();
    const [created] = await tx
      .insert(agentWorkItems)
      .values({
        id,
        rootId: parent?.rootId ?? source.id,
        agentId: input.agentId,
        ownerAccountId: input.ownerAccountId,
        oxyTaskId: source.oxyTaskId,
        kind: 'follow_up',
        dueAt: input.at,
        objective: input.note,
        sourceSessionId: source.id,
      })
      .returning();
    return created;
  });
}

export async function listAgentWork(db: Executor, agentId: string) {
  return db
    .select({
      id: agentWorkItems.id,
      status: agentWorkItems.status,
      dueAt: agentWorkItems.dueAt,
      sessionId: agentWorkItems.sessionId,
      reason: agentWorkItems.failure,
    })
    .from(agentWorkItems)
    .where(eq(agentWorkItems.agentId, agentId))
    .orderBy(desc(agentWorkItems.createdAt))
    .limit(50);
}

export async function readAgentWorkState(db: Executor, agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.status !== 'active') return { state: 'paused' as const, reason: null };
  const work = await listAgentWork(db, agentId);
  if (work.some((row) => row.status === 'running'))
    return { state: 'working' as const, reason: null };
  const pending = work.find((row) => row.status === 'pending');
  if (pending?.reason) return { state: 'blocked' as const, reason: pending.reason };
  if (pending)
    return { state: 'scheduled' as const, reason: null, nextWakeAt: pending.dueAt.toISOString() };
  if (!agent.scheduleInterval) return { state: 'paused' as const, reason: null };
  const authority = agent.ownerOxyAccountId
    ? await findWorkAuthority(db, agentId, agent.ownerOxyAccountId)
    : null;
  if (!authority || authority.expiresAt <= new Date())
    return { state: 'blocked' as const, reason: 'needs_session' };
  const latest = work[0];
  if (latest?.status === 'failed')
    return { state: 'blocked' as const, reason: latest.reason ?? 'execution_failed' };
  return { state: 'waiting' as const, reason: null };
}
