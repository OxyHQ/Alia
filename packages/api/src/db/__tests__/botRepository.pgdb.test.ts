import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { botUsers, bots } from '../schema/bots';
import {
  deleteBot,
  findActiveUserBotByWebhookSecret,
  findBotById,
  findBotByPlatformIdentity,
  findBotUser,
  findBotUserByAuthToken,
  findLinkedBotUser,
  findOwnedBot,
  findOwnedBotWithToken,
  findSystemBot,
  linkBotUser,
  listVisibleBots,
  logoutBotUser,
  registerBot,
  seedSystemBot,
  setBotAgent,
  setBotUserAuthToken,
  setBotUserConversation,
  unlinkBotUser,
  upsertBotUser,
  type NewBot,
} from '../integrations/botRepository';

/**
 * Bots and bot users, against a REAL server.
 *
 * The centre of this file is the ASYMMETRY between three credentials on two
 * tables. `bots.bot_token` is encrypted; `bots.webhook_secret` and
 * `bot_users.auth_token` are plaintext BECAUSE the production paths look rows up
 * by them. A test that only asserted "the secrets are protected" would pass
 * against a schema that had broken inbound bot routing and account linking
 * outright, silently.
 *
 * Ids are prefixed `br-` / `bru-` and every list is scoped to a user or platform
 * this file created.
 */

let db: ApiDatabase;

function newBot(overrides: Partial<NewBot> = {}): NewBot {
  return {
    platform: 'br-telegram',
    botId: '1000',
    name: 'Owned Bot',
    userId: 'bru-owner',
    botToken: 'PLAINTEXT-BOT-TOKEN',
    webhookSecret: 'br-secret-1000',
    platformConfigWebhookUrl: 'https://api.test/webhooks/telegram',
    ...overrides,
  };
}

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

describe('the three credentials are treated OPPOSITELY, on purpose', () => {
  it('encrypts the platform token and still finds the bot by its PLAINTEXT webhook secret', async () => {
    /**
     * Both halves in one test, because the point is the contrast. If a future
     * change made `webhook_secret` `encryptedText` "for consistency", the
     * lookup below would return `null` — every inbound Telegram update would
     * answer 200 having done nothing, with no error anywhere.
     */
    const bot = await registerBot(db, newBot({ platform: 'br-asym', botId: 'a1' }));
    if (!bot) throw new Error('registerBot returned null');

    const raw = await db.execute<{ token: string; secret: string }>(
      sql`select bot_token as token, webhook_secret as secret from ${bots} where id = ${bot.id}`,
    );
    // Encrypted at rest.
    expect(raw[0]?.token).not.toBe('PLAINTEXT-BOT-TOKEN');
    expect(raw[0]?.token).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    // Deliberately NOT encrypted — this is the equality the lookup needs.
    expect(raw[0]?.secret).toBe('br-secret-1000');

    const found = await findActiveUserBotByWebhookSecret(db, 'br-secret-1000', 'br-asym');
    expect(found?.id).toBe(bot.id);
    // And the reply token comes back decrypted, because the reply is sent with it.
    expect(found?.botToken).toBe('PLAINTEXT-BOT-TOKEN');
  });

  it('finds a bot user by its PLAINTEXT auth token, paired with the expiry', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-token', botId: 't1' }));
    if (!bot) throw new Error('registerBot returned null');
    const botUser = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-token',
      platformUserId: 'p1',
      chatId: 'c1',
    });

    const expiry = new Date(Date.now() + 15 * 60 * 1000);
    await setBotUserAuthToken(db, botUser.id, 'br-auth-token', expiry);

    expect((await findBotUserByAuthToken(db, bot.id, 'br-auth-token'))?.id).toBe(botUser.id);

    // The expiry is part of the PREDICATE, not a check the caller might forget.
    const afterExpiry = new Date(Date.now() + 16 * 60 * 1000);
    expect(await findBotUserByAuthToken(db, bot.id, 'br-auth-token', afterExpiry)).toBeNull();
  });

  it('keeps both credentials out of every shape the routes render', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-proj', botId: 'p1' }));
    if (!bot) throw new Error('registerBot returned null');

    for (const shape of [
      bot,
      await findBotById(db, bot.id),
      await findOwnedBot(db, bot.id, 'bru-owner'),
      (await listVisibleBots(db, 'bru-owner'))[0],
    ]) {
      const keys = Object.keys(shape ?? {});
      expect(keys).not.toContain('botToken');
      expect(keys).not.toContain('webhookSecret');
    }
    // The floor, so the absences above are a column list rather than no row.
    expect(bot.name).toBe('Owned Bot');
    expect(bot._id).toBe(bot.id);

    // And the ONE reader that needs the token names it.
    const withToken = await findOwnedBotWithToken(db, bot.id, 'bru-owner');
    expect(withToken?.botToken).toBe('PLAINTEXT-BOT-TOKEN');
  });

  it('does NOT project the bot user\'s auth token', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-noauth', botId: 'n1' }));
    if (!bot) throw new Error('registerBot returned null');
    const botUser = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-noauth',
      platformUserId: 'p1',
      chatId: 'c1',
    });
    await setBotUserAuthToken(db, botUser.id, 'br-secret-token', new Date(Date.now() + 60_000));

    const read = await findBotUser(db, bot.id, 'p1');
    expect(Object.keys(read ?? {})).not.toContain('authToken');
    // Its DEADLINE is projected — the auth-request route echoes it — and that is
    // not the credential.
    expect(read?.authTokenExpiry).toBeInstanceOf(Date);
  });
});

