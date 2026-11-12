import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { createAgent } from '../agents/agentRepository';
import {
  findHeartbeatState,
  addInboxItem,
  countPendingInboxItems,
  dueHeartbeats,
  listInboxItems,
} from '../agents/agentInboxRepository';
import { acceptHeartbeat, addAgentFollowUp, listAgentWork } from '../agents/agentWorkRepository';
import { agentWorkAuthorities, agentWorkItems } from '../schema/agent-work';
import { createAgentSession } from '../agents/agentSessionRepository';
import { TEST_CHARACTER } from './support/agent-character';

let db: ApiDatabase;
const now = new Date();
beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('Test database missing');
  db = connected;
});
afterAll(() => closePostgres());

async function setup(authorize = true) {
  const owner = randomUUID();
  const agent = await createAgent(db, {
    oxyAccountId: randomUUID(),
    ownerOxyAccountId: owner,
    authorOxyUserId: owner,
    character: TEST_CHARACTER,
    tagline: 'test',
    description: 'test',
    category: 'research',
    scheduleInterval: 5,
  });
  const taskId = randomUUID();
  if (authorize)
    await db.insert(agentWorkAuthorities).values({
      agentId: agent.id,
      ownerAccountId: owner,
      oxyTaskId: taskId,
      expiresAt: new Date(now.getTime() + 86400000),
    });
  await addInboxItem(db, {
    agentId: agent.id,
    ownerAccountId: owner,
    appId: 'inbox',
    eventType: 'new_email',
    dedupeKey: randomUUID(),
    summary: { subject: 'a message' },
    now,
  });
  const candidate = {
    agentId: agent.id,
    ownerAccountId: owner,
    intervalMinutes: 5,
    lastHeartbeatAt: null,
  };
  if (authorize)
    expect((await dueHeartbeats(db, now)).map((row) => row.agentId)).toContain(agent.id);
  else expect((await dueHeartbeats(db, now)).map((row) => row.agentId)).not.toContain(agent.id);
  return { agent, owner, taskId, candidate };
}

it('rolls back acknowledgement and heartbeat time when work creation fails', async () => {
  const { candidate, agent } = await setup();
  await expect(
    acceptHeartbeat(db, candidate, now, () => {
      throw new Error('render failed');
    }),
  ).rejects.toThrow('render failed');
  expect(await countPendingInboxItems(db, agent.id)).toBe(1);
  expect((await findHeartbeatState(db, agent.id))?.lastHeartbeatAt).toBeNull();
  expect(await listAgentWork(db, agent.id)).toHaveLength(0);
});

it('two replicas create exactly one durable batch and acknowledge its events', async () => {
  const { candidate, agent } = await setup();
  expect(
    (
      await Promise.all([
        acceptHeartbeat(db, candidate, now, () => 'work'),
        acceptHeartbeat(db, candidate, now, () => 'work'),
      ])
    ).filter(Boolean),
  ).toHaveLength(1);
  expect(await countPendingInboxItems(db, agent.id)).toBe(0);
  expect(await listAgentWork(db, agent.id)).toHaveLength(1);
});

it('leaves events pending until a real requester has established authority', async () => {
  const { candidate, agent } = await setup(false);
  expect(await acceptHeartbeat(db, candidate, now, () => 'work')).toBe(false);
  expect(await countPendingInboxItems(db, agent.id)).toBe(1);
});

it('does not stack another heartbeat while the first execution is running', async () => {
  const { candidate, agent, owner } = await setup();
  await acceptHeartbeat(db, candidate, now, () => 'work');
  await db
    .update(agentWorkItems)
    .set({ status: 'running' })
    .where(eq(agentWorkItems.agentId, agent.id));
  await addInboxItem(db, {
    agentId: agent.id,
    ownerAccountId: owner,
    appId: 'inbox',
    eventType: 'new_email',
    dedupeKey: randomUUID(),
    summary: {},
    now,
  });
  const later = new Date(now.getTime() + 6 * 60000);
  expect((await dueHeartbeats(db, later)).map((row) => row.agentId)).not.toContain(agent.id);
  expect(
    await acceptHeartbeat(db, { ...candidate, lastHeartbeatAt: now }, later, () => 'work'),
  ).toBe(false);
  expect(await countPendingInboxItems(db, agent.id)).toBe(1);
});

it('stores a bounded UTF-8 projection, not a character-count approximation', async () => {
  const { agent, owner } = await setup();
  await addInboxItem(db, {
    agentId: agent.id,
    ownerAccountId: owner,
    appId: 'inbox',
    eventType: 'new_email',
    dedupeKey: randomUUID(),
    summary: { subject: '🌍'.repeat(900), from: 'sender' },
    now,
  });
  for (const row of await listInboxItems(db, agent.id))
    expect(Buffer.byteLength(JSON.stringify(row.summary))).toBeLessThanOrEqual(2048);
});

it('a continuation keeps its original requester task and deduplicates a tool replay', async () => {
  const { agent, owner, taskId } = await setup();
  const source = await createAgentSession(db, {
    agentId: agent.id,
    oxyUserId: owner,
    task: 'original',
    oxyTaskId: taskId,
  });
  const input = {
    agentId: agent.id,
    ownerAccountId: owner,
    sourceSessionId: source.id,
    at: new Date(now.getTime() + 60000),
    note: 'Continue tomorrow',
  };
  const [a, b] = await Promise.all([addAgentFollowUp(db, input), addAgentFollowUp(db, input)]);
  expect(a?.id).toBe(b?.id);
  expect(a?.oxyTaskId).toBe(taskId);
  expect(a?.rootId).toBe(source.id);
  expect(await addAgentFollowUp(db, { ...input, ownerAccountId: 'someone-else' })).toBeNull();
});
