import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { TEST_CHARACTER } from '../../../db/__tests__/support/agent-character';

// Parallel pgdb files share a database; keep this global sweeper on this suite's rows.
const owners = vi.hoisted(() => new Set<string>());
vi.mock('../../../db/agents/agentWorkRepository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../db/agents/agentWorkRepository')>();
  return {
    ...original,
    pendingWork: async (...args: Parameters<typeof original.pendingWork>) =>
      (await original.pendingWork(...args)).filter((work) => owners.has(work.ownerAccountId)),
  };
});
vi.mock('../../agent-availability', () => ({ agentOpensOn: async () => 'reachable' }));
vi.mock('../../oxy-task-authority', () => ({
  createOxyTask: vi.fn(async () => randomUUID()),
  revokeOxyTask: vi.fn(async () => {}),
}));
vi.mock('../../agent-identity', () => ({
  attachAgentIdentity: async (agent: object) => ({
    ...agent,
    name: 'Eusebio',
    handle: 'eusebiobot',
  }),
  agentPromptName: () => 'Eusebio',
}));
vi.mock('../../notification-service', () => ({ sendNotification: vi.fn(async () => {}) }));
vi.mock('../../../socket', () => ({
  getIO: () => null,
  emitAgentActivity: vi.fn(),
  emitAliaActivity: vi.fn(),
}));
vi.mock('../../task-queue', () => ({ enqueueAgentSession: vi.fn(async () => ({ queued: true })) }));
vi.mock('../../user-credits-helpers', () => ({ getOrCreateUserCredits: async () => {} }));
vi.mock('../../product-credit-access', () => ({
  prepareBackgroundCreditReservation: async (userId: string, amount: number) => {
    const { reserveCredits } = await import('../../credits-manager');
    const { createCreditPriceBook } = await import('../../credit-price-snapshot');
    return (executor: import('../../../db/index').Executor) =>
      reserveCredits(userId, amount, {
        executor,
        priceBook: createCreditPriceBook([], 'catalogue_unavailable_base_rate'),
        requestedModel: 'background-product-work',
      });
  },
}));
import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index';
import { createAgent } from '../../../db/agents/agentRepository';
import * as sessions from '../../../db/agents/agentSessionRepository';
import { getOrCreateUserCredits } from '../../../db/billing/userCreditsRepository';
import { agents } from '../../../db/schema/agents';
import { userCredits } from '../../../db/schema/billing';
import { agentSessions } from '../../../db/schema/agent-sessions';
import {
  agentWorkAuthorities,
  agentWorkRevocations,
  agentWorkItems,
} from '../../../db/schema/agent-work';
import { createOxyTask, revokeOxyTask } from '../../oxy-task-authority';
import { enqueueAgentSession } from '../../task-queue';
import { autonomousWorkMayRun, dispatchAgentWork, stopAgentWork } from '../work';
import { createConversation } from '../../../db/chat/conversationRepository';
import { conversations, messages } from '../../../db/schema/chat';
import { AgentTurnCoordinator } from '../agent-turn-coordinator';
import { attachAgentIdentity } from '../../agent-identity';
import { buildRuntimeTools } from '../actions';
import { readCapabilityGrants } from '../../../domain/capability-grants';
import { scheduleChatFollowUp } from '../chat-follow-ups';
import { deliverAgentWorkResult } from '../work-delivery';
import * as outreach from '../agent-outreach';
import { sendNotification } from '../../notification-service';
import { addAgentFollowUp } from '../../../db/agents/agentWorkRepository';

