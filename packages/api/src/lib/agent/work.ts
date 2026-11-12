import cronParser from 'cron-parser';
import { automationDefinitions, automationRuns, automationActions } from '../../db/schema/agency';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/index';
import { agents } from '../../db/schema/agents';
import { agentGoals } from '../../db/schema/agent-runtime';
import { agentSessions } from '../../db/schema/agent-sessions';
import {
  agentWorkAuthorities,
  agentWorkItems,
  agentWorkRevocations,
} from '../../db/schema/agent-work';
import { findWorkAuthority, lockAgentWork, pendingWork } from '../../db/agents/agentWorkRepository';
import { findAgentById } from '../../db/agents/agentRepository';
import { createAgentSession } from '../../db/agents/agentSessionRepository';
import { withAgentAdmission } from '../../db/agents/agentRuntimeRepository';
import { createOxyTask, revokeOxyTask } from '../oxy-task-authority';
import { prepareBackgroundCreditReservation } from '../product-credit-access';
import { getOrCreateUserCredits } from '../user-credits-helpers';
import { enqueueAgentSession } from '../task-queue';
import { agentOpensOn } from '../agent-availability';
import { log } from '../logger';
import { agentHirePrice } from './session-handoff';

/** Only called from a verified, owner-present request. No bearer survives this call. */
export async function establishAgentWork(
  agentId: string,
  ownerAccountId: string,
  accessToken: string,
) {
  const db = getDb();
  const agent = await findAgentById(db, agentId);
  if (
    !agent ||
    agent.ownerOxyAccountId !== ownerAccountId ||
    agent.status !== 'active' ||
    !agent.scheduleInterval
  )
    return;
  const current = await findWorkAuthority(db, agentId, ownerAccountId);
  if (current && current.expiresAt > new Date()) {
    await migrateAgentWakeSchedules(agentId, ownerAccountId, current.oxyTaskId);
    return;
  }
  const taskId = await createOxyTask({
    accessToken,
    effectiveAccountId: ownerAccountId,
    actorAccountId: agent.oxyAccountId,
    origin: { kind: 'goal', id: `agent-work:${agentId}` },
  });
  let accepted = false;
  try {
    accepted = await db.transaction(async (tx) => {
      await lockAgentWork(tx, agentId);
      const [live] = await tx.select().from(agents).where(eq(agents.id, agentId));
      if (
        !live ||
        live.ownerOxyAccountId !== ownerAccountId ||
        live.status !== 'active' ||
        !live.scheduleInterval
      )
        return false;
      const winner = await findWorkAuthority(tx, agentId, ownerAccountId);
      if (winner && winner.expiresAt > new Date()) return false;
      if (winner)
        await tx
          .insert(agentWorkRevocations)
          .values({ oxyTaskId: winner.oxyTaskId })
          .onConflictDoNothing();
      await tx
        .insert(agentWorkAuthorities)
        .values({
          agentId,
          ownerAccountId,
          oxyTaskId: taskId,
          expiresAt: new Date(Date.now() + 365 * 86400000),
        })
        .onConflictDoUpdate({
          target: agentWorkAuthorities.agentId,
          set: {
            ownerAccountId,
            oxyTaskId: taskId,
            expiresAt: new Date(Date.now() + 365 * 86400000),
          },
        });
      return true;
    });
  } finally {
    if (!accepted) {
      await db.insert(agentWorkRevocations).values({ oxyTaskId: taskId }).onConflictDoNothing();
      await drainAgentWorkRevocations();
    }
  }
  if (accepted) await migrateAgentWakeSchedules(agentId, ownerAccountId, taskId);
}

