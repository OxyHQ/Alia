import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { registerBot, upsertBotUser } from '../integrations/botRepository';
import {
  acceptChannelInbound,
  CHANNEL_DEDUPE_WINDOW_MS,
  claimChannelInbound,
  claimStalledChannelInbound,
  purgeChannelInbound,
  settleChannelInbound,
} from '../integrations/channelInboundRepository';
import { channelInbound } from '../schema/bots';

/**
 * The durable inbound queue, against a REAL server. What matters here is what a
 * mock cannot say: that the unique key really decides a duplicate, and that the
 * conditional UPDATEs really hand one row to one of several concurrent callers.
 */

let db: ApiDatabase;
let botId: string;
let botUserId: string;

beforeAll(async () => {
  // `bots.bot_token` is encrypted at rest; the codec needs a key to write one.
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
  const bot = await registerBot(db, {
    platform: 'ci-telegram',
    botId: 'ci-1',
    name: 'Inbound Bot',
    userId: 'ci-owner',
    botToken: 'tok',
    webhookSecret: 'ci-secret',
    platformConfigWebhookUrl: 'https://api.test/webhooks/telegram',
  });
  if (!bot) throw new Error('bot not registered');
  botId = bot.id;
  const user = await upsertBotUser(db, {
    botId,
    platform: 'ci-telegram',
    platformUserId: 'ci-person',
    chatId: 'ci-chat',
  });
  botUserId = user.id;
});

afterAll(async () => closePostgres());

let n = 0;
function input(text = 'hola') {
  n += 1;
  return {
    dedupeKey: `ci:${n}:${Math.random()}`,
    kind: 'agent_bot' as const,
    channelType: 'ci-telegram',
    botId,
    botUserId,
    message: { platformUserId: 'ci-person', chatId: 'ci-chat', text },
  };
}

const T0 = new Date('2026-11-09T12:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const stale = { staleMs: 120_000, maxAgeMs: 3_600_000, maxAttempts: 2, limit: 200 };

describe('acceptChannelInbound', () => {
  it('accepts a message once and recognises a retry inside the window', async () => {
    const msg = input();
    expect(await acceptChannelInbound(db, msg, T0)).toEqual(expect.any(String));
    expect(await acceptChannelInbound(db, msg, at(30))).toBeNull();
  });

  it('lets the same key through again once the window has passed', async () => {
    const msg = input();
    const first = await acceptChannelInbound(db, msg, T0);
    const second = await acceptChannelInbound(db, msg, at(CHANNEL_DEDUPE_WINDOW_MS / 1000 + 1));
    expect(first).not.toBeNull();
    expect(second).toBe(first);
    const [row] = await db
      .select()
      .from(channelInbound)
      .where(eq(channelInbound.id, first ?? ''));
    expect(row?.status).toBe('received');
    expect(row?.attempts).toBe(0);
  });
});

describe('claim and settle', () => {
  it('hands a received message to exactly one of several claimers', async () => {
    const id = await acceptChannelInbound(db, input(), T0);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimChannelInbound(db, id ?? '', at(1))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('drops the text when the row settles', async () => {
    const id = (await acceptChannelInbound(db, input('secreto'), T0)) ?? '';
    await claimChannelInbound(db, id, at(1));
    await settleChannelInbound(db, id, 'done', at(2));
    const [row] = await db.select().from(channelInbound).where(eq(channelInbound.id, id));
    expect(row).toMatchObject({ status: 'done', message: null });
  });
});

describe('claimStalledChannelInbound', () => {
  it('retakes a message whose worker went quiet, once, and counts the attempt', async () => {
    const id = (await acceptChannelInbound(db, input('quedó a medias'), T0)) ?? '';
    await claimChannelInbound(db, id, at(1)); // worker 1 starts, then dies
    const now = at(300);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimStalledChannelInbound(db, { now, ...stale })),
    );
    const winners = results.filter((r) => r.some((w) => w.id === id));
    expect(winners).toHaveLength(1);
    expect(winners[0]?.find((w) => w.id === id)).toMatchObject({
      attempts: 2,
      message: { text: 'quedó a medias' },
    });
  });

  it('fails, rather than retries, a message already attempted the maximum times', async () => {
    const id = (await acceptChannelInbound(db, input(), T0)) ?? '';
    await claimChannelInbound(db, id, at(1)); // attempt 1
    await claimStalledChannelInbound(db, { now: at(300), ...stale }); // attempt 2
    const third = await claimStalledChannelInbound(db, { now: at(900), ...stale });
    expect(third.map((w) => w.id)).not.toContain(id);
    const [row] = await db.select().from(channelInbound).where(eq(channelInbound.id, id));
    expect(row).toMatchObject({ status: 'failed', message: null });
  });

  it('leaves fresh messages and ones too old to answer alone', async () => {
    const fresh = (await acceptChannelInbound(db, input(), at(290))) ?? '';
    const ancient = (await acceptChannelInbound(db, input(), at(-7200))) ?? '';
    const ids = (await claimStalledChannelInbound(db, { now: at(300), ...stale })).map((w) => w.id);
    expect(ids).not.toContain(fresh);
    expect(ids).not.toContain(ancient);
  });
});

describe('purgeChannelInbound', () => {
  it('deletes settled rows past their use and abandoned ones, and keeps the rest', async () => {
    const settled = (await acceptChannelInbound(db, input(), at(-7200))) ?? '';
    await settleChannelInbound(db, settled, 'done', at(-7200));
    const abandoned = (await acceptChannelInbound(db, input(), at(-7200))) ?? '';
    const live = (await acceptChannelInbound(db, input(), at(-10))) ?? '';
    await purgeChannelInbound(db, { now: T0, settledMs: 3_600_000, abandonedMs: 3_600_000 });
    const remaining = (await db.select({ id: channelInbound.id }).from(channelInbound)).map(
      (r) => r.id,
    );
    expect(remaining).not.toContain(settled);
    expect(remaining).not.toContain(abandoned);
    expect(remaining).toContain(live);
  });
});
