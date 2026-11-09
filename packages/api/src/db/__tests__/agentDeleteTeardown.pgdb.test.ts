import { uuidv7 } from '@oxy.so/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addInboxItem, upsertAgentSubscription } from '../agents/agentInboxRepository';
import { createAgent, deleteAgent, findAgentById } from '../agents/agentRepository';
import { createAutomationDefinition } from '../automation/automationDefinitionRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { automationDefinitions } from '../schema/agency';
import {
  agentInboxItems,
  agentMemoryDocuments,
  agentMemoryJournal,
  agentSubscriptions,
} from '../schema/agent-runtime';
import { TEST_CHARACTER } from './support/agent-character';

/**
 * Deleting an agent removes the state that means nothing without it and that has no foreign key to go
 * with it, leaves another agent's alone, and DISABLES (does not delete) the automations that name it.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

const OWNER = 'teardown-owner';

async function newAgent() {
  const created = await createAgent(db, {
    oxyAccountId: `teardown-bot-${uuidv7()}`,
    ownerOxyAccountId: OWNER,
    character: TEST_CHARACTER,
    tagline: 't',
    description: 'd',
    authorOxyUserId: OWNER,
    category: 'research',
  });
  return created._id;
}

async function givenState(agentId: string) {
  await upsertAgentSubscription(db, {
    agentId,
    ownerAccountId: OWNER,
    sourceAccountId: OWNER,
    appId: 'inbox',
    eventType: 'new_email',
  });
  await addInboxItem(db, {
    agentId,
    ownerAccountId: OWNER,
    appId: 'inbox',
    eventType: 'new_email',
    dedupeKey: `inbox:${uuidv7()}`,
    summary: { subject: 'hola' },
  });
  const [document] = await db
    .insert(agentMemoryDocuments)
    .values({
      agentId,
      oxyUserId: OWNER,
      path: 'MEMORY.md',
      content: 'likes tea',
      contentHash: 'h',
    })
    .returning({ id: agentMemoryDocuments.id });
  await db.insert(agentMemoryJournal).values({
    documentId: document?.id ?? '',
    agentId,
    oxyUserId: OWNER,
    actorOxyAccountId: 'bot',
    origin: 'agent',
    afterHash: 'h',
    afterContent: 'likes tea',
  });
}

const rowsOf = async (agentId: string) => ({
  subscriptions: (
    await db.select().from(agentSubscriptions).where(eq(agentSubscriptions.agentId, agentId))
  ).length,
  inbox: (await db.select().from(agentInboxItems).where(eq(agentInboxItems.agentId, agentId)))
    .length,
  memory: (
    await db.select().from(agentMemoryDocuments).where(eq(agentMemoryDocuments.agentId, agentId))
  ).length,
  journal: (
    await db.select().from(agentMemoryJournal).where(eq(agentMemoryJournal.agentId, agentId))
  ).length,
});

function automationFor(agentId: string | null) {
  return createAutomationDefinition(db, {
    id: uuidv7(),
    ownerAccountId: OWNER,
    objective: 'Check the news',
    triggerKind: 'schedule',
    scheduleCron: '0 9 * * *',
    scheduleTimezone: 'UTC',
    actorMode: agentId ? 'fixed' : 'alia',
    ...(agentId ? { fixedAgentId: agentId } : {}),
    eligibleAgentIds: [],
    executionMode: 'execute',
    actions: [],
    inputs: {},
    resources: [],
    dataFlow: { sources: [], destinations: [] },
    maximumAutonomy: 'autonomous',
    limits: [],
    enabled: true,
  });
}

const enabledOf = async (id: string) =>
  (
    await db
      .select({ enabled: automationDefinitions.enabled })
      .from(automationDefinitions)
      .where(eq(automationDefinitions.id, id))
  )[0]?.enabled;

describe('deleteAgent', () => {
  it('removes the agent’s inbox, subscriptions, memory and journal, and the agent', async () => {
    const id = await newAgent();
    await givenState(id);
    expect(await rowsOf(id)).toEqual({ subscriptions: 1, inbox: 1, memory: 1, journal: 1 });

    expect(await deleteAgent(db, id)).toBe(1);

    expect(await rowsOf(id)).toEqual({ subscriptions: 0, inbox: 0, memory: 0, journal: 0 });
    expect(await findAgentById(db, id)).toBeNull();
  });

  it('leaves another agent’s state alone', async () => {
    const doomed = await newAgent();
    const kept = await newAgent();
    await givenState(doomed);
    await givenState(kept);

    await deleteAgent(db, doomed);

    expect(await rowsOf(kept)).toEqual({ subscriptions: 1, inbox: 1, memory: 1, journal: 1 });
    expect(await findAgentById(db, kept)).not.toBeNull();
  });

  it('disables the automations that name it as their actor, and no others', async () => {
    const doomed = await newAgent();
    const other = await newAgent();
    const named = await automationFor(doomed);
    const alia = await automationFor(null);
    const forOther = await automationFor(other);

    await deleteAgent(db, doomed);

    expect(await enabledOf(named.id)).toBe(false);
    expect(await enabledOf(alia.id)).toBe(true);
    expect(await enabledOf(forOther.id)).toBe(true);
  });

  it('can be repeated: deleting what is already gone changes nothing and reports it', async () => {
    const id = await newAgent();
    await givenState(id);
    expect(await deleteAgent(db, id)).toBe(1);
    expect(await deleteAgent(db, id)).toBe(0);
  });
});