/** Event batches and follow-ups use the existing durable runner, billing and tool policy. */
export async function dispatchAgentWork(now = new Date()): Promise<number> {
  const db = getDb();
  await retirePausedAgentWork();
  await drainAgentWorkRevocations();
  // Reconcile after a worker or notification process died. A terminal execution is never replayed.
  await db.execute(sql`update agent_work_items w set status = s.status, updated_at = now()
    from agent_sessions s where w.session_id = s.id and w.status = 'running'
    and s.status in ('completed', 'failed', 'cancelled')`);
  let started = 0;
  for (const work of await pendingWork(db, now)) {
    try {
      if (work.attempts >= 12 || now.getTime() - work.dueAt.getTime() > 3 * 86400000) {
        await db
          .update(agentWorkItems)
          .set({
            status: 'failed',
            failure: work.attempts >= 12 ? 'temporarily_unavailable' : 'expired',
            updatedAt: now,
          })
          .where(and(eq(agentWorkItems.id, work.id), eq(agentWorkItems.status, 'pending')));
        continue;
      }

      const agent = await findAgentById(db, work.agentId);
      if (
        !agent ||
        (!work.sourceSessionId && agent.ownerOxyAccountId !== work.ownerAccountId) ||
        agent.status !== 'active' ||
        (work.kind === 'heartbeat' && !agent.scheduleInterval)
      )
        continue;
      // The requester already authorized this durable task. A private agent does
      // not need the now-absent interactive bearer again; confinement stays live.
      if ((await agentOpensOn(agent.oxyAccountId, null)) !== 'reachable')
        throw new Error('Agent availability could not authorize this surface');
      await getOrCreateUserCredits(work.ownerAccountId);
      const reserve = await prepareBackgroundCreditReservation(
        work.ownerAccountId,
        agentHirePrice(agent),
      );
      const admission = await withAgentAdmission(
        db,
        { agentId: work.agentId, oxyUserId: work.ownerAccountId },
        1,
        async (tx) => {
          await lockAgentWork(tx, work.agentId);
          const [fresh] = await tx
            .select()
            .from(agentWorkItems)
            .where(eq(agentWorkItems.id, work.id))
            .for('update');
          if (!fresh || fresh.status !== 'pending' || fresh.dueAt > now) return null;
          const [live] = await tx.select().from(agents).where(eq(agents.id, work.agentId));
          if (
            !live ||
            live.status !== 'active' ||
            (!work.sourceSessionId && live.ownerOxyAccountId !== work.ownerAccountId) ||
            (work.kind === 'heartbeat' && !live.scheduleInterval)
          )
            return null;
          const source = work.sourceSessionId
            ? (
                await tx
                  .select()
                  .from(agentSessions)
                  .where(eq(agentSessions.id, work.sourceSessionId))
              )[0]
            : null;
          if (
            work.sourceSessionId &&
            (!source ||
              source.agentId !== work.agentId ||
              source.oxyUserId !== work.ownerAccountId ||
              source.oxyTaskId !== work.oxyTaskId ||
              source.oxyTaskRetiredAt)
          )
            return null;
          if (work.kind === 'heartbeat') {
            const authority = await findWorkAuthority(tx, work.agentId, work.ownerAccountId);
            if (
              !authority ||
              authority.oxyTaskId !== work.oxyTaskId ||
              authority.expiresAt <= now
            ) {
              await tx
                .update(agentWorkItems)
                .set({ status: 'failed', failure: 'needs_session', updatedAt: now })
                .where(eq(agentWorkItems.id, work.id));
              return null;
            }
          }
          if (source && ['queued', 'running'].includes(source.status)) return null;
          const [used] = await tx
            .select({
              steps: sql<number>`coalesce(sum(${agentSessions.statsTotalSteps}), 0)::int`,
              tokens: sql<number>`coalesce(sum(${agentSessions.statsTotalTokens}), 0)::int`,
            })
            .from(agentSessions)
            .where(
              sql`${agentSessions.id} = ${work.rootId} or ${agentSessions.id} in (select session_id from agent_work_items where root_id = ${work.rootId})`,
            );
          const maxSteps = 50 - (used?.steps ?? 0);
          const maxTokens = 100000 - (used?.tokens ?? 0);
          if (maxSteps <= 0 || maxTokens <= 0 || work.attempts >= 12) {
            await tx
              .update(agentWorkItems)
              .set({ status: 'failed', failure: 'work_limit_reached', updatedAt: now })
              .where(eq(agentWorkItems.id, work.id));
            return null;
          }
          const reservation = await reserve(tx);
          if (!reservation) {
            await tx
              .update(agentWorkItems)
              .set({
                attempts: fresh.attempts + 1,
                failure: 'insufficient_credits',
                dueAt: new Date(now.getTime() + 3600000),
                updatedAt: now,
              })
              .where(eq(agentWorkItems.id, work.id));
            return null;
          }
          const context = source
            ? `\nContinue your earlier work without repeating completed actions. Previous task and results are context:\n${JSON.stringify({ result: source.result?.slice(0, 8000), plan: (source.planItems ?? []).slice(0, 20).map((item) => ({ ...item, text: item.text.slice(0, 300) })) }).replace(/</g, '\\u003c')}`
            : '';
          const goals =
            work.kind === 'heartbeat'
              ? await tx
                  .select({ objective: agentGoals.objective, status: agentGoals.status })
                  .from(agentGoals)
                  .where(
                    and(
                      eq(agentGoals.agentId, work.agentId),
                      eq(agentGoals.oxyUserId, work.ownerAccountId),
                      inArray(agentGoals.status, ['active', 'blocked']),
                    ),
                  )
                  .orderBy(agentGoals.updatedAt)
                  .limit(5)
              : [];
          const currentWork = goals.length
            ? `\nYour unfinished goals (context; do not duplicate their existing runs):\n${JSON.stringify(goals.map((goal) => ({ ...goal, objective: goal.objective.slice(0, 1000) }))).replace(/</g, '\\u003c')}`
            : '';
          const session = await createAgentSession(tx, {
            id: randomUUID(),
            agentId: work.agentId,
            oxyUserId: work.ownerAccountId,
            oxyTaskId: work.oxyTaskId,
            task: work.objective + context + currentWork,
            status: 'queued',
            ...(source?.threadId ? { threadId: source.threadId } : {}),
            ...(source?.goalId ? { goalId: source.goalId } : {}),
            workItemId: work.id,
            creditReservation: reservation,
            config: { maxSteps, maxTokens },
          });
          await tx
            .update(agentWorkItems)
            .set({ status: 'running', sessionId: session.id, failure: null, updatedAt: now })
            .where(eq(agentWorkItems.id, work.id));
          return session;
        },
      );
      if (admission.admitted && admission.value) started++;
    } catch (err) {
      log.agents.error({ err, workId: work.id }, 'Agent work admission failed; retrying later');
      await db
        .update(agentWorkItems)
        .set({
          attempts: sql`${agentWorkItems.attempts} + 1`,
          dueAt: new Date(
            now.getTime() + Math.min(3600000, 60000 * 2 ** Math.min(work.attempts, 6)),
          ),
          failure: 'temporarily_unavailable',
          updatedAt: now,
        })
        .where(and(eq(agentWorkItems.id, work.id), eq(agentWorkItems.status, 'pending')));
    }
  }
  // The DB is the outbox: enqueue can fail or the process can die without losing this handoff.
  const queued = await db
    .select({ session: agentSessions })
    .from(agentWorkItems)
    .innerJoin(agentSessions, eq(agentSessions.id, agentWorkItems.sessionId))
    .where(
      and(
        inArray(agentWorkItems.status, ['running', 'cancelled']),
        eq(agentSessions.status, 'queued'),
      ),
    )
    .limit(100);
  for (const { session } of queued) {
    await enqueueAgentSession({
      sessionId: session.id,
      userId: session.oxyUserId,
      agentId: session.agentId,
      agentName: 'Agent',
    }).catch((err) => log.agents.warn({ err, sessionId: session.id }, 'Agent work remains queued'));
  }
  return started;
}

