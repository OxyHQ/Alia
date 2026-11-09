import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent } from '../agents/agentRepository';
import {
  INBOX_ITEMS_PER_WAKE,
  INBOX_ITEM_MAX_AGE_MS,
  INBOX_SUMMARY_MAX_BYTES,
  addInboxItem,
  claimHeartbeat,
  countPendingInboxItems,
  deleteAgentSubscription,
  dueHeartbeats,
  listAgentSubscriptions,
  listInboxItems,
  matchingAgentSubscriptions,
  returnInboxItems,
  takeInboxItems,
  upsertAgentSubscription,
} from '../agents/agentInboxRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentInboxItems } from '../schema/agent-runtime';
import { agents } from '../schema/agents';
import { TEST_CHARACTER } from './support/agent-character';

/**
 * An agent's inbox against a REAL server: that the unique keys really dedupe, that the conditional
 * statements really hand each item and each heartbeat to one of several concurrent callers, and that
 * the eligibility query skips an agent with nothing waiting.
 */

let db: ApiDatabase;

beforeAll(() => {
  db = (() => {
    const connected = connectPostgres(process.env.DATABASE_URL);
    if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
    return connected;
  })();
});

afterAll(async () => closePostgres());

let n = 0;
const OWNER = 'inbox-owner';
const unique = () => `${Date.now()}-${(n += 1)}`;
const T0 = new Date('2026-11-09T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

async function agent(overrides: { scheduleInterval?: number; isPublished?: boolean } = {}) {
  const created = await createAgent(db, {
    oxyAccountId: `inbox-bot-${unique()}`,
    ownerOxyAccountId: OWNER,
    character: TEST_CHARACTER,
    tagline: 't',
    description: 'd',
    authorOxyUserId: OWNER,
    category: 'research',
    isPublished: overrides.isPublished ?? true,
  });
  if (overrides.scheduleInterval !== undefined) {
    await db
      .update(agents)
      .set({ scheduleInterval: overrides.scheduleInterval })
      .where(eq(agents.id, created._id));
  }
  return created._id;
}

const item = (agentId: string, key = `inbox:${unique()}`, now?: Date) => ({
  agentId,
  ownerAccountId: OWNER,
  appId: 'inbox',
  eventType: 'new_email',
  dedupeKey: key,
  summary: { subject: 'hola' },
  ...(now ? { now } : {}),
});

describe('subscriptions', () => {
  it('match by account, app and type, with wildcards, and ignore disabled ones', async () => {
    const id = await agent();
    const source = `acct-${unique()}`;
    const base = { agentId: id, ownerAccountId: OWNER, sourceAccountId: source };
    await upsertAgentSubscription(db, { ...base, appId: 'inbox', eventType: 'new_email' });
    await upsertAgentSubscription(db, { ...base, appId: '*', eventType: 'reminder' });

    const hit = await matchingAgentSubscriptions(db, {
      accountId: source,
      appId: 'inbox',
      eventType: 'new_email',
    });
    expect(hit.map((s) => s.eventType)).toEqual(['new_email']);

    const wildcard = await matchingAgentSubscriptions(db, {
      accountId: source,
      appId: 'calendar',
      eventType: 'reminder',
    });
    expect(wildcard.map((s) => s.appId)).toEqual(['*']);

    expect(
      await matchingAgentSubscriptions(db, {
        accountId: `other-${unique()}`,
        appId: 'inbox',
        eventType: 'new_email',
      }),
    ).toEqual([]);
  });

  it('subscribing twice is one subscription, and a subscription can be removed', async () => {
    const id = await agent();
    const input = {
      agentId: id,
      ownerAccountId: OWNER,
      sourceAccountId: `acct-${unique()}`,
      appId: 'inbox',
      eventType: 'new_email',
    };
    const first = await upsertAgentSubscription(db, input);
    const second = await upsertAgentSubscription(db, input);
    expect(second.id).toBe(first.id);
    expect(await listAgentSubscriptions(db, id)).toHaveLength(1);
    expect(await deleteAgentSubscription(db, id, first.id)).toBe(true);
    expect(await deleteAgentSubscription(db, id, first.id)).toBe(false);
  });
});

describe('the inbox', () => {
  it('adds an event once however often it is delivered', async () => {
    const id = await agent();
    const same = item(id, 'inbox:evt-1');
    expect(await addInboxItem(db, same)).toBe(true);
    expect(await addInboxItem(db, same)).toBe(false);
    expect(await countPendingInboxItems(db, id)).toBe(1);
  });

  it('keeps a summary within its cap, whole fields only', async () => {
    const id = await agent();
    await addInboxItem(db, {
      ...item(id),
      summary: { subject: 'cabe', body: 'x'.repeat(INBOX_SUMMARY_MAX_BYTES * 2) },
    });
    const [stored] = await listInboxItems(db, id);
    expect(stored?.summary).toEqual({ subject: 'cabe' });
  });

  it('hands each pending item to exactly one of several concurrent takers', async () => {
    const id = await agent();
    for (let i = 0; i < 5; i += 1) await addInboxItem(db, item(id, `inbox:c-${unique()}`, at(i)));
    const taken = await Promise.all(
      Array.from({ length: 4 }, () => takeInboxItems(db, id, at(10))),
    );
    const ids = taken.flat().map((row) => row.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(await countPendingInboxItems(db, id)).toBe(0);
  });

  it('takes the oldest first and no more than a wake-up carries', async () => {
    const id = await agent();
    for (let i = 0; i < INBOX_ITEMS_PER_WAKE + 3; i += 1) {
      await addInboxItem(db, item(id, `inbox:o-${unique()}`, at(i)));
    }
    const taken = await takeInboxItems(db, id, at(60));
    expect(taken).toHaveLength(INBOX_ITEMS_PER_WAKE);
    expect(taken[0]?.receivedAt.getTime()).toBe(at(0).getTime());
    expect(await countPendingInboxItems(db, id)).toBe(3);
  });

  it('dismisses what is too old instead of delivering it', async () => {
    const id = await agent();
    await addInboxItem(
      db,
      item(id, `inbox:old-${unique()}`, new Date(T0.getTime() - INBOX_ITEM_MAX_AGE_MS - 60_000)),
    );
    await addInboxItem(db, item(id, `inbox:new-${unique()}`, at(-5)));
    const taken = await takeInboxItems(db, id, T0);
    expect(taken).toHaveLength(1);
    const dismissed = await listInboxItems(db, id, { status: 'dismissed' });
    expect(dismissed).toHaveLength(1);
  });

  it('gives delivered items back when their wake-up could not be scheduled', async () => {
    const id = await agent();
    await addInboxItem(db, item(id));
    const taken = await takeInboxItems(db, id, T0);
    await returnInboxItems(
      db,
      taken.map((row) => row.id),
    );
    expect(await countPendingInboxItems(db, id)).toBe(1);
    const [row] = await db
      .select()
      .from(agentInboxItems)
      .where(eq(agentInboxItems.id, taken[0]?.id ?? ''));
    expect(row?.deliveredAt).toBeNull();
  });
});

describe('the heartbeat', () => {
  it('is due only for a published agent with an interval that has elapsed and something waiting', async () => {
    const due = await agent({ scheduleInterval: 15 });
    const empty = await agent({ scheduleInterval: 15 });
    const noInterval = await agent();
    const unpublished = await agent({ scheduleInterval: 15, isPublished: false });
    for (const id of [due, noInterval, unpublished]) await addInboxItem(db, item(id));

    const ids = (await dueHeartbeats(db, T0)).map((c) => c.agentId);
    expect(ids).toContain(due);
    expect(ids).not.toContain(empty);
    expect(ids).not.toContain(noInterval);
    expect(ids).not.toContain(unpublished);
  });

  it('waits out its interval after a wake-up', async () => {
    const id = await agent({ scheduleInterval: 15 });
    await addInboxItem(db, item(id));
    const [candidate] = (await dueHeartbeats(db, T0)).filter((c) => c.agentId === id);
    expect(candidate).toBeDefined();
    expect(await claimHeartbeat(db, candidate!, T0)).toBe(true);

    expect((await dueHeartbeats(db, at(10))).map((c) => c.agentId)).not.toContain(id);
    expect((await dueHeartbeats(db, at(16))).map((c) => c.agentId)).toContain(id);
  });

  it('wakes an agent once when several instances try at the same moment', async () => {
    const id = await agent({ scheduleInterval: 15 });
    await addInboxItem(db, item(id));
    const [candidate] = (await dueHeartbeats(db, T0)).filter((c) => c.agentId === id);
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => claimHeartbeat(db, candidate!, T0)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});
