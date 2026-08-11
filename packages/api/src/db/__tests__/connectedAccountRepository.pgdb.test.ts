import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { isCheckViolation, constraintNameOf } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { connectedAccounts } from '../schema/integrations';
import {
  completeGmailConnection,
  createPendingConnectedAccount,
  deleteConnectedAccount,
  deleteConnectedAccountForUser,
  findConnectedAccountForChannel,
  findConnectedAccountForUser,
  listConnectedAccountsForUser,
  setConnectedAccountSession,
  setConnectedAccountStatus,
  updateConnectedAccountSettings,
} from '../integrations/connectedAccountRepository';

/**
 * Connected messaging accounts, against a REAL server.
 *
 * Ids are prefixed `cau-` and every list is scoped to a user this file created.
 */

let db: ApiDatabase;

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

async function pending(oxyUserId: string, platform = 'whatsapp') {
  return createPendingConnectedAccount(db, {
    oxyUserId,
    platform,
    capabilities: ['read_messages', 'send_messages'],
  });
}

describe('the OAuth tokens never reach a response, which is a CHANGE', () => {
  it('stores them encrypted and serves a shape that has no token field', async () => {
    /**
     * The source's `oauthTokens` sub-document was `{ toJSON: { getters: true } }`
     * with NO `select: false`, so `res.json({ account })` put a `gmail.send`
     * scoped access token on the wire in the CLEAR. Measured against the real
     * model before this port: the stored value is ciphertext and the serialized
     * document contains the plaintext.
     *
     * The safe projection has no token field, so the leak closes by
     * construction rather than by remembering a `.select()`. Nothing read what
     * it drops — `packages/app/lib/hooks/use-connected-accounts.ts:6` declares
     * the DTO and `oauthTokens` is not in it.
     */
    const account = await pending('cau-gmail', 'gmail');
    const connected = await completeGmailConnection(db, account.id, {
      email: 'a@b.c',
      displayName: 'A',
      accessToken: 'PLAINTEXT-GMAIL-ACCESS',
      refreshToken: 'PLAINTEXT-GMAIL-REFRESH',
      scope: 'gmail.send',
    });
    if (!connected) throw new Error('gmail completion returned null');

    // Encrypted at rest.
    const raw = await db.execute<{ at: string; rt: string }>(
      sql`select oauth_access_token as at, oauth_refresh_token as rt
          from ${connectedAccounts} where id = ${account.id}`,
    );
    expect(raw[0]?.at).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(raw[0]?.rt).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

    // And absent from every shape a caller can obtain. Structural, because
    // `toBeUndefined()` on a column that was never selected passes identically
    // against a leak of `null`.
    for (const shape of [
      connected,
      (await listConnectedAccountsForUser(db, 'cau-gmail'))[0],
      await findConnectedAccountForUser(db, account.id, 'cau-gmail'),
    ]) {
      const keys = Object.keys(shape ?? {});
      expect(keys).not.toContain('oauthAccessToken');
      expect(keys).not.toContain('oauthRefreshToken');
      expect(keys).not.toContain('oauthTokens');
    }

    // The floor: the projection really did return the row, so the absences above
    // are a column list and not an empty result.
    expect(connected.email).toBe('a@b.c');
    expect(connected.status).toBe('connected');
    expect(connected._id).toBe(connected.id);
  });

  it('refuses a HALF-WRITTEN OAuth group, which Mongo could not express', async () => {
    /**
     * The sub-document's `required` applied only when the sub-document itself
     * was present, so a refresh token with no access token was storable. The
     * CHECK makes the group atomic — asserted by constraint NAME, so a different
     * failure cannot pass as this one.
     */
    const account = await pending('cau-halfoauth', 'gmail');

    let caught: unknown;
    try {
      await db
        .update(connectedAccounts)
        .set({ oauthRefreshToken: 'orphan-refresh' })
        .where(sql`${connectedAccounts.id} = ${account.id}`);
    } catch (err) {
      caught = err;
    }

    expect(isCheckViolation(caught)).toBe(true);
    expect(constraintNameOf(caught)).toBe('connected_accounts_oauth_pair_check');
  });
});

