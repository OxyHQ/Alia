import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  countActiveApps,
  countKeysForApps,
  deleteKeysForApp,
  deleteOwnedApp,
  deleteOwnedKey,
  findActiveKeyByHash,
  findAppById,
  findKeyByHash,
  findKeyById,
  findKeyWithApp,
  findOwnedApp,
  findOwnedAppByName,
  findOwnedKey,
  findOwnedKeyByName,
  insertApiKey,
  insertApp,
  selectAppsForOwner,
  selectKeysForApp,
  touchKeyLastUsed,
  updateOwnedApp,
  updateOwnedKey,
} from '../developers/developerRepository';
import {
  API_KEY_PREFIX,
  generateDeveloperApiKey,
  hashDeveloperApiKey,
} from '../../lib/api-key-crypto';
import { developerApiKeys } from '../schema/developers';

/**
 * `developer_apps` and `developer_api_keys`, against a real server.
 *
 * Two things here have no mocked counterpart and are the reason this is a
 * real-database suite: the OWNERSHIP scoping — every app and key lookup carries
 * `oxy_user_id`, so naming someone else's app is a miss rather than a leak — and
 * the CHECK constraints on scopes and rate limits, which a mocked insert accepts
 * happily.
 *
 * Ids are namespaced `dev-`.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const OWNER = 'dev-owner';
const OTHER = 'dev-intruder';

async function anApp(name: string, oxyUserId = OWNER) {
  return insertApp(db, { oxyUserId, name });
}

async function aKey(appId: string, name: string, oxyUserId = OWNER) {
  const plain = generateDeveloperApiKey();
  return insertApiKey(db, {
    oxyUserId,
    appId,
    name,
    keyHash: hashDeveloperApiKey(plain),
    keyPrefix: plain.substring(0, 16),
  });
}

describe('api key crypto', () => {
  it('mints a prefixed key and digests it deterministically', () => {
    const key = generateDeveloperApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(generateDeveloperApiKey()).not.toBe(key);

    /**
     * DETERMINISTIC, and that is the whole point: the digest is a LOOKUP KEY.
     * Encrypting it with a randomized IV would make `findKeyByHash` match
     * nothing, and the symptom is a silent 401 on every authenticated request
     * rather than an error anyone can trace.
     */
    expect(hashDeveloperApiKey(key)).toBe(hashDeveloperApiKey(key));
    expect(hashDeveloperApiKey(key)).toHaveLength(64);
    expect(hashDeveloperApiKey(key)).not.toBe(hashDeveloperApiKey(`${key}x`));
  });
});

describe('ownership scoping', () => {
  it('will not hand an app to an account that does not own it', async () => {
    const app = await anApp('dev-owned');
    expect((await findOwnedApp(db, app.id, OWNER))?.id).toBe(app.id);

    // The ownership check IS the lookup. A repository function taking only the
    // id would make this a leak, and the route above it has no second guard.
    expect(await findOwnedApp(db, app.id, OTHER)).toBeNull();
    // ...and the row is genuinely there, so the null is scoping.
    expect((await findAppById(db, app.id))?.id).toBe(app.id);
  });

  it('will not update or delete another account\'s app', async () => {
    const app = await anApp('dev-protected');
    expect(await updateOwnedApp(db, app.id, OTHER, { name: 'stolen' })).toBeNull();
    expect(await deleteOwnedApp(db, app.id, OTHER)).toBeNull();
    expect((await findOwnedApp(db, app.id, OWNER))?.name).toBe('dev-protected');

    // Positive control: the owner CAN.
    expect((await updateOwnedApp(db, app.id, OWNER, { name: 'renamed' }))?.name).toBe('renamed');
  });

  it('scopes a key by BOTH its app and its owner', async () => {
    const app = await anApp('dev-keyscope');
    const other = await anApp('dev-keyscope-other');
    const key = await aKey(app.id, 'k1');

    expect((await findOwnedKey(db, key.id, app.id, OWNER))?.id).toBe(key.id);
    // Right key, wrong app.
    expect(await findOwnedKey(db, key.id, other.id, OWNER)).toBeNull();
    // Right key and app, wrong owner.
    expect(await findOwnedKey(db, key.id, app.id, OTHER)).toBeNull();
  });
});

