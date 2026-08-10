import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxyhq/db';
import { sweepAllExpiredRows } from '@oxyhq/db/expiry';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { EXPIRY_TARGETS } from '../expiryTargets';
import {
  organizationAgents,
  organizationInvites,
  organizationMembers,
  organizations,
} from '../schema/organizations';
import { developerApiKeys, developerApps } from '../schema/developers';

/**
 * Organizations and the developer platform, against a REAL server.
 *
 * Two properties here exist only in Postgres and cannot be asserted anywhere
 * else: the slug's case-insensitive uniqueness is a FUNCTIONAL index, and the
 * invitation sweep measures from a deadline column with a non-zero retention —
 * the only one in the schema that does.
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

describe('an organization slug is unique regardless of case', () => {
  it('refuses a slug differing only in case from an existing one', async () => {
    /**
     * Mongoose declared `lowercase: true, unique: true` — a SETTER plus a
     * unique, so `Acme` and `acme` were one slug. Postgres has no setter, so a
     * plain unique on the stored text would accept both. The fixture is
     * deliberately in the UN-normalised case: with two already-lowercase slugs,
     * a plain unique and a functional one behave identically and the test would
     * prove nothing.
     */
    await db.insert(organizations).values({
      id: 'org-case-1',
      name: 'Acme',
      slug: 'acme-corp',
      ownerId: 'oxy-user-1',
    });

    const collision = db.insert(organizations).values({
      id: 'org-case-2',
      name: 'Acme Again',
      slug: 'ACME-Corp',
      ownerId: 'oxy-user-2',
    });

    await expect(collision).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('organizations_slug_lower_key');
      return true;
    });
  });
});

describe('membership and sharing cascade with the organization', () => {
  it('removes members, invites and shared agents when the organization goes', async () => {
    await db.insert(organizations).values({
      id: 'org-doomed',
      name: 'Doomed',
      slug: 'doomed',
      ownerId: 'oxy-user-1',
    });
    await db
      .insert(organizationMembers)
      .values({ id: 'om-1', organizationId: 'org-doomed', oxyUserId: 'oxy-user-2' });
    await db.insert(organizationInvites).values({
      id: 'oi-1',
      organizationId: 'org-doomed',
      token: 'invite-token-doomed',
      invitedBy: 'oxy-user-1',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await db
      .insert(organizationAgents)
      .values({ id: 'oa-1', organizationId: 'org-doomed', agentId: 'agent-1', addedBy: 'oxy-user-1' });

    await db.delete(organizations).where(eq(organizations.id, 'org-doomed'));

    const counts = await db.execute<{ members: string; invites: string; agents: string }>(sql`
      select
        (select count(*) from ${organizationMembers} where organization_id = 'org-doomed')::text as members,
        (select count(*) from ${organizationInvites} where organization_id = 'org-doomed')::text as invites,
        (select count(*) from ${organizationAgents} where organization_id = 'org-doomed')::text as agents
    `);
    expect(counts[0]).toEqual({ members: '0', invites: '0', agents: '0' });
  });

  it('refuses two memberships of one organization by one account', async () => {
    await db.insert(organizations).values({
      id: 'org-dup',
      name: 'Dup',
      slug: 'dup',
      ownerId: 'oxy-user-1',
    });
    await db
      .insert(organizationMembers)
      .values({ id: 'om-dup-1', organizationId: 'org-dup', oxyUserId: 'oxy-user-9' });

    const second = db
      .insert(organizationMembers)
      .values({ id: 'om-dup-2', organizationId: 'org-dup', oxyUserId: 'oxy-user-9' });

    await expect(second).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('organization_members_org_user_key');
      return true;
    });
  });
});

