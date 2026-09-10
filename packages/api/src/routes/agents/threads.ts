import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import {
  createAgentGoal,
  createAgentThread,
  findAgentThread,
  listAgentThreads,
  updateAgentThread,
  withAgentAdmission,
  verifyAgentGoal,
} from '../../db/agents/agentRuntimeRepository.js';
import { agentGoals } from '../../db/schema/agent-runtime.js';
import { agentSessions } from '../../db/schema/agent-sessions.js';
import { createConversation, findActiveAgentThreadConversation } from '../../db/chat/conversationRepository.js';
import { canReachAgent } from '../../lib/agent-account.js';
import { startAgentSession } from '../../lib/agent/session-handoff.js';
import { authenticateToken } from '../../middleware/auth.js';
import { OXY_KAANA_ROUTING_PROFILE_ID_LIST } from '../../config/oxy-inference-routing-profile-ids.js';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { findOwnedCoworkDevice } from '../../db/agents/coworkDeviceRepository.js';

const router = Router();
const routingProfiles = new Set<string>(OXY_KAANA_ROUTING_PROFILE_ID_LIST);
const route = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };

async function reachableAgent(req: Request, res: Response) {
  const agent = await findAgentById(getDb(), String(req.params.id));
  if (!agent || !req.user?.id || await canReachAgent(agent, {
    oxyUserId: req.user.id,
    accessToken: req.accessToken,
    applicationId: req.serviceApp?.appId,
  }) !== 'reachable') {
    res.status(404).json({ error: 'Agent not found' });
    return null;
  }
  return agent;
}

router.get('/:id/threads', authenticateToken, route(async (req: Request, res: Response) => {
  const agent = await reachableAgent(req, res);
  if (!agent || !req.user?.id) return;
  const threads = await listAgentThreads(getDb(), req.user.id, agent._id);
  res.json({ threads });
}));

router.post('/:id/threads', authenticateToken, route(async (req: Request, res: Response) => {
  const agent = await reachableAgent(req, res);
  if (!agent || !req.user?.id) return;
  if (!agent.routingProfileId || !routingProfiles.has(agent.routingProfileId)) {
    return res.status(409).json({ error: 'Agent has no reviewed Oxy routing profile' });
  }

  const executionTarget = req.body?.executionTarget === 'cowork' ? 'cowork' : 'sandbox';
  const coworkDeviceId = typeof req.body?.coworkDeviceId === 'string' ? req.body.coworkDeviceId : undefined;
  if (executionTarget === 'cowork' && !coworkDeviceId) {
    return res.status(400).json({ error: 'coworkDeviceId is required for Cowork execution' });
  }
  if (executionTarget === 'cowork') {
    const device = await findOwnedCoworkDevice(getDb(), req.user.id, coworkDeviceId!);
    if (!device || device.status !== 'online') return res.status(409).json({ error: 'Cowork device is not online' });
  }
  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim().slice(0, 120)
    : 'New thread';

  const thread = await createAgentThread(getDb(), {
    oxyUserId: req.user.id,
    agentId: agent._id,
    title,
    routingProfileId: agent.routingProfileId,
    approvalMode: req.body?.approvalMode === 'supervised_auto' ? 'supervised_auto' : 'ask',
    executionTarget,
    coworkDeviceId,
  });
  const conversation = await createConversation(getDb(), {
    oxyUserId: req.user.id,
    conversationId: randomUUID(),
    title,
    source: 'app',
    agentId: agent._id,
    agentThreadId: thread.id,
  });
  res.status(201).json({ thread, conversationId: conversation.conversationId });
}));

router.get('/threads/:threadId', authenticateToken, route(async (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const thread = await findAgentThread(getDb(), req.user.id, String(req.params.threadId));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const conversation = await findActiveAgentThreadConversation(getDb(), req.user.id, thread.id);
  res.json({ thread, conversationId: conversation?.conversationId ?? null });
}));

router.patch('/threads/:threadId', authenticateToken, route(async (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const current = await findAgentThread(getDb(), req.user.id, String(req.params.threadId));
  if (!current) return res.status(404).json({ error: 'Thread not found' });
  const executionTarget = req.body?.executionTarget;
  const coworkDeviceId = typeof req.body?.coworkDeviceId === 'string' ? req.body.coworkDeviceId : null;
  if (executionTarget === 'cowork' && !coworkDeviceId) {
    return res.status(400).json({ error: 'coworkDeviceId is required for Cowork execution' });
  }
  if (executionTarget === 'cowork') {
    const device = await findOwnedCoworkDevice(getDb(), req.user.id, coworkDeviceId!);
    if (!device || device.status !== 'online') return res.status(409).json({ error: 'Cowork device is not online' });
  }
  const thread = await updateAgentThread(getDb(), req.user.id, current.id, {
    ...(typeof req.body?.title === 'string' ? { title: req.body.title.trim().slice(0, 120) } : {}),
    ...(req.body?.status === 'open' || req.body?.status === 'closed' ? { status: req.body.status } : {}),
    ...(req.body?.approvalMode === 'ask' || req.body?.approvalMode === 'supervised_auto'
      ? { approvalMode: req.body.approvalMode } : {}),
    ...(executionTarget === 'sandbox' || executionTarget === 'cowork'
      ? { executionTarget, coworkDeviceId: executionTarget === 'cowork' ? coworkDeviceId : null } : {}),
  });
  res.json({ thread });
}));

