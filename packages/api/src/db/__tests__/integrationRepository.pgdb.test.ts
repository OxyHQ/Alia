import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { integrations } from '../schema/integrations';
import {
  createIntegration,
  deleteIntegrationForUser,
  findEnabledIntegrationTokens,
  findIntegrationForUser,
  listConnectedServices,
  listIntegrationsForUser,
  saveRefreshedIntegrationTokens,
  setIntegrationStatus,
  touchIntegrationLastUsed,
  type NewIntegration,
} from '../integrations/integrationRepository';
import {
  consumeOAuthState,
  createOAuthState,
  findLiveOAuthState,
  OAUTH_STATE_TTL_MS,
} from '../integrations/oauthStateRepository';

/**
 * OAuth integrations and their state store, against a REAL server.
 *
 * The assertions that matter are about WHAT REACHES A CALLER. An encrypted
 * column that is projected is worse than a plaintext one that is not, because
 * `fromDriver` decrypts on the way out — so "the token is encrypted at rest" is
 * necessary and nowhere near sufficient, and the projection tests below are the
 * other half.
 *
 * Ids are prefixed `intu-` and every count is scoped to rows this file inserted.
 */

let db: ApiDatabase;

function newIntegration(overrides: Partial<NewIntegration> = {}): NewIntegration {
  return {
    oxyUserId: 'intu-1',
    service: 'google-calendar',
    displayName: 'Google Calendar',
    accessToken: 'plaintext-access-token',
    refreshToken: 'plaintext-refresh-token',
    expiresAt: new Date(Date.now() + 3_600_000),
    scope: 'calendar.readonly',
    tokenType: 'Bearer',
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

describe('a token is encrypted at rest AND kept out of every response', () => {
  it('stores ciphertext, and the codec runs however the write is spelled', async () => {
    /**
     * In Mongo this held because of a `set: encrypt` FIELD setter, which a
     * dotted-path `updateOne()` bypassed — `lib/integration-token.ts` had to
     * reach for `document.save()` specifically to avoid storing a refreshed
     * token in the clear. The codec is on the COLUMN now, so there is no
     * spelling through the query builder that skips it, and this asserts that
     * for BOTH an insert and an update.
     */
    const created = await createIntegration(db, newIntegration({ oxyUserId: 'intu-cipher' }));

    const raw = await db.execute<{ at: string; rt: string }>(
      sql`select oauth_access_token as at, oauth_refresh_token as rt
          from ${integrations} where id = ${created.id}`,
    );
    expect(raw[0]?.at).not.toBe('plaintext-access-token');
    expect(raw[0]?.at).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(raw[0]?.rt).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

    // The UPDATE path — the one the Mongoose setter did not cover.
    await saveRefreshedIntegrationTokens(db, created.id, { accessToken: 'refreshed-token' });
    const rawAfter = await db.execute<{ at: string }>(
      sql`select oauth_access_token as at from ${integrations} where id = ${created.id}`,
    );
    expect(rawAfter[0]?.at).not.toBe('refreshed-token');
    expect(rawAfter[0]?.at).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

    const tokens = await findEnabledIntegrationTokens(db, 'intu-cipher', 'google-calendar');
    expect(tokens?.accessToken).toBe('refreshed-token');
  });

  it('does not put a token in the shape the CREATE response serves', async () => {
    const created = await createIntegration(db, newIntegration({ oxyUserId: 'intu-create' }));

    // Structural, not a value check: `toBeUndefined()` on a key that was never
    // selected passes identically against a row that has no token and a row
    // whose token was handed out as `null`.
    const keys = Object.keys(created);
    expect(keys).not.toContain('oauthAccessToken');
    expect(keys).not.toContain('oauthRefreshToken');
    expect(keys).not.toContain('accessToken');
    expect(keys).not.toContain('refreshToken');
    // The floor: the projection really did return the row's own fields.
    expect(created.service).toBe('google-calendar');
    expect(created._id).toBe(created.id);
  });

  it('does not put a token in the LIST or the STATUS shape either', async () => {
    await createIntegration(db, newIntegration({ oxyUserId: 'intu-list' }));

    const [listed] = await listIntegrationsForUser(db, 'intu-list');
    if (!listed) throw new Error('list returned nothing');
    expect(Object.keys(listed)).not.toContain('oauthAccessToken');

    const found = await findIntegrationForUser(db, listed.id, 'intu-list');
    if (!found) throw new Error('find returned nothing');
    expect(Object.keys(found)).not.toContain('oauthAccessToken');
    expect(Object.keys(found).sort()).toEqual([
      '_id',
      'accountId',
      'accountName',
      'avatarUrl',
      'connectedAt',
      'createdAt',
      'displayName',
      'enabled',
      'id',
      'lastUsedAt',
      'metadata',
      'service',
      'status',
      'updatedAt',
    ]);
  });

  it('produces a DIFFERENT ciphertext each time, which is why nothing may match on it', async () => {
    /**
     * The asymmetry this slice was assigned to protect, stated where it is load-
     * bearing rather than only in a schema test. `bots.webhook_secret` and
     * `bot_users.auth_token` are PLAINTEXT precisely because they are matched on
     * by value; these two columns are encrypted precisely because they never
     * are. Making "the secrets consistent" in either direction breaks something:
     * encrypt a lookup key and inbound routing silently 404s forever; leave a
     * read-only token in the clear and a dump leaks it.
     *
     * The mechanism is here so a future author sees the cost before making the
     * change: a random IV means the same plaintext stores differently every
     * time, so an equality predicate on these columns can never match.
     */
    const a = await createIntegration(
      db,
      newIntegration({ oxyUserId: 'intu-iv-a', accessToken: 'identical-token' }),
    );
    const b = await createIntegration(
      db,
      newIntegration({ oxyUserId: 'intu-iv-b', accessToken: 'identical-token' }),
    );

    const raw = await db.execute<{ id: string; at: string }>(
      sql`select id, oauth_access_token as at from ${integrations}
          where id in (${a.id}, ${b.id})`,
    );
    expect(raw).toHaveLength(2);
    expect(raw[0]?.at).not.toBe(raw[1]?.at);

    // And the consequence, demonstrated rather than asserted in prose: a
    // by-value filter finds NOTHING even though two rows hold that plaintext.
    const matched = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(integrations)
      .where(sql`${integrations.oauthAccessToken} = 'identical-token'`);
    expect(matched[0]?.n).toBe(0);
  });
});

describe('a refresh keeps what the provider did not send', () => {
  it('does NOT erase a long-lived refresh token when only the access token rotates', async () => {
    /**
     * The source wrote `if (data.refresh_token) integration.oauthTokens.refreshToken = …`,
     * so a provider that rotates only the access token kept its refresh token.
     * `.set({ oauthRefreshToken: null })` would discard it, and the NEXT refresh
     * would then fail with "no refresh token available — please reconnect",
     * which reads as the user's problem rather than as this bug.
     */
    const created = await createIntegration(db, newIntegration({ oxyUserId: 'intu-refresh' }));

    await saveRefreshedIntegrationTokens(db, created.id, { accessToken: 'rotated-access' });

    const tokens = await findEnabledIntegrationTokens(db, 'intu-refresh', 'google-calendar');
    expect(tokens?.accessToken).toBe('rotated-access');
    expect(tokens?.refreshToken).toBe('plaintext-refresh-token');
  });

  it('replaces the refresh token when the provider DOES rotate it', async () => {
    // The positive half — without it the assertion above passes just as well
    // against a repository that ignores `refreshToken` entirely.
    const created = await createIntegration(db, newIntegration({ oxyUserId: 'intu-rotate' }));

    await saveRefreshedIntegrationTokens(db, created.id, {
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
    });

    const tokens = await findEnabledIntegrationTokens(db, 'intu-rotate', 'google-calendar');
    expect(tokens?.refreshToken).toBe('rotated-refresh');
  });

  it('returns the integration to active, so a recovered one stops reporting expired', async () => {
    const created = await createIntegration(db, newIntegration({ oxyUserId: 'intu-recover' }));
    await setIntegrationStatus(db, created.id, 'expired');
    expect((await findIntegrationForUser(db, created.id, 'intu-recover'))?.status).toBe('expired');

    await saveRefreshedIntegrationTokens(db, created.id, { accessToken: 'new' });
    expect((await findIntegrationForUser(db, created.id, 'intu-recover'))?.status).toBe('active');
  });
});

describe('the readers are scoped exactly as the source was', () => {
  it('gives the tool builder only ENABLED, ACTIVE services', async () => {
    const user = 'intu-services';
    const ok = await createIntegration(db, newIntegration({ oxyUserId: user, service: 'google-calendar' }));
    const revoked = await createIntegration(db, newIntegration({ oxyUserId: user, service: 'google-drive' }));
    await setIntegrationStatus(db, revoked.id, 'revoked');

    expect(await listConnectedServices(db, user)).toEqual(['google-calendar']);
    // Vacuity floor: the user really does have two integrations.
    expect(await listIntegrationsForUser(db, user)).toHaveLength(2);
    expect(ok.status).toBe('active');
  });

  it('will not reach another account\'s integration by id', async () => {
    const created = await createIntegration(db, newIntegration({ oxyUserId: 'intu-owner' }));

    expect(await findIntegrationForUser(db, created.id, 'intu-intruder')).toBeNull();
    expect(await deleteIntegrationForUser(db, created.id, 'intu-intruder')).toBe(false);
    // Not merely unreported — still there.
    expect(await findIntegrationForUser(db, created.id, 'intu-owner')).not.toBeNull();

    expect(await deleteIntegrationForUser(db, created.id, 'intu-owner')).toBe(true);
    expect(await findIntegrationForUser(db, created.id, 'intu-owner')).toBeNull();
  });

  it('records a use against the right (user, service) pair only', async () => {
    const mine = await createIntegration(db, newIntegration({ oxyUserId: 'intu-touch' }));
    const other = await createIntegration(
      db,
      newIntegration({ oxyUserId: 'intu-touch', service: 'google-drive' }),
    );
    expect(mine.lastUsedAt).toBeNull();

    await touchIntegrationLastUsed(db, 'intu-touch', 'google-calendar');

    expect((await findIntegrationForUser(db, mine.id, 'intu-touch'))?.lastUsedAt).toBeInstanceOf(Date);
    expect((await findIntegrationForUser(db, other.id, 'intu-touch'))?.lastUsedAt).toBeNull();
  });

  it('answers null for an id of any shape rather than raising', async () => {
    expect(await findIntegrationForUser(db, 'not-an-object-id', 'intu-1')).toBeNull();
    expect(await deleteIntegrationForUser(db, 'not-an-object-id', 'intu-1')).toBe(false);
  });
});

describe('the OAuth state is the primary key, and single-use', () => {
  it('is found only for the SERVICE it was issued for', async () => {
    await createOAuthState(db, {
      state: 'int-state-1',
      service: 'google-calendar',
      userId: 'intu-state',
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    });

    expect(await findLiveOAuthState(db, 'int-state-1', 'google-calendar')).not.toBeNull();
    // Same token, wrong service — one predicate, one outcome.
    expect(await findLiveOAuthState(db, 'int-state-1', 'google-drive')).toBeNull();
  });

  it('is not returned once its deadline has passed', async () => {
    await createOAuthState(db, {
      state: 'int-state-2',
      service: 'google-calendar',
      userId: 'intu-state',
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    });

    const beforeDeadline = new Date(Date.now() + OAUTH_STATE_TTL_MS - 5_000);
    expect(await findLiveOAuthState(db, 'int-state-2', 'google-calendar', beforeDeadline)).not.toBeNull();

    const pastDeadline = new Date(Date.now() + OAUTH_STATE_TTL_MS + 5_000);
    expect(await findLiveOAuthState(db, 'int-state-2', 'google-calendar', pastDeadline)).toBeNull();
  });

  it('can be consumed exactly ONCE, which is the replay guard', async () => {
    await createOAuthState(db, {
      state: 'int-state-3',
      service: 'google-calendar',
      userId: 'intu-state',
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    });

    // A single call cannot tell an atomic delete from a read-then-delete; the
    // REPEAT is the discriminator, exactly as with a Mongo write count.
    expect(await consumeOAuthState(db, 'int-state-3')).toBe(true);
    expect(await consumeOAuthState(db, 'int-state-3')).toBe(false);
  });
});
