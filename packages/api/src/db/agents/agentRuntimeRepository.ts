import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index.js';
import {
  agentApprovalRequests,
  agentGoals,
  agentThreads,
  type AgentGoalCriterion,
} from '../schema/agent-runtime.js';
import { agentSessions } from '../schema/agent-sessions.js';

export type AgentThreadRow = typeof agentThreads.$inferSelect;

export async function createAgentThread(
  db: ApiDatabase,
  input: {
    oxyUserId: string;
    agentId: string;
    title: string;
    /** The thread's `publisher/model`; null runs the owner's default. */
    modelId?: string | null;
    approvalMode?: 'ask' | 'supervised_auto';
    executionTarget?: 'sandbox' | 'cowork';
    coworkDeviceId?: string;
    openedByAgentId?: string;
  },
): Promise<AgentThreadRow> {
  const executionTarget = input.executionTarget ?? 'sandbox';
  const [row] = await db
    .insert(agentThreads)
    .values({
      oxyUserId: input.oxyUserId,
      agentId: input.agentId,
      title: input.title,
      modelId: input.modelId ?? null,
      approvalMode: input.approvalMode ?? 'ask',
      executionTarget,
      coworkDeviceId: executionTarget === 'cowork' ? input.coworkDeviceId : null,
      openedByAgentId: input.openedByAgentId ?? null,
    })
    .returning();
  if (!row) throw new Error('agent thread insert returned no row');
  return row;
}

export async function listAgentThreads(db: ApiDatabase, oxyUserId: string, agentId: string) {
  return db
    .select()
    .from(agentThreads)
    .where(and(eq(agentThreads.oxyUserId, oxyUserId), eq(agentThreads.agentId, agentId)))
    .orderBy(desc(agentThreads.updatedAt));
}

export async function findAgentThread(db: ApiDatabase, oxyUserId: string, threadId: string) {
  const [row] = await db
    .select()
    .from(agentThreads)
    .where(and(eq(agentThreads.id, threadId), eq(agentThreads.oxyUserId, oxyUserId)))
    .limit(1);
  return row;
}

export async function updateAgentThread(
  db: ApiDatabase,
  oxyUserId: string,
  threadId: string,
  patch: {
    title?: string;
    status?: 'open' | 'closed';
    approvalMode?: 'ask' | 'supervised_auto';
    executionTarget?: 'sandbox' | 'cowork';
    coworkDeviceId?: string | null;
  },
) {
  const [row] = await db
    .update(agentThreads)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(agentThreads.id, threadId), eq(agentThreads.oxyUserId, oxyUserId)))
    .returning();
  return row;
}