router.post('/threads/:threadId/goals', authenticateToken, route(async (req: Request, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const objective = typeof req.body?.objective === 'string' ? req.body.objective.trim() : '';
  if (!objective) return res.status(400).json({ error: 'objective is required' });
  const idempotencyKey = String(req.header('Idempotency-Key') ?? '').trim();
  if (!idempotencyKey) return res.status(400).json({ error: 'Idempotency-Key is required' });
  const thread = await findAgentThread(getDb(), req.user.id, String(req.params.threadId));
  if (!thread || thread.status !== 'open') return res.status(404).json({ error: 'Thread not found' });
  const agent = await findAgentById(getDb(), thread.agentId);
  if (!agent || agent.status !== 'active') return res.status(404).json({ error: 'Agent not found' });

  const supplied: string[] = Array.isArray(req.body?.criteria)
    ? req.body.criteria.filter((value: unknown): value is string => typeof value === 'string' && value.trim() !== '').slice(0, 5)
    : [];
  const criterionTexts = supplied.length >= 3 ? supplied : [
    `Deliver the requested outcome: ${objective.slice(0, 240)}`,
    'Verify the result with relevant checks and preserve their evidence.',
    'Report completed work, remaining limitations, and any required human action.',
  ];
  const created = await createAgentGoal(getDb(), {
    threadId: thread.id,
    oxyUserId: req.user.id,
    agentId: agent._id,
    objective,
    criteria: criterionTexts.map((text, index) => ({ id: `criterion-${index + 1}`, text, met: false })),
    verificationPlan: typeof req.body?.verificationPlan === 'string' && req.body.verificationPlan.trim()
      ? req.body.verificationPlan.trim()
      : 'Run the repository or domain checks relevant to the requested outcome and attach evidence.',
    idempotencyKey,
    priceCredits: agent.price ?? 0,
  });
  if (!created.created) {
    const [session] = await getDb().select().from(agentSessions).where(eq(agentSessions.goalId, created.goal.id)).limit(1);
    return res.json({ goal: created.goal, sessionId: session?.id ?? null, idempotent: true });
  }

  const admission = await withAgentAdmission(getDb(), agent._id, agent.maxConcurrentThreads, () =>
    startAgentSession({ agent, userId: req.user!.id, task: objective.slice(0, 2000), origin: 'hire' }),
  );
  if (!admission.admitted) {
    await getDb().update(agentGoals).set({ status: 'paused', updatedAt: new Date() }).where(eq(agentGoals.id, created.goal.id));
    return res.status(409).json({ error: 'Agent concurrency limit reached', goal: { ...created.goal, status: 'paused' } });
  }
  const handoff = admission.value;
  if (!handoff.ok) {
    await getDb().update(agentGoals).set({ status: 'cancelled', updatedAt: new Date() }).where(and(
      eq(agentGoals.id, created.goal.id), eq(agentGoals.oxyUserId, req.user.id),
    ));
    if (handoff.reason === 'insufficient_credits') {
      return res.status(402).json({ error: 'Insufficient credits', creditsNeeded: handoff.creditsNeeded });
    }
    return res.status(500).json({ error: 'Failed to start agent goal' });
  }
  await getDb().update(agentSessions).set({
    threadId: thread.id,
    goalId: created.goal.id,
  }).where(eq(agentSessions.id, handoff.sessionId));
  res.status(202).json({ goal: created.goal, sessionId: handoff.sessionId, queued: handoff.queued });
}));

router.post('/threads/:threadId/goals/:goalId/verify', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const thread = await findAgentThread(getDb(), req.user.id, String(req.params.threadId));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const raw = Array.isArray(req.body?.evidence) ? req.body.evidence : [];
  const evidence = raw.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    if (typeof value.criterionId !== 'string' || typeof value.evidence !== 'string' || !value.evidence.trim()) return [];
    return [{ criterionId: value.criterionId, evidence: value.evidence.slice(0, 4000) }];
  });
  const goal = await verifyAgentGoal(getDb(), {
    goalId: String(req.params.goalId), oxyUserId: req.user.id, threadId: thread.id, evidence,
  });
  if (!goal) return res.status(409).json({ error: 'Every completion criterion requires evidence from a candidate goal' });
  res.json({ goal });
}));

export default router;
