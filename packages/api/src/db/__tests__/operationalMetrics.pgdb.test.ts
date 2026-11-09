import { uuidv7 } from '@oxy.so/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseGauges } from '../../lib/observability/operational-metrics';
import { addInboxItem, setBackgroundPaused } from '../agents/agentInboxRepository';
import { claimAutomationEvent } from '../automation/automationDefinitionRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { registerBot, upsertBotUser } from '../integrations/botRepository';
import { acceptChannelInbound } from '../integrations/channelInboundRepository';
import { automationEvents } from '../schema/agency';
import { channelInbound } from '../schema/bots';

/**
 * The operational gauges against a REAL server. The database is shared by other test files, so each
 * assertion is a DELTA: read the gauge, change exactly one row, read it again.
 */

let db: ApiDatabase;

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

const NOW = new Date();
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

async function gauge(name: string): Promise<number> {
  const found = (await databaseGauges(db, NOW)).find((g) => g.name === name);
  if (!found) throw new Error(`gauge ${name} missing`);
  return found.value;
}

describe('databaseGauges', () => {
  it('reports every gauge', async () => {
    expect((await databaseGauges(db, NOW)).map((g) => g.name).sort()).toEqual([
      'alia_agent_inbox_pending',
      'alia_automation_events_stalled',
      'alia_background_paused_people',
      'alia_channel_inbound_failed_total',
      'alia_channel_inbound_stalled',
    ]);
  });

  it('counts an Oxy event as stalled only once it has sat past two minutes', async () => {
    const before = await gauge('alia_automation_events_stalled');
    const event = {
      eventId: uuidv7(),
      appId: `metrics-${uuidv7()}`,
      accountId: 'metrics-owner',
      resource: {
        appId: 'x',
        effectiveAccountId: 'metrics-owner',
        resourceType: 'r',
        resourceId: '1',
      },
      eventType: 'e',
      occurredAt: NOW,
      data: {},
    };
    await claimAutomationEvent(db, event);
    expect(await gauge('alia_automation_events_stalled')).toBe(before); // fresh
    await db
      .update(automationEvents)
      .set({ updatedAt: minutesAgo(5), receivedAt: minutesAgo(5) })
      .where(eq(automationEvents.eventId, event.eventId));
    expect(await gauge('alia_automation_events_stalled')).toBe(before + 1);
    await db
      .update(automationEvents)
      .set({ status: 'processed' })
      .where(eq(automationEvents.eventId, event.eventId));
    expect(await gauge('alia_automation_events_stalled')).toBe(before);
  });

  it('counts a stored channel message as stalled, and a failed one as failed', async () => {
    const bot = await registerBot(db, {
      platform: 'metrics-telegram',
      botId: `m-${uuidv7()}`,
      name: 'Metrics Bot',
      userId: 'metrics-owner',
      botToken: 't',
      webhookSecret: `s-${uuidv7()}`,
      platformConfigWebhookUrl: 'https://api.test/x',
    });
    if (!bot) throw new Error('bot not registered');
    const user = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'metrics-telegram',
      platformUserId: 'p',
      chatId: 'c',
    });
    const stalledBefore = await gauge('alia_channel_inbound_stalled');
    const failedBefore = await gauge('alia_channel_inbound_failed_total');
    const id = await acceptChannelInbound(
      db,
      {
        dedupeKey: `metrics:${uuidv7()}`,
        kind: 'agent_bot',
        channelType: 'metrics-telegram',
        botId: bot.id,
        botUserId: user.id,
        message: { platformUserId: 'p', chatId: 'c', text: 'hi' },
      },
      minutesAgo(10),
    );
    expect(await gauge('alia_channel_inbound_stalled')).toBe(stalledBefore + 1);
    await db
      .update(channelInbound)
      .set({ status: 'failed', message: null })
      .where(eq(channelInbound.id, id ?? ''));
    expect(await gauge('alia_channel_inbound_stalled')).toBe(stalledBefore);
    expect(await gauge('alia_channel_inbound_failed_total')).toBe(failedBefore + 1);
  });

  it('counts waiting inbox items and paused people', async () => {
    const inboxBefore = await gauge('alia_agent_inbox_pending');
    await addInboxItem(db, {
      agentId: `metrics-agent-${uuidv7()}`,
      ownerAccountId: 'metrics-owner',
      appId: 'inbox',
      eventType: 'new_email',
      dedupeKey: `inbox:${uuidv7()}`,
      summary: {},
    });
    expect(await gauge('alia_agent_inbox_pending')).toBe(inboxBefore + 1);

    const pausedBefore = await gauge('alia_background_paused_people');
    const person = `metrics-paused-${uuidv7()}`;
    await setBackgroundPaused(db, person, true);
    expect(await gauge('alia_background_paused_people')).toBe(pausedBefore + 1);
    await setBackgroundPaused(db, person, false);
    expect(await gauge('alia_background_paused_people')).toBe(pausedBefore);
  });
});
