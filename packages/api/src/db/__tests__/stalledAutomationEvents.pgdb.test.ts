import { uuidv7 } from '@oxy.so/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  retryAutomationEvent,
  claimAutomationEvent,
  claimStalledAutomationEvents,
  markAutomationEventStatus,
  type NormalizedAutomationEventInput,
} from '../automation/automationDefinitionRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { automationEvents } from '../schema/agency';

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

const NOW = new Date('2026-11-09T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000);

function event(eventId: string): NormalizedAutomationEventInput {
  return {
    eventId,
    appId: `stall-${eventId}`,
    accountId: 'stall-owner',
    resource: {
      appId: `stall-${eventId}`,
      effectiveAccountId: 'stall-owner',
      resourceType: 'mailbox',
      resourceId: 'm1',
    },
    eventType: 'new_email',
    occurredAt: minutes(10),
    data: { subject: 'hi' },
  };
}

/** Insert an event and age it, as if its instance died `ageMin` minutes ago. */
async function stored(ageMin: number, status?: 'matched' | 'processed' | 'failed') {
  const input = event(uuidv7());
  await claimAutomationEvent(db, input);
  if (status) await markAutomationEventStatus(db, input.appId, input.eventId, status);
  await db
    .update(automationEvents)
    .set({ updatedAt: minutes(ageMin), receivedAt: minutes(ageMin) })
    .where(eq(automationEvents.eventId, input.eventId));
  return input;
}

const options = { now: NOW, staleMs: 2 * 60_000, maxAgeMs: 24 * 60 * 60_000, limit: 500 };

describe('claimStalledAutomationEvents', () => {
  it('claims a received or matched event that has sat past the window, with its data', async () => {
    const received = await stored(5);
    const matched = await stored(5, 'matched');
    const claimed = await claimStalledAutomationEvents(db, options);
    const ids = claimed.map((e) => e.eventId);
    expect(ids).toContain(received.eventId);
    expect(ids).toContain(matched.eventId);
    expect(claimed.find((e) => e.eventId === received.eventId)).toMatchObject({
      appId: received.appId,
      accountId: 'stall-owner',
      eventType: 'new_email',
      data: { subject: 'hi' },
    });
  });

  it('leaves fresh, finished, failed and too-old events alone', async () => {
    const fresh = await stored(0.5);
    const processed = await stored(5, 'processed');
    const failed = await stored(5, 'failed');
    const ancient = await stored(60 * 30);
    const ids = (await claimStalledAutomationEvents(db, options)).map((e) => e.eventId);
    for (const e of [fresh, processed, failed, ancient]) expect(ids).not.toContain(e.eventId);
  });

  it('hands each event to exactly one of several concurrent sweepers', async () => {
    const mine = await stored(5);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimStalledAutomationEvents(db, options)),
    );
    const winners = results.filter((r) => r.some((e) => e.eventId === mine.eventId));
    expect(winners).toHaveLength(1);
  });

  it('does not hand the same event out again until it has been stale once more', async () => {
    const mine = await stored(5);
    await claimStalledAutomationEvents(db, options);
    const again = await claimStalledAutomationEvents(db, options);
    expect(again.map((e) => e.eventId)).not.toContain(mine.eventId);
  });
});

it('backs off transient events and makes exhaustion terminal exactly once', async () => {
  const mine = await stored(5);
  expect(await retryAutomationEvent(db, mine.appId, mine.eventId, NOW)).toBe(false);
  const [first] = await db
    .select()
    .from(automationEvents)
    .where(eq(automationEvents.eventId, mine.eventId));
  expect(first).toMatchObject({ status: 'received', attempts: 1 });
  expect(first.retryAfter).toEqual(new Date(NOW.getTime() + 60000));
  await db
    .update(automationEvents)
    .set({ updatedAt: minutes(5), retryAfter: new Date(NOW.getTime() + 60000) })
    .where(eq(automationEvents.eventId, mine.eventId));
  expect((await claimStalledAutomationEvents(db, options)).map((row) => row.eventId)).not.toContain(
    mine.eventId,
  );
  for (let n = 1; n < 11; n++)
    expect(await retryAutomationEvent(db, mine.appId, mine.eventId, NOW)).toBe(false);
  expect(await retryAutomationEvent(db, mine.appId, mine.eventId, NOW)).toBe(true);
  expect(await retryAutomationEvent(db, mine.appId, mine.eventId, NOW)).toBe(false);
  const [last] = await db
    .select()
    .from(automationEvents)
    .where(eq(automationEvents.eventId, mine.eventId));
  expect(last).toMatchObject({ status: 'failed', attempts: 12 });
});
