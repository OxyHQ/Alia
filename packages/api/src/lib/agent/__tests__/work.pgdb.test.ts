import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { TEST_CHARACTER } from '../../../db/__tests__/support/agent-character';

const owners = vi.hoisted(() => new Set<string>());
vi.mock('../../agent-account', () => ({
  canReachAgent: async (_agent: unknown, requester: { oxyUserId: string }) =>
    owners.has(requester.oxyUserId) ? 'reachable' : 'unavailable',
}));
vi.mock('../../oxy-task-authority', () => ({
  createOxyTask: async () => randomUUID(),
  revokeOxyTask: vi.fn(async () => {}),
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
import { revokeOxyTask } from '../../oxy-task-authority';
import { enqueueAgentSession } from '../../task-queue';
import { autonomousWorkMayRun, dispatchAgentWork, stopAgentWork } from '../work';

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
    scheduleInterval: 60,
  });
  const id = randomUUID();
  await db.insert(agentWorkItems).values({
    id,
    rootId: id,
    agentId: agent.id,
    ownerAccountId: owner,
    oxyTaskId: randomUUID(),
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
    .set({ rootId: source.id, sourceSessionId: source.id, kind: 'follow_up' })
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
  const { agent, id, owner } = await seed();
  const taskId = randomUUID();
  await db.insert(agentWorkAuthorities).values({
    agentId: agent.id,
    ownerAccountId: owner,
    oxyTaskId: taskId,
    expiresAt: new Date(Date.now() + 86400000),
  });
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