describe('the system bot and a user-owned bot never select each other', () => {
  it('finds the system bot by user_id IS NULL', async () => {
    await seedSystemBot(db, { platform: 'br-sys', botId: 's1', name: 'System' });
    await registerBot(db, newBot({ platform: 'br-sys', botId: 'u1', userId: 'bru-someone' }));

    const system = await findSystemBot(db, 'br-sys');
    expect(system?.botId).toBe('s1');
    expect(system?.userId).toBeNull();
  });

  it('refuses to route a SYSTEM bot down the per-bot inbound path', async () => {
    /**
     * `userId: { $exists: true }` in the source. Without it, the global bot's
     * own secret would select the global bot here and a system update would run
     * through the per-bot agent path — the failure Alia's AGENTS.md calls
     * critical, in the other direction.
     */
    await db.insert(bots).values({
      id: 'br-sysbot-secret',
      platform: 'br-sysroute',
      botId: 's1',
      name: 'System',
      webhookSecret: 'br-system-secret',
      status: 'active',
    });

    expect(
      await findActiveUserBotByWebhookSecret(db, 'br-system-secret', 'br-sysroute'),
    ).toBeNull();

    // Positive control: the same lookup DOES find a user-owned bot, so the null
    // above is the `user_id IS NOT NULL` predicate and not a broken query.
    await registerBot(
      db,
      newBot({ platform: 'br-sysroute', botId: 'u1', webhookSecret: 'br-user-secret' }),
    );
    expect(
      (await findActiveUserBotByWebhookSecret(db, 'br-user-secret', 'br-sysroute'))?.botId,
    ).toBe('u1');
  });

  it('will not match an INACTIVE user bot, or one on another platform', async () => {
    await registerBot(
      db,
      newBot({ platform: 'br-scope', botId: 'x1', webhookSecret: 'br-scope-secret' }),
    );

    // Right secret, wrong platform.
    expect(
      await findActiveUserBotByWebhookSecret(db, 'br-scope-secret', 'br-other-platform'),
    ).toBeNull();

    await db
      .update(bots)
      .set({ status: 'inactive' })
      .where(eq(bots.webhookSecret, 'br-scope-secret'));
    expect(await findActiveUserBotByWebhookSecret(db, 'br-scope-secret', 'br-scope')).toBeNull();
  });

  it('shows a user the system bots plus their OWN, and nobody else\'s', async () => {
    await seedSystemBot(db, { platform: 'br-vis', botId: 'sys', name: 'System' });
    await registerBot(db, newBot({ platform: 'br-vis', botId: 'mine', userId: 'bru-vis-me' }));
    await registerBot(db, newBot({ platform: 'br-vis', botId: 'theirs', userId: 'bru-vis-them' }));

    const visible = await listVisibleBots(db, 'bru-vis-me');
    const onThisPlatform = visible.filter((b) => b.platform === 'br-vis').map((b) => b.botId);
    expect(onThisPlatform.sort()).toEqual(['mine', 'sys']);
  });

  it('hides an INACTIVE bot from the list', async () => {
    const bot = await registerBot(
      db,
      newBot({ platform: 'br-inactive', botId: 'i1', userId: 'bru-inactive' }),
    );
    if (!bot) throw new Error('registerBot returned null');
    expect((await listVisibleBots(db, 'bru-inactive')).some((b) => b.id === bot.id)).toBe(true);

    await db.update(bots).set({ status: 'inactive' }).where(eq(bots.id, bot.id));
    expect((await listVisibleBots(db, 'bru-inactive')).some((b) => b.id === bot.id)).toBe(false);
  });
});