/** Cancel locally and persist revocation before any remote call, including on deletion. */
export async function stopAgentWork(agentId: string, onlyIfPaused = false): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await lockAgentWork(tx, agentId);
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId));
    const [authority] = await tx
      .select()
      .from(agentWorkAuthorities)
      .where(eq(agentWorkAuthorities.agentId, agentId));
    if (
      onlyIfPaused &&
      agent?.status === 'active' &&
      agent.scheduleInterval &&
      (!authority || agent.ownerOxyAccountId === authority.ownerAccountId)
    )
      return;
    await tx
      .update(agentWorkItems)
      .set({ status: 'cancelled', failure: 'paused', updatedAt: new Date() })
      .where(
        and(
          eq(agentWorkItems.agentId, agentId),
          inArray(agentWorkItems.status, ['pending', 'running']),
        ),
      );
    if (authority) {
      await tx
        .insert(agentWorkRevocations)
        .values({ oxyTaskId: authority.oxyTaskId })
        .onConflictDoNothing();
      await tx
        .delete(agentWorkAuthorities)
        .where(eq(agentWorkAuthorities.oxyTaskId, authority.oxyTaskId));
    }
  });
  await drainAgentWorkRevocations();
}

async function drainAgentWorkRevocations() {
  const db = getDb();
  const rows = await db
    .select()
    .from(agentWorkRevocations)
    .orderBy(agentWorkRevocations.createdAt)
    .limit(100);
  for (const row of rows) {
    try {
      await revokeOxyTask(row.oxyTaskId);
      await db
        .delete(agentWorkRevocations)
        .where(eq(agentWorkRevocations.oxyTaskId, row.oxyTaskId));
    } catch (err) {
      log.agents.warn({ err }, 'Agent work authority revocation will retry');
    }
  }
}

