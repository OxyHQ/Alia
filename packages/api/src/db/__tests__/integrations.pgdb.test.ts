import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { connectedAccounts, integrations, oauthStates } from '../schema/integrations';

/**
 * The encrypted OAuth columns, against a REAL server.
 *
 * This is the file that matters most in the orgs/dev batch. In Mongo these
 * columns were protected by field-level `set: encrypt, get: decrypt`, so
 * encryption was true by CONSTRUCTION; drizzle has no getter/setter, and the
 * failure mode of porting them wrong is SILENT — the application keeps working
 * and third-party OAuth tokens sit in plaintext until a dump leaks.
 *
 * So the assertion cannot be "a round trip returns what I wrote": that passes
 * just as happily with no encryption at all. It has to read the RAW stored bytes
 * and prove they are not the plaintext.
 */

let db: ApiDatabase;

beforeAll(() => {
  // The custom type reads TOKEN_ENCRYPTION_KEY lazily, on first use rather than
  // at import, so setting it here is enough.
  process.env.TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

function integrationValues(overrides: Partial<typeof integrations.$inferInsert> = {}) {
  return {
    oxyUserId: 'oxy-user-1',
    service: 'github',
    displayName: 'GitHub',
    oauthAccessToken: 'plaintext-access-token',
    oauthScope: 'repo',
    oauthTokenType: 'bearer',
    connectedAt: new Date(),
    ...overrides,
  };
}

describe('an OAuth token is encrypted at rest, by construction', () => {
  it('stores ciphertext, not the plaintext the caller handed over', async () => {
    await db.insert(integrations).values(integrationValues({ id: 'int-enc' }));

    // The RAW column, read around the custom type. `db.execute` issues the
    // statement directly, so no `fromDriver` runs and this is what is on disk.
    const raw = await db.execute<{ token: string }>(
      sql`select oauth_access_token as token from ${integrations} where id = 'int-enc'`,
    );

    expect(raw[0]?.token).not.toBe('plaintext-access-token');
    expect(raw[0]?.token).not.toContain('plaintext');
    // `iv:authTag:ciphertext`, all hex — the shape crypto-utils produces.
    expect(raw[0]?.token).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
  });

  it('gives the plaintext back through the query builder', async () => {
    const [row] = await db
      .select({ token: integrations.oauthAccessToken })
      .from(integrations)
      .where(eq(integrations.id, 'int-enc'));

    expect(row?.token).toBe('plaintext-access-token');
  });

  it('encrypts a NULLABLE token column too, and leaves NULL alone', async () => {
    // The null path is the one a custom type most easily gets wrong: mapping a
    // null through `encrypt` would throw, and mapping it through `decrypt` on
    // read would too. Both directions are exercised here.
    await db.insert(integrations).values(
      integrationValues({ id: 'int-null-refresh', oauthRefreshToken: null }),
    );
    await db.insert(integrations).values(
      integrationValues({ id: 'int-has-refresh', oauthRefreshToken: 'plaintext-refresh' }),
    );

    const [nullRow] = await db
      .select({ token: integrations.oauthRefreshToken })
      .from(integrations)
      .where(eq(integrations.id, 'int-null-refresh'));
    expect(nullRow?.token).toBeNull();

    const [setRow] = await db
      .select({ token: integrations.oauthRefreshToken })
      .from(integrations)
      .where(eq(integrations.id, 'int-has-refresh'));
    expect(setRow?.token).toBe('plaintext-refresh');

    const raw = await db.execute<{ token: string }>(
      sql`select oauth_refresh_token as token from ${integrations} where id = 'int-has-refresh'`,
    );
    expect(raw[0]?.token).not.toBe('plaintext-refresh');
  });

  it('produces a DIFFERENT ciphertext each time, so equality on the column is meaningless', async () => {
    // AES-GCM with a random IV. Worth pinning because it rules out ever adding a
    // unique index or a lookup on one of these columns — a repository author
    // reaching for "find the row with this token" has to be stopped by something,
    // and this is the only place that says so.
    await db.insert(integrations).values(integrationValues({ id: 'int-iv-a' }));
    await db.insert(integrations).values(integrationValues({ id: 'int-iv-b' }));

    const raw = await db.execute<{ id: string; token: string }>(
      sql`select id, oauth_access_token as token from ${integrations} where id in ('int-iv-a', 'int-iv-b')`,
    );
    expect(raw).toHaveLength(2);
    expect(raw[0]?.token).not.toBe(raw[1]?.token);
  });
});

describe('a connected account carries its OAuth group whole or not at all', () => {
  function connectedAccountValues(overrides: Partial<typeof connectedAccounts.$inferInsert> = {}) {
    return { oxyUserId: 'oxy-user-1', platform: 'whatsapp', accountId: 'acct-1', ...overrides };
  }

  it('accepts an account with no OAuth at all, which is the common case', async () => {
    await db.insert(connectedAccounts).values(connectedAccountValues({ id: 'ca-none' }));

    const [row] = await db
      .select({ token: connectedAccounts.oauthAccessToken, status: connectedAccounts.status })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, 'ca-none'));
    expect(row?.token).toBeNull();
    expect(row?.status).toBe('connecting');
  });

  it('accepts a complete OAuth group', async () => {
    await db.insert(connectedAccounts).values(
      connectedAccountValues({
        id: 'ca-full',
        oauthAccessToken: 'ca-plaintext',
        oauthScope: 'messages:read',
      }),
    );

    const raw = await db.execute<{ token: string }>(
      sql`select oauth_access_token as token from ${connectedAccounts} where id = 'ca-full'`,
    );
    expect(raw[0]?.token).not.toBe('ca-plaintext');
  });

  it('refuses a refresh token with no access token', async () => {
    // Mongo could not state this: the sub-document's `required` applied only when
    // the sub-document was present at all, so a half-written group was storable.
    const insert = db.execute(sql`
      insert into ${connectedAccounts} (id, oxy_user_id, platform, account_id, oauth_refresh_token)
      values ('ca-half', 'oxy-user-1', 'whatsapp', 'acct-2', 'ciphertext-here')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('connected_accounts_oauth_pair_check');
      return true;
    });
  });
});

describe('the integrations OAuth state is keyed by the token itself', () => {
  it('refuses a state row with no id, because there is no default to invent one', async () => {
    // Mongo declared `_id: String` and wrote the random state into it. A
    // `generatedId()` default would mint a row the callback could never find —
    // the `user_credits` mistake, one domain over.
    const insert = db.execute(sql`
      insert into ${oauthStates} (service, user_id, expires_at)
      values ('github', 'oxy-user-1', now())
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect((error as { cause?: { code?: string } }).cause?.code).toBe('23502');
      return true;
    });
  });

  it('accepts the state token as the primary key', async () => {
    await db.insert(oauthStates).values({
      id: 'random-state-token',
      service: 'github',
      userId: 'oxy-user-1',
      expiresAt: new Date(Date.now() + 600_000),
    });

    const [row] = await db
      .select({ id: oauthStates.id })
      .from(oauthStates)
      .where(eq(oauthStates.id, 'random-state-token'));
    expect(row?.id).toBe('random-state-token');
  });
});