describe('a settings patch can CLEAR a field, which `undefined` no longer does', () => {
  it('clears the auto-reply agent when the client sends null', async () => {
    /**
     * The source assigned `undefined`, which UNSET the field in Mongo. In
     * drizzle `.set({ x: undefined })` is a silent no-op, so the agent would
     * have stayed bound while the UI showed it cleared — the plausible wrong
     * answer, with nothing raised.
     */
    const account = await pending('cau-settings');
    await updateConnectedAccountSettings(db, account.id, 'cau-settings', {
      autoReplyAgentId: 'agent-1',
      autoReply: true,
    });
    expect((await findConnectedAccountForUser(db, account.id, 'cau-settings'))?.autoReplyAgentId)
      .toBe('agent-1');

    const cleared = await updateConnectedAccountSettings(db, account.id, 'cau-settings', {
      autoReplyAgentId: null,
    });

    expect(cleared?.autoReplyAgentId).toBeNull();
    // And a field the patch did NOT mention survives.
    expect(cleared?.autoReply).toBe(true);
  });

  it('clears the tool lists the same way', async () => {
    const account = await pending('cau-tools');
    await updateConnectedAccountSettings(db, account.id, 'cau-tools', {
      allowedTools: ['a', 'b'],
      blockedTools: ['c'],
      allowedSkillIds: ['s1'],
    });

    const cleared = await updateConnectedAccountSettings(db, account.id, 'cau-tools', {
      allowedTools: null,
      allowedSkillIds: null,
    });

    expect(cleared?.allowedTools).toBeNull();
    expect(cleared?.allowedSkillIds).toBeNull();
    // Untouched.
    expect(cleared?.blockedTools).toEqual(['c']);
  });

  it('answers the current row for an EMPTY patch rather than raising', async () => {
    const account = await pending('cau-emptypatch');
    const same = await updateConnectedAccountSettings(db, account.id, 'cau-emptypatch', {});
    expect(same?.id).toBe(account.id);
  });

  it('will not patch another user\'s account', async () => {
    const account = await pending('cau-owner');
    expect(
      await updateConnectedAccountSettings(db, account.id, 'cau-intruder', { autoReply: true }),
    ).toBeNull();
    expect((await findConnectedAccountForUser(db, account.id, 'cau-owner'))?.autoReply).toBe(false);
  });
});

describe('a status sync does not erase what the poll omitted', () => {
  it('keeps a stored display name when the reply carries none', async () => {
    const account = await pending('cau-sync');
    await setConnectedAccountStatus(db, account.id, {
      status: 'connected',
      displayName: 'Known Name',
      phoneNumber: '+100',
    });

    const later = await setConnectedAccountStatus(db, account.id, { status: 'expired' });

    expect(later?.status).toBe('expired');
    expect(later?.displayName).toBe('Known Name');
    expect(later?.phoneNumber).toBe('+100');
  });
});

describe('the readers are scoped as the routes need', () => {
  it('lists newest first, and filters by platform when asked', async () => {
    const user = 'cau-list';
    await pending(user, 'whatsapp');
    await pending(user, 'telegram');
    await pending(user, 'telegram');

    const all = await listConnectedAccountsForUser(db, user);
    expect(all).toHaveLength(3);
    expect(all[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(
      all[all.length - 1]?.createdAt.getTime() ?? 0,
    );

    const telegram = await listConnectedAccountsForUser(db, user, 'telegram');
    expect(telegram).toHaveLength(2);
    expect(telegram.every((a) => a.platform === 'telegram')).toBe(true);
  });

  it('gives outbound delivery only a CONNECTED account', async () => {
    const user = 'cau-channel';
    const account = await pending(user, 'whatsapp');

    // `connecting` — there is no live session to send through.
    expect(await findConnectedAccountForChannel(db, user, 'whatsapp')).toBeNull();

    await setConnectedAccountStatus(db, account.id, { status: 'connected' });
    expect((await findConnectedAccountForChannel(db, user, 'whatsapp'))?.id).toBe(account.id);

    await setConnectedAccountStatus(db, account.id, { status: 'disconnected' });
    expect(await findConnectedAccountForChannel(db, user, 'whatsapp')).toBeNull();
  });

  it('deletes only the caller\'s own account, and cleans up an orphan by id', async () => {
    const account = await pending('cau-del');
    expect(await deleteConnectedAccountForUser(db, account.id, 'cau-someone-else')).toBeNull();
    expect(await findConnectedAccountForUser(db, account.id, 'cau-del')).not.toBeNull();

    const removed = await deleteConnectedAccountForUser(db, account.id, 'cau-del');
    expect(removed?.id).toBe(account.id);

    // The connect-failure cleanup path is NOT user-scoped — the caller created
    // the row moments earlier and holds its id.
    const orphan = await pending('cau-orphan');
    await deleteConnectedAccount(db, orphan.id);
    expect(await findConnectedAccountForUser(db, orphan.id, 'cau-orphan')).toBeNull();
  });

  it('attaches a session id and answers null for an id of any shape', async () => {
    const account = await pending('cau-session');
    await setConnectedAccountSession(db, account.id, 'sess-1');
    expect((await findConnectedAccountForUser(db, account.id, 'cau-session'))?.sessionId).toBe(
      'sess-1',
    );

    expect(await findConnectedAccountForUser(db, 'not-an-object-id', 'cau-session')).toBeNull();
  });
});