export async function createAgentGoal(
  db: ApiDatabase,
  input: {
    threadId: string;
    oxyUserId: string;
    agentId: string;
    objective: string;
    criteria: AgentGoalCriterion[];
    verificationPlan: string;
    idempotencyKey: string;
    priceCredits: number;
  },
) {
  const [row] = await db
    .insert(agentGoals)
    .values(input)
    .onConflictDoNothing({
      target: [agentGoals.oxyUserId, agentGoals.idempotencyKey],
    })
    .returning();
  if (row) return { goal: row, created: true as const };
  const [existing] = await db
    .select()
    .from(agentGoals)
    .where(
      and(
        eq(agentGoals.oxyUserId, input.oxyUserId),
        eq(agentGoals.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) throw new Error('agent goal idempotency lookup returned no row');
  return { goal: existing, created: false as const };
}

export async function findPendingApproval(db: ApiDatabase, oxyUserId: string, approvalId: string) {
  const [row] = await db
    .select()
    .from(agentApprovalRequests)
    .where(
      and(
        eq(agentApprovalRequests.id, approvalId),
        eq(agentApprovalRequests.oxyUserId, oxyUserId),
        eq(agentApprovalRequests.status, 'pending'),
      ),
    )
    .limit(1);
  return row;
}

export type AgentApprovalRow = typeof agentApprovalRequests.$inferSelect;

export async function createAgentApprovalRequest(
  db: ApiDatabase,
  input: {
    id: string;
    turnId: string;
    threadId: string | null;
    oxyUserId: string;
    /** Defaults to `agent`; `alia` requires `agentId: null`. */
    actorType?: 'alia' | 'agent';
    agentId: string | null;
    conversationId?: string | null;
    identityMode?: 'for_user' | 'self' | null;
    executionMode?: 'direct' | 'rerun';
    toolName: string;
    riskLevel: string;
    actionHash: string;
    resource?: string;
    summary: string;
    details: Record<string, unknown>;
    expiresAt: Date;
  },
): Promise<AgentApprovalRow> {
  const [inserted] = await db
    .insert(agentApprovalRequests)
    .values(input)
    .onConflictDoNothing({
      target: [agentApprovalRequests.turnId, agentApprovalRequests.actionHash],
    })
    .returning();
  if (inserted) return inserted;
  const [existing] = await db
    .select()
    .from(agentApprovalRequests)
    .where(
      and(
        eq(agentApprovalRequests.turnId, input.turnId),
        eq(agentApprovalRequests.actionHash, input.actionHash),
      ),
    )
    .limit(1);
  if (!existing) throw new Error('approval request conflict did not identify a row');
  return existing;
}

export async function findAgentApproval(db: ApiDatabase, approvalId: string) {
  const [row] = await db
    .select()
    .from(agentApprovalRequests)
    .where(eq(agentApprovalRequests.id, approvalId))
    .limit(1);
  return row;
}

/**
 * The person's answer, once: only a `pending`, unexpired request of THEIRS
 * moves. An approval stays claimable until `usableUntil`; after that it is
 * expired by the sweep and nothing can run it.
 */
export async function decideAgentApproval(
  db: ApiDatabase,
  input: {
    approvalId: string;
    oxyUserId: string;
    approved: boolean;
    usableUntil?: Date;
  },
  now = new Date(),
): Promise<AgentApprovalRow | undefined> {
  const [row] = await db
    .update(agentApprovalRequests)
    .set({
      status: input.approved ? 'approved' : 'denied',
      decidedByOxyUserId: input.oxyUserId,
      decidedAt: now,
      updatedAt: now,
      ...(input.approved && input.usableUntil ? { expiresAt: input.usableUntil } : {}),
    })
    .where(
      and(
        eq(agentApprovalRequests.id, input.approvalId),
        eq(agentApprovalRequests.oxyUserId, input.oxyUserId),
        eq(agentApprovalRequests.status, 'pending'),
        gt(agentApprovalRequests.expiresAt, now),
      ),
    )
    .returning();
  return row;
}

/** Requests nobody answered, and approvals nobody claimed in time. */
export async function expireAgentApprovals(db: ApiDatabase, now = new Date()): Promise<string[]> {
  const rows = await db
    .update(agentApprovalRequests)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        inArray(agentApprovalRequests.status, ['pending', 'approved']),
        lt(agentApprovalRequests.expiresAt, now),
      ),
    )
    .returning({ id: agentApprovalRequests.id });
  return rows.map((row) => row.id);
}

/**
 * Serialize admission across API replicas; the callback must create the active
 * session before returning.
 *
 * The limit is per PERSON with this agent, not per agent. Counted per agent, a
 * public agent with the default of 3 served three people in the whole world
 * and everybody else was told it was busy. A thread is one person with one
 * agent (ADR 0009), and `max_concurrent_threads` bounds how much of that
 * agent one person can keep busy at once.
 */