describe('a platform identity belongs to exactly one bot', () => {
  it('answers NULL rather than storing a rival registration', async () => {
    const first = await registerBot(db, newBot({ platform: 'br-dup', botId: 'd1' }));
    expect(first).not.toBeNull();

    const second = await registerBot(
      db,
      newBot({ platform: 'br-dup', botId: 'd1', userId: 'bru-other' }),
    );
    expect(second).toBeNull();

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(bots)
      .where(eq(bots.platform, 'br-dup'));
    expect(n).toBe(1);
  });

  it('finds an existing registration by platform identity', async () => {
    await registerBot(db, newBot({ platform: 'br-ident', botId: 'i1' }));
    expect((await findBotByPlatformIdentity(db, 'br-ident', 'i1'))?.botId).toBe('i1');
    expect(await findBotByPlatformIdentity(db, 'br-ident', 'nope')).toBeNull();
  });

  it('seeds a system bot ONCE and never overwrites it afterwards', async () => {
    await seedSystemBot(db, { platform: 'br-seed', botId: 's1', name: 'Original' });
    await seedSystemBot(db, { platform: 'br-seed', botId: 's1', name: 'Renamed' });

    // `$setOnInsert` semantics: a hand-edited name survives a restart.
    expect((await findSystemBot(db, 'br-seed'))?.name).toBe('Original');
  });
});

describe('the agent binding can be CLEARED', () => {
  it('writes NULL rather than silently doing nothing', async () => {
    /**
     * The source assigned `undefined`, which unset the field in Mongo. The same
     * assignment through drizzle is a no-op, so the bot would keep answering
     * with the old agent's prompt while the UI showed it unbound.
     */
    const bot = await registerBot(
      db,
      newBot({ platform: 'br-agent', botId: 'a1', agentId: 'agent-1' }),
    );
    if (!bot) throw new Error('registerBot returned null');
    expect(bot.agentId).toBe('agent-1');

    const cleared = await setBotAgent(db, bot.id, 'bru-owner', null);
    expect(cleared?.agentId).toBeNull();
  });

  it('will not let a non-owner rebind it', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-agentown', botId: 'a2' }));
    if (!bot) throw new Error('registerBot returned null');

    expect(await setBotAgent(db, bot.id, 'bru-intruder', 'agent-2')).toBeNull();
    expect((await findOwnedBot(db, bot.id, 'bru-owner'))?.agentId).toBeNull();
  });

  it('never matches a SYSTEM bot as owned', async () => {
    await seedSystemBot(db, { platform: 'br-sysown', botId: 's1', name: 'System' });
    const system = await findSystemBot(db, 'br-sysown');
    if (!system) throw new Error('system bot missing');

    // The delete route relies on this: a system bot has no owner, so no user id
    // can select it and nobody can delete the global bot through that route.
    expect(await findOwnedBot(db, system.id, 'bru-anyone')).toBeNull();
    expect(await findOwnedBotWithToken(db, system.id, 'bru-anyone')).toBeNull();
  });
});

describe('deleting a bot takes its users with it', () => {
  it('cascades, which is the structural version of the explicit deleteMany', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-cascade', botId: 'c1' }));
    if (!bot) throw new Error('registerBot returned null');
    await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-cascade',
      platformUserId: 'p1',
      chatId: 'c1',
    });

    await deleteBot(db, bot.id);

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(botUsers)
      .where(eq(botUsers.botId, bot.id));
    expect(n).toBe(0);
  });
});

describe('a bot user is upserted, not read-then-branched', () => {
  it('creates once and refreshes on the second call', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-upsert', botId: 'u1' }));
    if (!bot) throw new Error('registerBot returned null');

    const first = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-upsert',
      platformUserId: 'p1',
      chatId: 'chat-1',
      username: 'first',
    });
    const second = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-upsert',
      platformUserId: 'p1',
      chatId: 'chat-2',
      username: 'second',
    });

    expect(second.id).toBe(first.id);
    expect(second.chatId).toBe('chat-2');
    expect(second.username).toBe('second');
  });

  it('does not blank a stored display name when the update omits it', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-omit', botId: 'o1' }));
    if (!bot) throw new Error('registerBot returned null');

    await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-omit',
      platformUserId: 'p1',
      chatId: 'c1',
      displayName: 'Known Name',
    });
    const after = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-omit',
      platformUserId: 'p1',
      chatId: 'c2',
    });

    expect(after.displayName).toBe('Known Name');
    expect(after.chatId).toBe('c2');
  });

  it('MERGES metadata rather than replacing it', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-meta', botId: 'm1' }));
    if (!bot) throw new Error('registerBot returned null');

    await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-meta',
      platformUserId: 'p1',
      chatId: 'c1',
      metadata: { a: 1 },
    });
    const after = await upsertBotUser(db, {
      botId: bot.id,
      platform: 'br-meta',
      platformUserId: 'p1',
      chatId: 'c1',
      metadata: { b: 2 },
    });

    expect(after.metadata).toEqual({ a: 1, b: 2 });
  });

  it('scopes the platform user to the BOT, so two bots can serve one person', async () => {
    const a = await registerBot(db, newBot({ platform: 'br-two', botId: 'b1' }));
    const b = await registerBot(db, newBot({ platform: 'br-two', botId: 'b2' }));
    if (!a || !b) throw new Error('registerBot returned null');

    const ua = await upsertBotUser(db, {
      botId: a.id, platform: 'br-two', platformUserId: 'same-person', chatId: 'c1',
    });
    const ub = await upsertBotUser(db, {
      botId: b.id, platform: 'br-two', platformUserId: 'same-person', chatId: 'c2',
    });

    expect(ua.id).not.toBe(ub.id);
  });
});