let db: ApiDatabase;
beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('No test DB');
  db = connected;
});
afterAll(() => closePostgres());
beforeEach(() => vi.restoreAllMocks());
async function seed() {
  const owner = randomUUID();
  owners.add(owner);
  await getOrCreateUserCredits(db, owner);
  await db
    .update(userCredits)
    .set({ creditsFree: 100, creditsPaid: 0 })
    .where(eq(userCredits.id, owner));
  const agent = await createAgent(db, {
    character: TEST_CHARACTER,
    oxyAccountId: randomUUID(),
    ownerOxyAccountId: owner,
    authorOxyUserId: owner,
    tagline: 'test',
    description: 'test',
    category: 'research',
    price: 15,
    access: 'private',
    scheduleInterval: 60,
  });
  const id = randomUUID();
  const taskId = randomUUID();
  await db.insert(agentWorkAuthorities).values({
    agentId: agent.id,
    ownerAccountId: owner,
    oxyTaskId: taskId,
    expiresAt: new Date(Date.now() + 86400000),
  });
  await db.insert(agentWorkItems).values({
    id,
    rootId: id,
    agentId: agent.id,
    ownerAccountId: owner,
    oxyTaskId: taskId,
    kind: 'heartbeat',
    objective: 'Review new events',
    dueAt: new Date(),
  });
  return { id, owner, agent };
}
async function balance(owner: string) {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, owner));
  return row.creditsFree;
}