export async function autonomousWorkMayRun(sessionId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: agentWorkItems.id })
    .from(agentWorkItems)
    .innerJoin(agents, eq(agents.id, agentWorkItems.agentId))
    .where(
      and(
        eq(agentWorkItems.sessionId, sessionId),
        eq(agentWorkItems.status, 'running'),
        eq(agents.status, 'active'),
        sql`(${agentWorkItems.sourceSessionId} is not null or ${agents.ownerOxyAccountId} = ${agentWorkItems.ownerAccountId})`,
        sql`(${agentWorkItems.kind} <> 'heartbeat' or ${agents.scheduleInterval} > 0)`,
      ),
    );
  return Boolean(row);
}

/** Adopt only unexecuted internal one-shots. User automations and historical deliveries stay intact. */
async function migrateAgentWakeSchedules(agentId: string, ownerAccountId: string, taskId: string) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const definitions = await tx
      .select()
      .from(automationDefinitions)
      .where(
        and(
          eq(automationDefinitions.fixedAgentId, agentId),
          eq(automationDefinitions.ownerAccountId, ownerAccountId),
          eq(automationDefinitions.enabled, true),
          eq(automationDefinitions.triggerKind, 'schedule'),
          sql`${automationDefinitions.inputs}->>'origin' in ('agent_heartbeat', 'agent_follow_up')`,
          sql`${automationDefinitions.inputs}->>'runOnce' = 'true'`,
          sql`not exists (select 1 from ${automationActions} where ${automationActions.automationId} = ${automationDefinitions.id})`,
        ),
      )
      .for('update')
      .limit(100);
    for (const definition of definitions) {
      const [run] = await tx
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(eq(automationRuns.automationId, definition.id))
        .limit(1);
      if (run || !definition.scheduleCron) continue;
      const dueAt = cronParser
        .parseExpression(definition.scheduleCron, {
          currentDate: definition.createdAt,
          tz: definition.scheduleTimezone ?? 'UTC',
        })
        .next()
        .toDate();
      const id = `legacy-wake:${definition.id}`;
      // The old API allowed at most 90 days ahead. Do not turn a stale annual cron into new authority.
      const expired =
        dueAt.getTime() - definition.createdAt.getTime() > 90 * 86400000 ||
        dueAt.getTime() < Date.now() - 3 * 86400000;
      await tx
        .insert(agentWorkItems)
        .values({
          id,
          rootId: id,
          agentId,
          ownerAccountId,
          oxyTaskId: taskId,
          kind: 'follow_up',
          objective: definition.objective,
          dueAt,
          status: expired ? 'failed' : 'pending',
          failure: expired ? 'expired' : null,
        })
        .onConflictDoNothing();
      await tx
        .update(automationDefinitions)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(automationDefinitions.id, definition.id));
    }
  });
}

/** Retry remote revocation after a pause request lost its connection to Oxy. */
async function retirePausedAgentWork() {
  const rows = await getDb()
    .select({ agentId: agentWorkAuthorities.agentId })
    .from(agentWorkAuthorities)
    .innerJoin(agents, eq(agents.id, agentWorkAuthorities.agentId))
    .where(
      sql`${agents.status} <> 'active' or ${agents.scheduleInterval} is null or ${agents.ownerOxyAccountId} is distinct from ${agentWorkAuthorities.ownerAccountId}`,
    )
    .limit(100);
  for (const row of rows) {
    await stopAgentWork(row.agentId, true).catch((err) =>
      log.agents.warn({ err, agentId: row.agentId }, 'Agent work revocation will retry'),
    );
  }
}