export async function withAgentAdmission<T>(
  db: ApiDatabase,
  admission: { agentId: string; oxyUserId: string },
  maxConcurrentThreads: number,
  callback: (tx: Executor) => Promise<T>,
): Promise<{ admitted: true; value: T } | { admitted: false }> {
  const { agentId, oxyUserId } = admission;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`alia-agent:${agentId}:${oxyUserId}`}))`,
    );
    // Reclaim only synchronous chat work whose explicit ownership lease has
    // expired. A generic `lastActivityAt` cutoff would be a guess and could
    // terminate legitimate autonomous work; NULL leases are deliberately not
    // eligible here.
    await tx
      .update(agentSessions)
      .set({
        status: 'failed',
        result: 'The chat request owning this turn ended before settlement',
        statsCompletedAt: new Date(),
      })
      .where(
        and(
          eq(agentSessions.agentId, agentId),
          eq(agentSessions.oxyUserId, oxyUserId),
          eq(agentSessions.status, 'running'),
          lt(agentSessions.chatLeaseExpiresAt, new Date()),
        ),
      );
    const [counted] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.agentId, agentId),
          eq(agentSessions.oxyUserId, oxyUserId),
          inArray(agentSessions.status, ['queued', 'running']),
        ),
      );
    if ((counted?.count ?? 0) >= maxConcurrentThreads) return { admitted: false as const };
    // The active row must be created on this transaction handle. Using the
    // root pool here can wait forever for a second connection under load and
    // also makes the admission count and insert two different transactions.
    return { admitted: true as const, value: await callback(tx) };
  });
}

export async function recordAgentGoalRun(
  db: ApiDatabase,
  input: {
    goalId: string;
    oxyUserId: string;
    status: 'candidate' | 'blocked' | 'cancelled';
    turnsUsed: number;
    tokensUsed: number;
  },
) {
  const now = new Date();
  const [row] = await db
    .update(agentGoals)
    .set({
      status: input.status,
      turnsUsed: input.turnsUsed,
      tokensUsed: input.tokensUsed,
      noProgressTurns: input.status === 'candidate' ? 0 : 1,
      completedAt: null,
      updatedAt: now,
    })
    .where(and(eq(agentGoals.id, input.goalId), eq(agentGoals.oxyUserId, input.oxyUserId)))
    .returning();
  return row;
}

export async function verifyAgentGoal(
  db: ApiDatabase,
  input: {
    goalId: string;
    oxyUserId: string;
    threadId: string;
    evidence: Array<{ criterionId: string; evidence: string }>;
  },
) {
  return db.transaction(async (tx) => {
    const [goal] = await tx
      .select()
      .from(agentGoals)
      .where(
        and(
          eq(agentGoals.id, input.goalId),
          eq(agentGoals.oxyUserId, input.oxyUserId),
          eq(agentGoals.threadId, input.threadId),
        ),
      )
      .limit(1);
    if (!goal || goal.status !== 'candidate') return undefined;
    const evidence = new Map(
      input.evidence.map((item) => [item.criterionId, item.evidence.trim()]),
    );
    if (goal.criteria.some((criterion) => !evidence.get(criterion.id))) return undefined;
    const criteria = goal.criteria.map((criterion) => ({
      ...criterion,
      met: true,
      evidence: evidence.get(criterion.id)!,
    }));
    const now = new Date();
    const [updated] = await tx
      .update(agentGoals)
      .set({ status: 'completed', criteria, completedAt: now, updatedAt: now })
      .where(and(eq(agentGoals.id, goal.id), eq(agentGoals.status, 'candidate')))
      .returning();
    return updated;
  });
}

/**
 * A granted, not yet claimed approval for exactly this action for this person
 * — what lets a background run perform what it asked for earlier. Matched on
 * the action hash, which names the actor, the identity, the tool, the input
 * and the resource, so a different action (or the same one by another actor)
 * is not covered.
 */
export async function findGrantedApproval(
  db: ApiDatabase,
  input: {
    oxyUserId: string;
    actionHash: string;
  },
  now = new Date(),
): Promise<AgentApprovalRow | undefined> {
  const [row] = await db
    .select()
    .from(agentApprovalRequests)
    .where(
      and(
        eq(agentApprovalRequests.oxyUserId, input.oxyUserId),
        eq(agentApprovalRequests.actionHash, input.actionHash),
        eq(agentApprovalRequests.status, 'approved'),
        gt(agentApprovalRequests.expiresAt, now),
      ),
    )
    .orderBy(desc(agentApprovalRequests.decidedAt))
    .limit(1);
  return row;
}

/**
 * Whether `turnId` already claimed an approval for this exact action: the run
 * started for one approval must not ask again for what it just did.
 */
export async function findClaimedApprovalInTurn(
  db: ApiDatabase,
  input: { turnId: string; actionHash: string },
): Promise<AgentApprovalRow | undefined> {
  const [row] = await db
    .select()
    .from(agentApprovalRequests)
    .where(
      and(
        eq(agentApprovalRequests.executedByTurnId, input.turnId),
        eq(agentApprovalRequests.actionHash, input.actionHash),
      ),
    )
    .limit(1);
  return row;
}

/**
 * THE claim: `approved` → `executing`, once. One conditional UPDATE, so two
 * runs, two replicas or two clicks cannot both get the row; `undefined` means
 * somebody else already has it (or it expired, or was never approved).
 */
export async function claimApprovalExecution(
  db: ApiDatabase,
  input: { approvalId: string; turnId: string },
  now = new Date(),
): Promise<AgentApprovalRow | undefined> {
  const [row] = await db
    .update(agentApprovalRequests)
    .set({
      status: 'executing',
      executedByTurnId: input.turnId,
      executionStartedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentApprovalRequests.id, input.approvalId),
        eq(agentApprovalRequests.status, 'approved'),
        gt(agentApprovalRequests.expiresAt, now),
      ),
    )
    .returning();
  return row;
}

/** How a claimed action ended. Only an `executing` row moves. */
export async function finishApprovalExecution(
  db: ApiDatabase,
  input: {
    approvalId: string;
    status: 'succeeded' | 'failed' | 'outcome_unknown';
    outcome: Record<string, unknown>;
  },
  now = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(agentApprovalRequests)
    .set({
      status: input.status,
      outcome: input.outcome,
      executionFinishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentApprovalRequests.id, input.approvalId),
        eq(agentApprovalRequests.status, 'executing'),
      ),
    )
    .returning({ id: agentApprovalRequests.id });
  return updated.length > 0;
}

/**
 * An approved action that can no longer be run as approved — its identity or
 * resource changed, its tool is gone — is closed, so it can never be claimed.
 */
export async function cancelApprovedAction(
  db: ApiDatabase,
  input: { approvalId: string; outcome: Record<string, unknown> },
  now = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(agentApprovalRequests)
    .set({ status: 'cancelled', outcome: input.outcome, updatedAt: now })
    .where(
      and(
        eq(agentApprovalRequests.id, input.approvalId),
        eq(agentApprovalRequests.status, 'approved'),
      ),
    )
    .returning({ id: agentApprovalRequests.id });
  return updated.length > 0;
}

/**
 * Claimed actions whose executor vanished (a restart, a killed task) before
 * it recorded how they ended. They may or may not have happened, so they
 * become `outcome_unknown` — terminal: nothing ever runs them again.
 */
export async function markStuckApprovalExecutions(
  db: ApiDatabase,
  startedBefore: Date,
  now = new Date(),
): Promise<AgentApprovalRow[]> {
  return db
    .update(agentApprovalRequests)
    .set({
      status: 'outcome_unknown',
      outcome: { reason: 'executor_lost' },
      executionFinishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentApprovalRequests.status, 'executing'),
        lt(agentApprovalRequests.executionStartedAt, startedBefore),
      ),
    )
    .returning();
}

/** A person's approvals still waiting on them, newest first. */
export async function listPendingApprovals(db: ApiDatabase, oxyUserId: string, now = new Date()) {
  return db
    .select()
    .from(agentApprovalRequests)
    .where(
      and(
        eq(agentApprovalRequests.oxyUserId, oxyUserId),
        eq(agentApprovalRequests.status, 'pending'),
        gt(agentApprovalRequests.expiresAt, now),
      ),
    )
    .orderBy(desc(agentApprovalRequests.createdAt))
    .limit(100);
}