describe('an invitation cannot offer ownership, and records its acceptance whole', () => {
  it('refuses the owner role on an invitation', async () => {
    // `organization_members.role` permits `owner`; an INVITE deliberately does
    // not. Two tuples, not one, and this is what stops them being unified.
    const insert = db.execute(sql`
      insert into ${organizationInvites} (id, organization_id, token, invited_by, expires_at, role)
      values ('oi-owner', 'org-dup', 'tok-owner', 'oxy-user-1', now(), 'owner')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('organization_invites_role_check');
      return true;
    });
  });

  it('refuses an acceptance timestamp with no accepter', async () => {
    const insert = db.execute(sql`
      insert into ${organizationInvites}
        (id, organization_id, token, invited_by, expires_at, accepted_at)
      values ('oi-half', 'org-dup', 'tok-half', 'oxy-user-1', now(), now())
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('organization_invites_accepted_pair_check');
      return true;
    });
  });
});

describe('the invitation sweep measures from the DEADLINE, with a grace period', () => {
  it('keeps a recently-expired invitation and reaps one 30 days past its expiry', async () => {
    /**
     * The behaviour two plausible "corrections" would break, both silently:
     * retention 0 (copied from every other `expires_at` target) would delete the
     * first row, and measuring from `created_at` would delete a live invitation
     * whose caller-chosen expiry is further out.
     *
     * A JS `Date` is bound as an ISO string with an explicit cast — interpolating
     * one into a `sql` template throws in the DRIVER, before the server sees the
     * statement.
     */
    const justExpired = new Date(Date.now() - 60_000).toISOString();
    const longExpired = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

    await db.insert(organizations).values({
      id: 'org-sweep',
      name: 'Sweep',
      slug: 'sweep',
      ownerId: 'oxy-user-1',
    });
    await db.execute(sql`
      insert into ${organizationInvites} (id, organization_id, token, invited_by, expires_at)
      values
        ('oi-recent', 'org-sweep', 'tok-recent', 'oxy-user-1', ${justExpired}::timestamptz),
        ('oi-ancient', 'org-sweep', 'tok-ancient', 'oxy-user-1', ${longExpired}::timestamptz)
    `);

    await sweepAllExpiredRows(db, EXPIRY_TARGETS);

    const rows = await db.execute<{ id: string }>(
      sql`select id from ${organizationInvites} where organization_id = 'org-sweep' order by id`,
    );
    // The recently-expired one survives; only the one past its grace goes.
    expect(rows.map((r) => r.id)).toEqual(['oi-recent']);
  });
});

describe('developer API keys carry a bounded scope set', () => {
  beforeAll(async () => {
    await db.insert(developerApps).values({ id: 'app-1', oxyUserId: 'oxy-user-1', name: 'App One' });
  });

  it('refuses a scope outside the tuple', async () => {
    const insert = db.execute(sql`
      insert into ${developerApiKeys} (id, oxy_user_id, app_id, name, key_hash, key_prefix, scopes)
      values ('dak-bad', 'oxy-user-1', 'app-1', 'k', 'hash-bad', 'alia_sk_', '{"chat:read","billing:write"}')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('developer_api_keys_scopes_check');
      return true;
    });
  });

  it('refuses a rate limit of zero, because absence is how unlimited is spelled', async () => {
    const insert = db.execute(sql`
      insert into ${developerApiKeys}
        (id, oxy_user_id, app_id, name, key_hash, key_prefix, rate_limit_requests_per_day)
      values ('dak-zero', 'oxy-user-1', 'app-1', 'k', 'hash-zero', 'alia_sk_', 0)
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('developer_api_keys_rate_limits_positive_check');
      return true;
    });
  });

  it('takes a key with its app', async () => {
    await db.insert(developerApps).values({ id: 'app-doomed', oxyUserId: 'oxy-user-1', name: 'Doomed' });
    await db.insert(developerApiKeys).values({
      id: 'dak-doomed',
      oxyUserId: 'oxy-user-1',
      appId: 'app-doomed',
      name: 'key',
      keyHash: 'hash-doomed',
      keyPrefix: 'alia_sk_',
    });

    await db.delete(developerApps).where(eq(developerApps.id, 'app-doomed'));

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${developerApiKeys} where id = 'dak-doomed'`,
    );
    expect(rows[0]?.n).toBe('0');
  });
});