it('concurrent chat scheduling binds one authority and queues only the unused proof for revocation', async () => {
  const { owner, agent, id } = await seed();
  await db.delete(agentWorkItems).where(eq(agentWorkItems.id, id));
  const source = await sessions.createAgentSession(db, {
    agentId: agent.id,
    oxyUserId: owner,
    task: 'Say hello later',
    status: 'running',
    conversationId: randomUUID(),
    chatLeaseExpiresAt: new Date(Date.now() + 120_000),
  });
  let release!: () => void;
  const bothMinted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const candidates: string[] = [];
  vi.mocked(createOxyTask).mockImplementation(async () => {
    const task = randomUUID();
    candidates.push(task);
    if (candidates.length === 2) release();
    await bothMinted;
    return task;
  });
  const now = new Date();
  const input = {
    agentId: agent.id,
    agentAccountId: agent.oxyAccountId,
    ownerAccountId: owner,
    sourceSessionId: source.id,
    requesterToken: 'live-requester',
    now,
    at: new Date(now.getTime() + 300_000),
    note: 'Say hello',
  };
  try {
    const receipts = await Promise.all([scheduleChatFollowUp(input), scheduleChatFollowUp(input)]);
    expect(receipts[0]).toBe(receipts[1]);
    const work = await db.select().from(agentWorkItems).where(eq(agentWorkItems.agentId, agent.id));
    expect(work).toHaveLength(1);
    const unused = candidates.find((id) => id !== work[0].oxyTaskId)!;
    expect(
      await db
        .select()
        .from(agentWorkRevocations)
        .where(eq(agentWorkRevocations.oxyTaskId, unused)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(agentWorkRevocations)
        .where(eq(agentWorkRevocations.oxyTaskId, work[0].oxyTaskId)),
    ).toHaveLength(0);
  } finally {
    vi.mocked(createOxyTask).mockImplementation(async () => randomUUID());
    await stopAgentWork(agent.id);
    await sessions.updateAgentSession(db, source.id, { status: 'completed' });
  }
});

it('rolls back chat authority binding if the dated work insert fails', async () => {
  const { owner, agent } = await seed();
  const source = await sessions.createAgentSession(db, {
    agentId: agent.id,
    oxyUserId: owner,
    task: 'Hello later',
    status: 'running',
    conversationId: randomUUID(),
    chatLeaseExpiresAt: new Date(Date.now() + 120_000),
  });
  // Deliberately violate the database NOT NULL constraint after binding the proof.
  await expect(
    addAgentFollowUp(db, {
      agentId: agent.id,
      ownerAccountId: owner,
      sourceSessionId: source.id,
      chatAuthorityTaskId: randomUUID(),
      at: new Date(Date.now() + 300_000),
      note: null as unknown as string,
    }),
  ).rejects.toThrow();
  expect((await sessions.findAgentSessionById(db, source.id))?.oxyTaskId).toBeNull();
  await stopAgentWork(agent.id);
  await sessions.updateAgentSession(db, source.id, { status: 'completed' });
});

async function scheduledChat() {
  const { owner, agent, id } = await seed();
  await db.delete(agentWorkItems).where(eq(agentWorkItems.id, id));
  await db.delete(agentWorkAuthorities).where(eq(agentWorkAuthorities.agentId, agent.id));
  await db.update(agents).set({ scheduleInterval: null }).where(eq(agents.id, agent.id));
  const conversationId = randomUUID();
  await createConversation(db, {
    oxyUserId: owner,
    agentId: agent.id,
    conversationId,
    title: 'Eusebio',
    source: 'app',
  });
  const turn = await AgentTurnCoordinator.begin({
    agent: await attachAgentIdentity(agent),
    oxyUserId: owner,
    requesterToken: 'live-requester-token',
    conversationId,
    task: 'Salúdame en 5 minutos',
  });
  const tools = buildRuntimeTools({ ...turn.runtime, computer: null }, readCapabilityGrants([]));
  const before = Date.now();
  const receipt = await tools.scheduleFollowUp.execute?.(
    { delaySeconds: 300, note: 'Saluda al usuario en español' },
    { toolCallId: 'schedule', messages: [] },
  );
  expect(receipt).toMatch(/^Scheduled for /);
  // Replaying a relative delay later must reuse the first due time, not add another greeting.
  expect(
    await tools.scheduleFollowUp.execute?.(
      { delaySeconds: 300, note: 'Saluda al usuario en español' },
      { toolCallId: 'schedule', messages: [] },
    ),
  ).toBe(receipt);
  expect(
    await db.select().from(agentWorkItems).where(eq(agentWorkItems.agentId, agent.id)),
  ).toHaveLength(1);
  const [work] = await db.select().from(agentWorkItems).where(eq(agentWorkItems.agentId, agent.id));
  expect(work.deliveryMode).toBe('requested');
  expect(work.dueAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
  expect(work.dueAt.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
  expect(work.rootId).toBe(turn.id);
  expect(work.oxyTaskId).toBe((await sessions.findAgentSessionById(db, turn.id))?.oxyTaskId);
  expect(createOxyTask).toHaveBeenCalledWith(
    expect.objectContaining({
      accessToken: 'live-requester-token',
      effectiveAccountId: owner,
      actorAccountId: agent.oxyAccountId,
      origin: { kind: 'goal', id: turn.id },
    }),
  );
  expect(JSON.stringify(work)).not.toContain('live-requester-token');
  await turn.complete('Te saludaré en cinco minutos.');
  return { owner, agent, conversationId, work };
}

it('schedules from the actual chat tool, waits five minutes, and delivers once in the original thread', async () => {
  const { owner, agent, conversationId, work } = await scheduledChat();
  await dispatchAgentWork(new Date(work.dueAt.getTime() - 1));
  expect(
    await db.select().from(agentSessions).where(eq(agentSessions.agentId, agent.id)),
  ).toHaveLength(1);
  expect(await balance(owner)).toBe(100);
  await dispatchAgentWork(work.dueAt);
  const [running] = await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, work.id));
  expect(running.status).toBe('running');
  const session = await sessions.findAgentSessionById(db, running.sessionId!);
  expect(session?.conversationId).toBe(conversationId);
  expect(session?.oxyTaskId).toBe(work.oxyTaskId);

  // Another, newer conversation must not steal this requested result.
  await createConversation(db, {
    oxyUserId: owner,
    agentId: agent.id,
    conversationId: randomUUID(),
    title: 'Newer',
    source: 'app',
  });
  await outreach.postAgentMessage({
    oxyUserId: owner,
    agentId: agent.id,
    kind: 'check_in',
    content: 'Update one',
  });
  await outreach.postAgentMessage({
    oxyUserId: owner,
    agentId: agent.id,
    kind: 'check_in',
    content: 'Update two',
  });
  await sessions.updateAgentSession(db, running.sessionId!, {
    status: 'completed',
    result: '¡Hola! Aquí está tu saludo.',
  });
  await Promise.all([deliverAgentWorkResult(work.id), deliverAgentWorkResult(work.id)]);
  const delivered = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    content: '¡Hola! Aquí está tu saludo.',
    agentInfoId: agent.id,
  });
  expect(
    (await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, work.id)))[0].deliveredAt,
  ).not.toBeNull();
  expect(
    vi.mocked(sendNotification).mock.calls.filter(([n]) => n.conversationId === conversationId),
  ).toHaveLength(1);
  expect(await balance(owner)).toBe(85);
});

