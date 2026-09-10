import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index.js';
import {
  agentApprovalRequests,
  agentGoals,
  agentThreads,
  type AgentGoalCriterion,
} from '../schema/agent-runtime.js';
import { agentSessions } from '../schema/agent-sessions.js';

export type AgentThreadRow = typeof agentThreads.$inferSelect;

export async function createAgentThread(db: ApiDatabase, input: {
  oxyUserId: string;
  agentId: string;
  title: string;
  routingProfileId: string;
  approvalMode?: 'ask' | 'supervised_auto';
  executionTarget?: 'sandbox' | 'cowork';
  coworkDeviceId?: string;
  openedByAgentId?: string;
}): Promise<AgentThreadRow> {
  const executionTarget = input.executionTarget ?? 'sandbox';
  const [row] = await db.insert(agentThreads).values({
    oxyUserId: input.oxyUserId,
    agentId: input.agentId,
    title: input.title,
    routingProfileId: input.routingProfileId,
    approvalMode: input.approvalMode ?? 'ask',
    executionTarget,
    coworkDeviceId: executionTarget === 'cowork' ? input.coworkDeviceId : null,
    openedByAgentId: input.openedByAgentId ?? null,
  }).returning();
  if (!row) throw new Error('agent thread insert returned no row');
  return row;
}

export async function listAgentThreads(db: ApiDatabase, oxyUserId: string, agentId: string) {
  return db.select().from(agentThreads).where(and(
    eq(agentThreads.oxyUserId, oxyUserId),
    eq(agentThreads.agentId, agentId),
  )).orderBy(desc(agentThreads.updatedAt));
}

export async function findAgentThread(db: ApiDatabase, oxyUserId: string, threadId: string) {
  const [row] = await db.select().from(agentThreads).where(and(
    eq(agentThreads.id, threadId),
    eq(agentThreads.oxyUserId, oxyUserId),
  )).limit(1);
  return row;
}

export async function updateAgentThread(db: ApiDatabase, oxyUserId: string, threadId: string, patch: {
  title?: string;
  status?: 'open' | 'closed';
  approvalMode?: 'ask' | 'supervised_auto';
  executionTarget?: 'sandbox' | 'cowork';
  coworkDeviceId?: string | null;
}) {
  const [row] = await db.update(agentThreads).set({ ...patch, updatedAt: new Date() }).where(and(
    eq(agentThreads.id, threadId),
    eq(agentThreads.oxyUserId, oxyUserId),
  )).returning();
  return row;
}