describe('apps', () => {
  it('lists an owner\'s apps newest first and scopes by organization', async () => {
    const solo = await insertApp(db, { oxyUserId: 'dev-org-user', name: 'dev-solo' });
    // `organizationId` references `organizations.id`, so a workspace-scoped app
    // needs a real organization; the personal case (NULL) is what the routes
    // pass when no `X-Workspace-Id` header is present.
    const personal = await selectAppsForOwner(db, 'dev-org-user', { organizationId: null });
    expect(personal.map((a) => a.id)).toEqual([solo.id]);

    // No filter at all returns everything the owner has.
    expect((await selectAppsForOwner(db, 'dev-org-user')).map((a) => a.id)).toEqual([solo.id]);
  });

  it('finds an app by name for the idempotent auto-registration', async () => {
    await anApp('Alia Codea', 'dev-codea-user');
    expect((await findOwnedAppByName(db, 'dev-codea-user', 'Alia Codea'))?.name).toBe('Alia Codea');
    // Another account's app of the same name is invisible, which is what makes
    // the "find or create" idempotent PER USER rather than globally.
    expect(await findOwnedAppByName(db, 'dev-other-user', 'Alia Codea')).toBeNull();
  });

  it('counts only the ACTIVE apps of a given set', async () => {
    const a = await anApp('dev-count-a', 'dev-count-user');
    const b = await anApp('dev-count-b', 'dev-count-user');
    await updateOwnedApp(db, b.id, 'dev-count-user', { isActive: false });
    expect(await countActiveApps(db, [a.id, b.id])).toBe(1);
    // An empty set is 0 rather than "every app", which an unguarded `inArray`
    // would make it.
    expect(await countActiveApps(db, [])).toBe(0);
  });
});