it('recovers a failed reply write without rerunning inference or reserving credits again', async () => {
  const { owner, work } = await scheduledChat();
  await dispatchAgentWork(work.dueAt);
  const [running] = await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, work.id));
  await sessions.updateAgentSession(db, running.sessionId!, {
    status: 'completed',
    result: '¡Hola!',
  });
  const post = vi
    .spyOn(outreach, 'postAgentMessage')
    .mockRejectedValueOnce(new Error('write unavailable'));
  await expect(deliverAgentWorkResult(work.id)).rejects.toThrow('write unavailable');
  expect(
    (await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, work.id)))[0].deliveredAt,
  ).toBeNull();
  post.mockRestore();
  await dispatchAgentWork(new Date(work.dueAt.getTime() + 60_000));
  expect(
    (await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, work.id)))[0].deliveredAt,
  ).not.toBeNull();
  expect(await balance(owner)).toBe(85);
});

it('never recreates a deleted originating conversation or sends its reply into another thread', async () => {
  const { conversationId, work, owner } = await scheduledChat();
  await dispatchAgentWork(work.dueAt);
  const [running] = await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, work.id));
  await sessions.updateAgentSession(db, running.sessionId!, {
    status: 'completed',
    result: '¡Hola!',
  });
  await db.delete(conversations).where(eq(conversations.conversationId, conversationId));
  await deliverAgentWorkResult(work.id);
  expect(await db.select().from(messages).where(eq(messages.oxyUserId, owner))).toHaveLength(0);
  expect(
    (await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, work.id)))[0],
  ).toMatchObject({ status: 'cancelled', failure: 'conversation_not_found', deliveredAt: null });
});

it('refuses a scheduling call for a different requester before minting authority', async () => {
  const { work, agent } = await scheduledChat();
  const count = vi.mocked(createOxyTask).mock.calls.length;
  const now = new Date();
  expect(
    await scheduleChatFollowUp({
      agentId: agent.id,
      agentAccountId: agent.oxyAccountId,
      ownerAccountId: randomUUID(),
      sourceSessionId: work.sourceSessionId!,
      requesterToken: 'other-requester',
      now,
      at: new Date(now.getTime() + 300_000),
      note: 'Wrong requester',
    }),
  ).toBe('Not scheduled (continuation_unavailable).');
  expect(vi.mocked(createOxyTask).mock.calls.length).toBe(count);
  await stopAgentWork(agent.id);
});
it('two dispatchers reserve once and persist one session, even when queue delivery fails', async () => {
  const { owner, agent, id } = await seed();
  vi.mocked(enqueueAgentSession).mockRejectedValueOnce(new Error('queue offline'));
  await Promise.all([dispatchAgentWork(), dispatchAgentWork()]);
  expect(await balance(owner)).toBe(85);
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.agentId, agent.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'queued', workItemId: id });
  await dispatchAgentWork();
  expect(await balance(owner)).toBe(85);
  expect(
    vi.mocked(enqueueAgentSession).mock.calls.some(([job]) => job.sessionId === rows[0].id),
  ).toBe(true);
  await stopAgentWork(agent.id);
});
it('rolls back the actual credit debit if session persistence fails', async () => {
  const { owner, agent, id } = await seed();
  vi.spyOn(sessions, 'createAgentSession').mockImplementationOnce(async () => {
    throw new Error('write interrupted');
  });
  await dispatchAgentWork();
  expect(await balance(owner)).toBe(100);
  expect(
    await db.select().from(agentSessions).where(eq(agentSessions.agentId, agent.id)),
  ).toHaveLength(0);
  const [work] = await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, id));
  expect(work).toMatchObject({
    status: 'pending',
    attempts: 1,
    failure: 'temporarily_unavailable',
    sessionId: null,
  });
  await stopAgentWork(agent.id);
});
it('a continuation cannot reset the original work budget', async () => {
  const { owner, agent, id } = await seed();
  const source = await sessions.createAgentSession(db, {
    agentId: agent.id,
    oxyUserId: owner,
    task: 'original',
    status: 'completed',
    oxyTaskId: randomUUID(),
  });
  await db
    .update(agentSessions)
    .set({ statsTotalSteps: 50 })
    .where(eq(agentSessions.id, source.id));
  await db
    .update(agentWorkItems)
    .set({
      rootId: source.id,
      sourceSessionId: source.id,
      oxyTaskId: source.oxyTaskId!,
      kind: 'follow_up',
    })
    .where(eq(agentWorkItems.id, id));
  await dispatchAgentWork();
  expect(await balance(owner)).toBe(100);
  const [work] = await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, id));
  expect(work).toMatchObject({ status: 'failed', failure: 'work_limit_reached', sessionId: null });
});
it('pausing stops already queued work before it can call inference', async () => {
  const { agent, id } = await seed();
  await dispatchAgentWork();
  const [work] = await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, id));
  expect(await autonomousWorkMayRun(work.sessionId!)).toBe(true);
  await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, agent.id));
  expect(await autonomousWorkMayRun(work.sessionId!)).toBe(false);
  await stopAgentWork(agent.id);
  expect(await autonomousWorkMayRun(work.sessionId!)).toBe(false);
});