export async function createAgentGoal(db: ApiDatabase, input: {
  threadId: string;
  oxyUserId: string;
  agentId: string;
  objective: string;
  criteria: AgentGoalCriterion[];
  verificationPlan: string;
  idempotencyKey: string;
  priceCredits: number;
}) {
  const [row] = await db.insert(agentGoals).values(input).onConflictDoNothing({
    target: [agentGoals.oxyUserId, agentGoals.idempotencyKey],
  }).returning();
  if (row) return { goal: row, created: true as const };
  const [existing] = await db.select().from(agentGoals).where(and(
    eq(agentGoals.oxyUserId, input.oxyUserId),
    eq(agentGoals.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (!existing) throw new Error('agent goal idempotency lookup returned no row');
  return { goal: existing, created: false as const };
}

export async function findPendingApproval(db: ApiDatabase, oxyUserId: string, approvalId: string) {
  const [row] = await db.select().from(agentApprovalRequests).where(and(
    eq(agentApprovalRequests.id, approvalId),
    eq(agentApprovalRequests.oxyUserId, oxyUserId),
    eq(agentApprovalRequests.status, 'pending'),
  )).limit(1);
  return row;
}

export type AgentApprovalRow = typeof agentApprovalRequests.$inferSelect;

export async function createAgentApprovalRequest(db: ApiDatabase, input: {
  id: string;
  turnId: string;
  threadId: string;
  oxyUserId: string;
  agentId: string;
  toolName: string;
  riskLevel: string;
  actionHash: string;
  resource?: string;
  summary: string;
  details: Record<string, unknown>;
  expiresAt: Date;
}): Promise<AgentApprovalRow> {
  const [inserted] = await db.insert(agentApprovalRequests).values(input).onConflictDoNothing({
    target: [agentApprovalRequests.turnId, agentApprovalRequests.actionHash],
  }).returning();
  if (inserted) return inserted;
  const [existing] = await db.select().from(agentApprovalRequests).where(and(
    eq(agentApprovalRequests.turnId, input.turnId),
    eq(agentApprovalRequests.actionHash, input.actionHash),
  )).limit(1);
  if (!existing) throw new Error('approval request conflict did not identify a row');
  return existing;
}

export async function findAgentApproval(db: ApiDatabase, approvalId: string) {
  const [row] = await db.select().from(agentApprovalRequests)
    .where(eq(agentApprovalRequests.id, approvalId)).limit(1);
  return row;
}

export async function decideAgentApproval(db: ApiDatabase, input: {
  approvalId: string;
  oxyUserId: string;
  approved: boolean;
}): Promise<AgentApprovalRow | undefined> {
  const now = new Date();
  const [row] = await db.update(agentApprovalRequests).set({
    status: input.approved ? 'approved' : 'denied',
    decidedByOxyUserId: input.oxyUserId,
    decidedAt: now,
    updatedAt: now,
  }).where(and(
    eq(agentApprovalRequests.id, input.approvalId),
    eq(agentApprovalRequests.oxyUserId, input.oxyUserId),
    eq(agentApprovalRequests.status, 'pending'),
  )).returning();
  return row;
}

export async function expireAgentApprovals(db: ApiDatabase, now = new Date()): Promise<string[]> {
  const rows = await db.update(agentApprovalRequests).set({ status: 'expired', updatedAt: now }).where(and(
    eq(agentApprovalRequests.status, 'pending'),
    lt(agentApprovalRequests.expiresAt, now),
  )).returning({ id: agentApprovalRequests.id });
  return rows.map((row) => row.id);
}

/** Serialize admission across API replicas; the callback must create the active session before returning. */
export async function withAgentAdmission<T>(
  db: ApiDatabase,
  agentId: string,
  maxConcurrentThreads: number,
  callback: (tx: Executor) => Promise<T>,
): Promise<{ admitted: true; value: T } | { admitted: false }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`alia-agent:${agentId}`}))`);
    // A process crash, deployment or lost socket can strand a session in
    // `running`. Without a lease expiry that row consumes concurrency forever;
    // every later chat turn is then rejected before inference and the client
    // can only put the message back in the composer. Active runners refresh
    // `statsLastActivityAt`, and chat turns have an 80s hard timeout, so five
    // quiet minutes is safely outside either live path.
    const staleBefore = new Date(Date.now() - 5 * 60_000);
    await tx.update(agentSessions).set({
      status: 'failed',
      result: 'Session lease expired before it could settle',
      statsCompletedAt: new Date(),
    }).where(and(
      eq(agentSessions.agentId, agentId),
      eq(agentSessions.status, 'running'),
      or(
        lt(agentSessions.statsLastActivityAt, staleBefore),
        and(isNull(agentSessions.statsLastActivityAt), lt(agentSessions.createdAt, staleBefore)),
      ),
    ));
    const [counted] = await tx.select({ count: sql<number>`count(*)::int` }).from(agentSessions).where(and(
      eq(agentSessions.agentId, agentId),
      inArray(agentSessions.status, ['queued', 'running']),
    ));
    if ((counted?.count ?? 0) >= maxConcurrentThreads) return { admitted: false as const };
    // The active row must be created on this transaction handle. Using the
    // root pool here can wait forever for a second connection under load and
    // also makes the admission count and insert two different transactions.
    return { admitted: true as const, value: await callback(tx) };
  });
}

export async function recordAgentGoalRun(db: ApiDatabase, input: {
  goalId: string;
  oxyUserId: string;
  status: 'candidate' | 'blocked' | 'cancelled';
  turnsUsed: number;
  tokensUsed: number;
}) {
  const now = new Date();
  const [row] = await db.update(agentGoals).set({
    status: input.status,
    turnsUsed: input.turnsUsed,
    tokensUsed: input.tokensUsed,
    noProgressTurns: input.status === 'candidate' ? 0 : 1,
    completedAt: null,
    updatedAt: now,
  }).where(and(eq(agentGoals.id, input.goalId), eq(agentGoals.oxyUserId, input.oxyUserId))).returning();
  return row;
}

export async function verifyAgentGoal(db: ApiDatabase, input: {
  goalId: string;
  oxyUserId: string;
  threadId: string;
  evidence: Array<{ criterionId: string; evidence: string }>;
}) {
  return db.transaction(async (tx) => {
    const [goal] = await tx.select().from(agentGoals).where(and(
      eq(agentGoals.id, input.goalId), eq(agentGoals.oxyUserId, input.oxyUserId), eq(agentGoals.threadId, input.threadId),
    )).limit(1);
    if (!goal || goal.status !== 'candidate') return undefined;
    const evidence = new Map(input.evidence.map((item) => [item.criterionId, item.evidence.trim()]));
    if (goal.criteria.some((criterion) => !evidence.get(criterion.id))) return undefined;
    const criteria = goal.criteria.map((criterion) => ({ ...criterion, met: true, evidence: evidence.get(criterion.id)! }));
    const now = new Date();
    const [updated] = await tx.update(agentGoals).set({ status: 'completed', criteria, completedAt: now, updatedAt: now })
      .where(and(eq(agentGoals.id, goal.id), eq(agentGoals.status, 'candidate'))).returning();
    return updated;
  });
}