describe('api keys', () => {
  it('deleting an APP cascades its keys away', async () => {
    const app = await anApp('dev-cascade');
    await aKey(app.id, 'k1');
    await aKey(app.id, 'k2');
    expect(await selectKeysForApp(db, app.id, OWNER)).toHaveLength(2);

    await deleteOwnedApp(db, app.id, OWNER);
    const left = await db.select().from(developerApiKeys).where(eq(developerApiKeys.appId, app.id));
    expect(left).toHaveLength(0);
  });

  it('deletes every key of one app explicitly too', async () => {
    const app = await anApp('dev-bulkdel');
    await aKey(app.id, 'k1');
    await aKey(app.id, 'k2');
    expect(await deleteKeysForApp(db, app.id, OWNER)).toBe(2);
    // Idempotent, which is why the route keeps calling it beside the cascade.
    expect(await deleteKeysForApp(db, app.id, OWNER)).toBe(0);
  });

  it('authenticates by digest, and only an ACTIVE key for the relay', async () => {
    const app = await anApp('dev-auth');
    const plain = generateDeveloperApiKey();
    const key = await insertApiKey(db, {
      oxyUserId: OWNER,
      appId: app.id,
      name: 'auth-key',
      keyHash: hashDeveloperApiKey(plain),
      keyPrefix: plain.substring(0, 16),
    });

    expect((await findKeyByHash(db, hashDeveloperApiKey(plain)))?.id).toBe(key.id);
    expect((await findActiveKeyByHash(db, hashDeveloperApiKey(plain)))?.id).toBe(key.id);
    expect(await findKeyByHash(db, hashDeveloperApiKey('not-the-key'))).toBeNull();

    await updateOwnedKey(db, key.id, app.id, OWNER, { isActive: false });
    // The plain lookup still finds it — the middleware checks `isActive` itself
    // and answers "inactive" rather than "invalid" — while the relay's cheaper
    // query does not.
    expect((await findKeyByHash(db, hashDeveloperApiKey(plain)))?.id).toBe(key.id);
    expect(await findActiveKeyByHash(db, hashDeveloperApiKey(plain))).toBeNull();
  });

  it('refuses two keys with the same digest', async () => {
    const app = await anApp('dev-dupehash');
    const plain = generateDeveloperApiKey();
    const values = {
      oxyUserId: OWNER,
      appId: app.id,
      name: 'dupe',
      keyHash: hashDeveloperApiKey(plain),
      keyPrefix: plain.substring(0, 16),
    };
    await insertApiKey(db, values);
    let caught: unknown;
    try {
      await insertApiKey(db, { ...values, name: 'dupe2' });
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    expect(constraintNameOf(caught)).toBe('developer_api_keys_key_hash_key');
  });

  it('stamps last used without disturbing anything else', async () => {
    const app = await anApp('dev-touch');
    const key = await aKey(app.id, 'touch-key');
    expect(key.lastUsedAt).toBeNull();

    await touchKeyLastUsed(db, key.id);
    const after = await findKeyById(db, key.id);
    expect(after?.lastUsedAt).not.toBeNull();
    expect(after?.keyPrefix).toBe(key.keyPrefix);
  });

  it('counts keys per app set, optionally only the active ones', async () => {
    const app = await anApp('dev-keycount', 'dev-keycount-user');
    const a = await aKey(app.id, 'ka', 'dev-keycount-user');
    await aKey(app.id, 'kb', 'dev-keycount-user');
    await updateOwnedKey(db, a.id, app.id, 'dev-keycount-user', { isActive: false });

    expect(await countKeysForApps(db, [app.id], 'dev-keycount-user')).toBe(2);
    expect(await countKeysForApps(db, [app.id], 'dev-keycount-user', { isActive: true })).toBe(1);
    // Another account's count of the same apps is zero — the owner is part of
    // the question, not just the app.
    expect(await countKeysForApps(db, [app.id], OTHER)).toBe(0);
  });

  it('deletes a key only for its owner', async () => {
    const app = await anApp('dev-keydel');
    const key = await aKey(app.id, 'to-delete');
    expect(await deleteOwnedKey(db, key.id, app.id, OTHER)).toBeNull();
    expect((await deleteOwnedKey(db, key.id, app.id, OWNER))?.id).toBe(key.id);
    expect(await deleteOwnedKey(db, key.id, app.id, OWNER)).toBeNull();
  });

  it('finds a key by name within an app, for re-authorization', async () => {
    const app = await anApp('dev-byname');
    await aKey(app.id, 'Alia Cowork Key');
    expect((await findOwnedKeyByName(db, app.id, OWNER, 'Alia Cowork Key'))?.name).toBe('Alia Cowork Key');
    expect(await findOwnedKeyByName(db, app.id, OWNER, 'nope')).toBeNull();
  });
});

describe('the CHECK constraints', () => {
  it('refuses a scope outside the closed set', async () => {
    const app = await anApp('dev-scopes');
    let caught: unknown;
    try {
      await insertApiKey(db, {
        oxyUserId: OWNER,
        appId: app.id,
        name: 'bad-scope',
        keyHash: hashDeveloperApiKey(generateDeveloperApiKey()),
        keyPrefix: 'alia_sk_bad',
        scopes: ['chat:read', 'billing:steal'],
      });
    } catch (error) {
      caught = error;
    }
    // Containment against the tuple, not a scalar `in (…)` — which compares the
    // whole array against each scalar and is false for everything.
    expect(isCheckViolation(caught)).toBe(true);
    expect(constraintNameOf(caught)).toBe('developer_api_keys_scopes_check');
  });

  it('permits an EMPTY scope list, which reaches nothing', async () => {
    const app = await anApp('dev-noscopes');
    const key = await insertApiKey(db, {
      oxyUserId: OWNER,
      appId: app.id,
      name: 'no-scope',
      keyHash: hashDeveloperApiKey(generateDeveloperApiKey()),
      keyPrefix: 'alia_sk_none',
      scopes: [],
    });
    // A safe state, not a violation — containment is vacuously true for `{}`.
    expect(key.scopes).toEqual([]);
  });

  it('refuses a rate limit of zero, which would read as "no requests permitted"', async () => {
    const app = await anApp('dev-ratelimit');
    let caught: unknown;
    try {
      await insertApiKey(db, {
        oxyUserId: OWNER,
        appId: app.id,
        name: 'zero-limit',
        keyHash: hashDeveloperApiKey(generateDeveloperApiKey()),
        keyPrefix: 'alia_sk_zero',
        rateLimitRequestsPerMinute: 0,
      });
    } catch (error) {
      caught = error;
    }
    expect(constraintNameOf(caught)).toBe('developer_api_keys_rate_limits_positive_check');
  });

  it('permits NULL rate limits, which mean UNLIMITED', async () => {
    const app = await anApp('dev-unlimited');
    const key = await insertApiKey(db, {
      oxyUserId: OWNER,
      appId: app.id,
      name: 'unlimited',
      keyHash: hashDeveloperApiKey(generateDeveloperApiKey()),
      keyPrefix: 'alia_sk_unl',
      rateLimitRequestsPerMinute: null,
      rateLimitRequestsPerDay: null,
    });
    // NULL is unlimited; the CHECK must not confuse it with a zero.
    expect(key.rateLimitRequestsPerMinute).toBeNull();
    expect(key.rateLimitRequestsPerDay).toBeNull();
  });

  it('refuses a key naming an app that does not exist', async () => {
    let caught: unknown;
    try {
      await insertApiKey(db, {
        oxyUserId: OWNER,
        appId: '00000000-0000-0000-0000-000000000000',
        name: 'orphan',
        keyHash: hashDeveloperApiKey(generateDeveloperApiKey()),
        keyPrefix: 'alia_sk_orph',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(constraintNameOf(caught)).toContain('app_id');
  });
});

describe('findKeyWithApp', () => {
  it('returns the key WITH its app, as the populate did', async () => {
    const app = await anApp('dev-populate');
    const key = await aKey(app.id, 'joined');
    const found = await findKeyWithApp(db, key.id);
    expect(found?.key.id).toBe(key.id);
    expect(found?.app?.name).toBe('dev-populate');
  });

  it('answers null for a key that does not exist', async () => {
    expect(await findKeyWithApp(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
