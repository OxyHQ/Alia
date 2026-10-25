import {
  createPendingConnectedAccount,
  setConnectedAccountTask,
  findConnectedAccountForUser,
} from '../integrations/connectedAccountRepository.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index.js';
import { bots, botUsers } from '../schema/bots.js';
import { connectedAccounts } from '../schema/integrations.js';
import { registerBot, upsertBotUser, findBotUser } from '../integrations/botRepository.js';
import {
  migrateChannelTaskAuthority,
  channelTaskAuthorityInventory,
} from '../integrations/migrateChannelTaskAuthority.js';

let db: ApiDatabase;
beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  db = connectPostgres(process.env.DATABASE_URL)!;
});
afterAll(closePostgres);
let sequence = 0;
async function legacy(token: string, linked = true) {
  const id = `channel-task-${process.pid}-${sequence++}`;
  const bot = await registerBot(db, {
    platform: id,
    botId: id,
    name: id,
    userId: 'bot-owner',
    botToken: 'synthetic',
    webhookSecret: id,
    platformConfigWebhookUrl: 'https://test.invalid',
  });
  if (!bot) throw new Error('bot creation failed');
  const row = await upsertBotUser(db, {
    botId: bot.id,
    platform: id,
    platformUserId: id,
    chatId: id,
  });
  await db
    .update(botUsers)
    .set({
      oxyUserId: 'original-person',
      isLinked: linked,
      metadata: { sessionToken: token, keep: true },
    })
    .where(eq(botUsers.id, row.id));
  return { row, bot, id };
}

describe('controlled channel-task conversion', () => {
  it('reports active links with no durable proof, including rows with no legacy session token', async () => {
    const { row, bot } = await legacy('not-used');
    await db.update(bots).set({ platform: 'telegram' }).where(eq(bots.id, bot.id));
    await db.update(botUsers).set({ metadata: {}, oxyTaskId: null }).where(eq(botUsers.id, row.id));
    const connection = await createPendingConnectedAccount(db, {
      oxyUserId: 'linked-person',
      platform: 'whatsapp',
      capabilities: [],
    });
    await db
      .update(connectedAccounts)
      .set({ status: 'connected', sessionId: 'inventory-session' })
      .where(eq(connectedAccounts.id, connection.id));
    const before = await channelTaskAuthorityInventory(db);
    expect(before.botLinksWithoutTask).toBeGreaterThanOrEqual(1);
    expect(before.connectedChannelsWithoutTask).toBeGreaterThanOrEqual(1);
    await db.update(botUsers).set({ isLinked: false }).where(eq(botUsers.id, row.id));
    await db
      .update(connectedAccounts)
      .set({ status: 'disconnected' })
      .where(eq(connectedAccounts.id, connection.id));
    const after = await channelTaskAuthorityInventory(db);
    expect(after.botLinksWithoutTask).toBe(before.botLinksWithoutTask - 1);
    expect(after.connectedChannelsWithoutTask).toBe(before.connectedChannelsWithoutTask - 1);
  });
  it('permits only one task rotation for the same previous account binding', async () => {
    const row = await createPendingConnectedAccount(db, {
      oxyUserId: 'rotation-person',
      platform: 'telegram',
      capabilities: [],
    });
    const updates = await Promise.all([
      setConnectedAccountTask(db, row.id, 'root-a', null),
      setConnectedAccountTask(db, row.id, 'root-b', null),
    ]);
    expect(updates.filter(Boolean)).toHaveLength(1);
    const saved = await findConnectedAccountForUser(db, row.id, 'rotation-person');
    expect(saved?.oxyTaskState).toBe('active');
    expect(await setConnectedAccountTask(db, row.id, null, 'not-current')).toBe(false);
    expect((await findConnectedAccountForUser(db, row.id, 'rotation-person'))?.oxyTaskId).toBe(
      saved?.oxyTaskId,
    );
  });
  it('validates the original requester and removes a bearer only after persisting the task', async () => {
    const { row, bot, id } = await legacy('valid-session');
    expect((await findBotUser(db, bot.id, id))?.metadata).not.toHaveProperty('sessionToken');
    const createTask = vi.fn(async (input) => {
      expect(input.effectiveAccountId).toBe('original-person');
      expect(input.accessToken).toBe('valid-session');
      return 'verified-task';
    });
    const counts = await migrateChannelTaskAuthority(db, { apply: true, createTask });
    expect(counts.active).toBe(1);
    const [stored] = await db.select().from(botUsers).where(eq(botUsers.id, row.id));
    expect(stored).toMatchObject({
      oxyTaskId: 'verified-task',
      oxyTaskState: 'active',
      metadata: { keep: true },
    });
  });
  it('marks an expired session for reauthentication and purges the bearer without guessing the owner', async () => {
    const { row } = await legacy('expired-session');
    const createTask = vi.fn(async () => {
      throw Object.assign(new Error('expired'), { status: 401 });
    });
    expect(
      (await migrateChannelTaskAuthority(db, { apply: true, createTask })).reauthRequired,
    ).toBe(1);
    const [stored] = await db.select().from(botUsers).where(eq(botUsers.id, row.id));
    expect(stored).toMatchObject({
      oxyTaskId: null,
      oxyTaskState: 'reauth_required',
      oxyUserId: 'original-person',
      metadata: { keep: true },
    });
  });
  it('keeps a transient authority outage retryable, and dry-run neither validates nor mutates', async () => {
    const { row } = await legacy('retry-session');
    const createTask = vi.fn(async () => {
      throw Object.assign(new Error('down'), { status: 503 });
    });
    await migrateChannelTaskAuthority(db, { apply: false, createTask });
    expect(createTask).not.toHaveBeenCalled();
    expect((await migrateChannelTaskAuthority(db, { apply: true, createTask })).retry).toBe(1);
    const [stored] = await db.select().from(botUsers).where(eq(botUsers.id, row.id));
    expect(stored?.metadata.sessionToken).toBe('retry-session');
    await db.delete(botUsers).where(eq(botUsers.id, row.id));
  });
  it('revokes a root created while the original channel was concurrently unlinked', async () => {
    const { row } = await legacy('racing-session');
    const revokeTask = vi.fn(async () => {});
    const createTask = vi.fn(async () => {
      await db
        .update(botUsers)
        .set({ isLinked: false, oxyUserId: null, metadata: {} })
        .where(eq(botUsers.id, row.id));
      return 'racing-task';
    });
    expect(
      (await migrateChannelTaskAuthority(db, { apply: true, createTask, revokeTask })).changed,
    ).toBe(1);
    expect(revokeTask).toHaveBeenCalledWith('racing-task');
    const [stored] = await db.select().from(botUsers).where(eq(botUsers.id, row.id));
    expect(stored?.oxyTaskId).toBeNull();
  });
});