describe('a link token is single-use, and unlinking really unlinks', () => {
  it('CLEARS the auth token on redemption, so it cannot be redeemed twice', async () => {
    /**
     * The security-relevant half of the port. `botUser.authToken = undefined`
     * unset the column in Mongo; through drizzle it is a silent no-op, and a
     * redeemed one-time link token would stay live for its remaining 15 minutes
     * — redeemable AGAIN, by anyone still holding it, into a DIFFERENT account.
     */
    const bot = await registerBot(db, newBot({ platform: 'br-link', botId: 'l1' }));
    if (!bot) throw new Error('registerBot returned null');
    const botUser = await upsertBotUser(db, {
      botId: bot.id, platform: 'br-link', platformUserId: 'p1', chatId: 'c1',
    });
    await setBotUserAuthToken(db, botUser.id, 'br-once', new Date(Date.now() + 60_000));

    // First redemption succeeds.
    expect(await findBotUserByAuthToken(db, bot.id, 'br-once')).not.toBeNull();
    const linked = await linkBotUser(db, botUser.id, {
      oxyUserId: 'bru-linker',
      sessionToken: 'sess-abc',
    });
    expect(linked?.isLinked).toBe(true);
    expect(linked?.oxyUserId).toBe('bru-linker');
    expect(linked?.linkedAt).toBeInstanceOf(Date);
    expect(linked?.metadata).toEqual({ sessionToken: 'sess-abc' });

    // The token is GONE — a second attacker holding it gets nothing.
    expect(await findBotUserByAuthToken(db, bot.id, 'br-once')).toBeNull();
    const raw = await db.execute<{ t: string | null; e: string | null }>(
      sql`select auth_token as t, auth_token_expiry as e from ${botUsers} where id = ${botUser.id}`,
    );
    expect(raw[0]?.t).toBeNull();
    expect(raw[0]?.e).toBeNull();
  });

  it('unlinks and detaches the conversation, so the next message starts fresh', async () => {
    const bot = await registerBot(db, newBot({ platform: 'br-unlink', botId: 'u1' }));
    if (!bot) throw new Error('registerBot returned null');
    const botUser = await upsertBotUser(db, {
      botId: bot.id, platform: 'br-unlink', platformUserId: 'p1', chatId: 'c1',
    });
    await linkBotUser(db, botUser.id, { oxyUserId: 'bru-unlinker' });
    await setBotUserConversation(db, botUser.id, 'conv-1');
    expect((await findLinkedBotUser(db, bot.id, 'bru-unlinker'))?.conversationId).toBe('conv-1');

    await unlinkBotUser(db, botUser.id);

    const after = await findBotUser(db, bot.id, 'p1');
    expect(after?.isLinked).toBe(false);
    expect(after?.oxyUserId).toBeNull();
    expect(after?.conversationId).toBeNull();
    expect(after?.linkedAt).toBeNull();
    expect(await findLinkedBotUser(db, bot.id, 'bru-unlinker')).toBeNull();
  });

  it('logout keeps linked_at as the historical record, unlike unlink', async () => {
    // The two differ by exactly one column, and the source wrote them that way.
    const bot = await registerBot(db, newBot({ platform: 'br-logout', botId: 'g1' }));
    if (!bot) throw new Error('registerBot returned null');
    const botUser = await upsertBotUser(db, {
      botId: bot.id, platform: 'br-logout', platformUserId: 'p1', chatId: 'c1',
    });
    await linkBotUser(db, botUser.id, { oxyUserId: 'bru-logout' });

    await logoutBotUser(db, botUser.id);

    const after = await findBotUser(db, bot.id, 'p1');
    expect(after?.isLinked).toBe(false);
    expect(after?.oxyUserId).toBeNull();
    expect(after?.linkedAt).toBeInstanceOf(Date);
  });
});