it('persists cancellation and retries revocation after an Oxy outage', async () => {
  const { agent, id } = await seed();
  const [authority] = await db
    .select()
    .from(agentWorkAuthorities)
    .where(eq(agentWorkAuthorities.agentId, agent.id));
  const taskId = authority.oxyTaskId;
  vi.mocked(revokeOxyTask).mockRejectedValueOnce(new Error('Oxy unavailable'));
  await stopAgentWork(agent.id);
  const [work] = await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, id));
  expect(work.status).toBe('cancelled');
  expect(
    await db.select().from(agentWorkAuthorities).where(eq(agentWorkAuthorities.agentId, agent.id)),
  ).toHaveLength(0);
  expect(
    await db.select().from(agentWorkRevocations).where(eq(agentWorkRevocations.oxyTaskId, taskId)),
  ).toHaveLength(1);
  await dispatchAgentWork();
  expect(
    await db.select().from(agentWorkRevocations).where(eq(agentWorkRevocations.oxyTaskId, taskId)),
  ).toHaveLength(0);
});

it('preserves a hiring requester on continuations instead of substituting the agent owner', async () => {
  const { agent, owner, id } = await seed();
  const taskId = randomUUID();
  await db
    .update(agents)
    .set({ ownerOxyAccountId: randomUUID(), access: 'public' })
    .where(eq(agents.id, agent.id));
  const source = await sessions.createAgentSession(db, {
    agentId: agent.id,
    oxyUserId: owner,
    oxyTaskId: taskId,
    task: 'Original request',
    status: 'completed',
  });
  await db
    .update(agentWorkItems)
    .set({ kind: 'follow_up', rootId: source.id, sourceSessionId: source.id, oxyTaskId: taskId })
    .where(eq(agentWorkItems.id, id));
  // Remove the unrelated standing root: a hired continuation owns its source task.
  await db.delete(agentWorkAuthorities).where(eq(agentWorkAuthorities.agentId, agent.id));
  await dispatchAgentWork();
  const [work] = await db.select().from(agentWorkItems).where(eq(agentWorkItems.id, id));
  expect(work.status).toBe('running');
  expect(await autonomousWorkMayRun(work.sessionId!)).toBe(true);
  expect(await balance(owner)).toBe(85);
  await stopAgentWork(agent.id);
});

it('turning off attention preserves an explicitly requested continuation', async () => {
  const { agent, id, owner } = await seed();
  const explicitId = randomUUID();
  await db.insert(agentWorkItems).values({
    id: explicitId,
    rootId: explicitId,
    agentId: agent.id,
    ownerAccountId: owner,
    oxyTaskId: randomUUID(),
    kind: 'follow_up',
    objective: 'Requested task',
    dueAt: new Date(),
  });
  await db.update(agents).set({ scheduleInterval: null }).where(eq(agents.id, agent.id));
  await stopAgentWork(agent.id, true);
  const rows = await db.select().from(agentWorkItems).where(eq(agentWorkItems.agentId, agent.id));
  expect(rows.find((row) => row.id === id)?.status).toBe('cancelled');
  expect(rows.find((row) => row.id === explicitId)?.status).toBe('pending');
  await stopAgentWork(agent.id);
});
