import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { constraintNameOf, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  acceptInvite,
  createInvite,
  createOrganization,
  declineInvite,
  deleteNonOwnerMember,
  deleteOrganization,
  findLiveInviteByToken,
  findMemberOfOrganization,
  findMemberRole,
  findOrganizationById,
  listMembers,
  listOrganizationsForMember,
  listPendingInvites,
  listSharedAgentIds,
  revokeInvite,
  shareAgentWithOrganization,
  toOrganizationResponse,
  unshareAgentFromOrganization,
  updateNonOwnerMemberRole,
  updateOrganization,
} from '../organizations/organizationRepository';
import {
  organizationAgents,
  organizationInvites,
  organizationMembers,
  organizations,
} from '../schema/organizations';

/**
 * `hydrateOxyUsers` reads through the module-level `oxyClient`, which talks to a
 * real Oxy over HTTP. Mocked at the module boundary rather than at the network,
 * because what is under test is the batching and the fail-open, not the client.
 */
const getUsersByIds = vi.fn();
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: {
    getUsersByIds: (ids: string[]) => getUsersByIds(ids),
  },
}));

const { hydrateOxyUsers } = await import('../../lib/oxy-user-hydration.js');

/**
 * `organizations`, `organization_members`, `organization_invites` and
 * `organization_agents`, against a real server.
 *
 * The properties here have no mocked counterpart and are exactly the ones a port
 * gets wrong QUIETLY, by returning something plausible:
 *
 *  - the membership unique index, which is what `acceptInvite` reads its
 *    "already a member" answer off — a mocked insert accepts a duplicate and
 *    seats a second membership with no error;
 *  - the case-insensitive slug unique, which is a FUNCTIONAL index and therefore
 *    invisible to anything comparing column lists;
 *  - the organization scope on every member and invitation lookup, which is the
 *    difference between a miss and a cross-tenant write;
 *  - `ON DELETE CASCADE`, which no mock enforces;
 *  - `int8` decoding, which `postgres.js` answers with a STRING.
 *
 * Ids are namespaced `orgtest-` so a failure names its own fixtures.
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

/**
 * The fixtures this file created, deleted by ID.
 *
 * NOT `db.delete(organizations)`. The pg suite shares ONE database across every
 * `*.pgdb.test.ts`, vitest runs those files in parallel workers, and a blanket
 * delete here would wipe `organizations.pgdb.test.ts`'s fixtures out from under
 * it — a failure that lands in a file this one never touches and does not
 * reproduce when either is run alone. Members, invitations and shared agents go
 * with each row by cascade.
 */
const created: string[] = [];

afterEach(async () => {
  getUsersByIds.mockReset();
  if (created.length === 0) return;
  await db.delete(organizations).where(inArray(organizations.id, [...created]));
  created.length = 0;
});

const OWNER = 'orgtest-owner';
const ADMIN = 'orgtest-admin';
const MEMBER = 'orgtest-member';
const OUTSIDER = 'orgtest-outsider';

let slugCounter = 0;
function aSlug(): string {
  slugCounter += 1;
  return `orgtest-slug-${String(slugCounter)}`;
}

async function anOrganization(overrides: { slug?: string; ownerId?: string } = {}) {
  const organization = await createOrganization(db, {
    name: 'Acme',
    slug: overrides.slug ?? aSlug(),
    ownerId: overrides.ownerId ?? OWNER,
  });
  if (!organization) throw new Error('fixture organization was refused');
  created.push(organization.id);
  return organization;
}

/**
 * Pin a row's `created_at`, so an ordering assertion is about the ORDER BY.
 *
 * Two fixtures written milliseconds apart can share a `now()` — `now()` is the
 * TRANSACTION timestamp, and `createOrganization` runs in one — and an ordering
 * assertion over tied timestamps passes whichever direction the query sorts.
 * That is a test that cannot fail, so the timestamps are made to differ.
 */
async function pinCreatedAt(organizationId: string, createdAt: Date): Promise<void> {
  await db
    .update(organizations)
    .set({ createdAt })
    .where(eq(organizations.id, organizationId));
}

async function seatMember(organizationId: string, oxyUserId: string, role: 'admin' | 'member') {
  const [row] = await db
    .insert(organizationMembers)
    .values({ organizationId, oxyUserId, role })
    .returning();
  if (!row) throw new Error('fixture membership was refused');
  return row;
}

function inSevenDays(): Date {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

describe('creating an organization seats its owner, or refuses the slug', () => {
  it('creates the organization and its owner membership in one transaction', async () => {
    const organization = await anOrganization({ slug: 'acme-one' });

    expect(organization.ownerId).toBe(OWNER);
    expect(await findMemberRole(db, organization.id, OWNER)).toBe('owner');
    const [member] = await listMembers(db, organization.id);
    // `permissions: ['*']` is what the Mongo route wrote for a creator.
    expect(member?.permissions).toEqual(['*']);
  });

  it('refuses a slug that differs only in CASE, and seats nobody', async () => {
    /**
     * The functional unique on `lower(slug)`. A plain unique on the stored
     * column would accept this insert, so this is the assertion that a
     * `uniqueIndex(...).on(t.slug)` cannot pass — and the failure it prevents is
     * two organizations addressable by one slug.
     */
    await anOrganization({ slug: 'acme-two' });

    const clash = await createOrganization(db, {
      name: 'Impostor',
      slug: 'ACME-TWO',
      ownerId: OUTSIDER,
    });

    expect(clash).toBeNull();
    /**
     * And nobody is seated. This is about the ORDER of the two statements — the
     * organization insert answers first and the owner membership is never
     * attempted — NOT about the rollback.
     *
     * Measured, so the distinction is not a guess: replacing `db.transaction`
     * with a plain sequential call leaves this test green. The rollback protects
     * a failure BETWEEN the two inserts, and no statement-level failure of the
     * second one is reachable from here — `organization_members` has no
     * constraint a brand-new organization's owner row can violate. Provoking it
     * would need a trigger, which is DDL on the database every other
     * `*.pgdb.test.ts` file is using at the same time. So the rollback is stated
     * in the repository and left unasserted rather than claimed here.
     */
    expect(await findMemberRole(db, 'ACME-TWO', OUTSIDER)).toBeNull();
    const rows = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.oxyUserId, OUTSIDER));
    expect(rows).toEqual([]);
  });

  it('writes only the four fields a caller may choose', async () => {
    const organization = await anOrganization();

    // A creation cannot mint credits or a Stripe customer, whatever the body
    // carried: the input type names four fields and nothing spreads a request.
    expect(organization.creditsPaid).toBe(0);
    expect(organization.stripeCustomerId).toBeNull();
    expect(organization.settingsBillingEmail).toBeNull();
    expect(organization.settingsApiCallLimit).toBeNull();
  });
});

describe("a member's own role is the only membership a permission check returns", () => {
  it('answers the role for a member and null for everyone else', async () => {
    const organization = await anOrganization();
    await seatMember(organization.id, ADMIN, 'admin');

    expect(await findMemberRole(db, organization.id, OWNER)).toBe('owner');
    expect(await findMemberRole(db, organization.id, ADMIN)).toBe('admin');
    expect(await findMemberRole(db, organization.id, OUTSIDER)).toBeNull();
  });

  it('does not answer a membership of a DIFFERENT organization', async () => {
    const mine = await anOrganization();
    const theirs = await anOrganization({ ownerId: OUTSIDER });
    await seatMember(theirs.id, MEMBER, 'admin');

    // The scope is the whole check: an admin over there is nobody here.
    expect(await findMemberRole(db, mine.id, MEMBER)).toBeNull();
  });
});

describe('one account holds at most one membership of an organization', () => {
  it('refuses a second membership at the index', async () => {
    const organization = await anOrganization();
    await seatMember(organization.id, MEMBER, 'member');

    await expect(seatMember(organization.id, MEMBER, 'admin')).rejects.toThrow();
  });
});

/**
 * At most one owner per organization, and the guard is the DATABASE.
 *
 * These insert through the schema rather than through the repository ON PURPOSE.
 * The repository refuses `owner` by TYPE and the route refuses it by zod, and
 * both of those are exactly what this index exists to survive: a type is erased
 * before a request arrives, and a validator is one word from being widened by
 * somebody tidying up. A test that went through either would be measuring the
 * guard it is meant to be the backstop for.
 */
describe('an organization has at most one owner, enforced by the database', () => {
  it('refuses a second owner written straight past every application guard', async () => {
    const organization = await anOrganization();

    const second = db
      .insert(organizationMembers)
      .values({ organizationId: organization.id, oxyUserId: OUTSIDER, role: 'owner' });

    await expect(second).rejects.toSatisfy((error: unknown) => {
      // The SQLSTATE lives on `cause`, never on `error.code`.
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('organization_members_one_owner_key');
      return true;
    });
  });

  it('refuses PROMOTING a second member to owner, not merely inserting one', async () => {
    // The escalation path's actual shape is an UPDATE, not an INSERT.
    const organization = await anOrganization();
    const member = await seatMember(organization.id, MEMBER, 'member');

    const promote = db
      .update(organizationMembers)
      .set({ role: 'owner' })
      .where(eq(organizationMembers.id, member.id));

    await expect(promote).rejects.toSatisfy((error: unknown) => {
      expect(constraintNameOf(error)).toBe('organization_members_one_owner_key');
      return true;
    });
    expect(await findMemberRole(db, organization.id, MEMBER)).toBe('member');
  });

  it('still allows one owner EACH in different organizations', async () => {
    /**
     * The index is partial AND scoped. Without the `organization_id` key it would
     * permit one owner in the entire table; without the `WHERE` it would permit
     * one MEMBER per organization, which would break every ordinary membership.
     * Both failures are caught here rather than by reading the index definition.
     */
    const first = await anOrganization();
    const second = await anOrganization({ ownerId: ADMIN });

    expect(await findMemberRole(db, first.id, OWNER)).toBe('owner');
    expect(await findMemberRole(db, second.id, ADMIN)).toBe('owner');
    // And ordinary members are unaffected — several per organization.
    await seatMember(first.id, MEMBER, 'member');
    await seatMember(first.id, OUTSIDER, 'admin');
    expect(await listMembers(db, first.id)).toHaveLength(3);
  });

  /**
   * The other direction, which is the half a guard like this usually breaks.
   *
   * There is no ownership-transfer path today — the only writer of `role =
   * 'owner'` in this repository's history is the creation insert — so this is
   * about the one that will be written. A partial unique index cannot be
   * DEFERRABLE (a syntax error, verified), so the ordering below is not a style
   * preference, it is the only ordering that works, and finding that out from a
   * failing production transfer would be the expensive way.
   */
  describe('a future ownership transfer', () => {
    it('SUCCEEDS when it demotes before it promotes, in one transaction', async () => {
      const organization = await anOrganization();
      const successor = await seatMember(organization.id, MEMBER, 'admin');

      await db.transaction(async (tx) => {
        await tx
          .update(organizationMembers)
          .set({ role: 'member' })
          .where(
            and(
              eq(organizationMembers.organizationId, organization.id),
              eq(organizationMembers.oxyUserId, OWNER),
            ),
          );
        await tx
          .update(organizationMembers)
          .set({ role: 'owner' })
          .where(eq(organizationMembers.id, successor.id));
      });

      expect(await findMemberRole(db, organization.id, MEMBER)).toBe('owner');
      expect(await findMemberRole(db, organization.id, OWNER)).toBe('member');
    });

    it('FAILS when it promotes first, and the whole transaction is lost', async () => {
      const organization = await anOrganization();
      const successor = await seatMember(organization.id, MEMBER, 'admin');

      const promoteFirst = db.transaction(async (tx) => {
        await tx
          .update(organizationMembers)
          .set({ role: 'owner' })
          .where(eq(organizationMembers.id, successor.id));
        await tx
          .update(organizationMembers)
          .set({ role: 'member' })
          .where(
            and(
              eq(organizationMembers.organizationId, organization.id),
              eq(organizationMembers.oxyUserId, OWNER),
            ),
          );
      });

      await expect(promoteFirst).rejects.toThrow();
      // Nothing moved: the demote never ran, because the failed statement had
      // already aborted the transaction.
      expect(await findMemberRole(db, organization.id, OWNER)).toBe('owner');
      expect(await findMemberRole(db, organization.id, MEMBER)).toBe('admin');
    });
  });
});

describe('the organization list carries the role and a NUMERIC member count', () => {
  it('lists only organizations the caller belongs to, newest first', async () => {
    const first = await anOrganization();
    const second = await anOrganization();
    const foreign = await anOrganization({ ownerId: OUTSIDER });
    await pinCreatedAt(first.id, new Date('2026-01-01T00:00:00Z'));
    await pinCreatedAt(second.id, new Date('2026-02-01T00:00:00Z'));
    await seatMember(first.id, MEMBER, 'member');
    await seatMember(second.id, MEMBER, 'admin');
    // Populated, so "absent from the list" is about the JOIN and not about an
    // organization that happens to have no members. OUTSIDER already owns it.
    await seatMember(foreign.id, ADMIN, 'member');

    const listed = await listOrganizationsForMember(db, MEMBER);

    expect(listed.map((l) => l.organization.id)).toEqual([second.id, first.id]);
    expect(listed.map((l) => l.role)).toEqual(['admin', 'member']);
    // The join IS the filter: an organization this account has no membership of
    // cannot appear, whoever else belongs to it.
    expect(listed.map((l) => l.organization.id)).not.toContain(foreign.id);
  });

  it('counts members as a NUMBER, not as the string postgres.js decodes int8 into', async () => {
    /**
     * `count(*)` is `int8` and `postgres.js` hands it back as a STRING while the
     * `sql<number>` on the sub-select claims otherwise. `"3"` renders correctly
     * in every UI, so the symptom of losing `.mapWith(Number)` is not a visible
     * count at all — it is `memberCount > 5` being false for `"10"` and the list
     * sorting alphabetically. `toBe(3)` is a strict-equality check and `"3"`
     * fails it; the typeof assertion says so out loud.
     */
    const organization = await anOrganization();
    await seatMember(organization.id, ADMIN, 'admin');
    await seatMember(organization.id, MEMBER, 'member');

    const listed = (await listOrganizationsForMember(db, OWNER)).find(
      (l) => l.organization.id === organization.id,
    );

    expect(typeof listed?.memberCount).toBe('number');
    expect(listed?.memberCount).toBe(3);
  });
});

describe('updating an organization', () => {
  it('touches only the fields the caller named', async () => {
    const organization = await anOrganization();
    await updateOrganization(db, organization.id, { name: 'Renamed' });

    const updated = await findOrganizationById(db, organization.id);
    expect(updated?.name).toBe('Renamed');
    // `$set: { x: undefined }` is a no-op in Mongo and writes NULL in Postgres.
    // A description the caller never mentioned must survive a rename.
    expect(updated?.slug).toBe(organization.slug);
    expect(updated?.ownerId).toBe(OWNER);
  });

  it('REPLACES the settings sub-document, exactly as `$set: { settings }` did', async () => {
    /**
     * The Mongo statement set the whole `settings` object, so a PATCH carrying
     * only `billingEmail` cleared `apiCallLimit`. Flattening the two columns into
     * independent optional updates would silently turn that into a partial
     * update — a behaviour change with no failing test and no visible diff.
     */
    const organization = await anOrganization();
    await updateOrganization(db, organization.id, {
      settings: { billingEmail: 'billing@example.com', apiCallLimit: 1000 },
    });

    await updateOrganization(db, organization.id, {
      settings: { billingEmail: 'new@example.com' },
    });

    const updated = await findOrganizationById(db, organization.id);
    expect(updated?.settingsBillingEmail).toBe('new@example.com');
    expect(updated?.settingsApiCallLimit).toBeNull();
  });

  it('leaves settings ALONE when the caller did not mention them', async () => {
    // The other half of the rule above, and the one a naive "always write both
    // columns" implementation breaks.
    const organization = await anOrganization();
    await updateOrganization(db, organization.id, {
      settings: { billingEmail: 'billing@example.com', apiCallLimit: 1000 },
    });

    await updateOrganization(db, organization.id, { name: 'Renamed' });

    const updated = await findOrganizationById(db, organization.id);
    expect(updated?.settingsBillingEmail).toBe('billing@example.com');
    expect(updated?.settingsApiCallLimit).toBe(1000);
  });

  it('answers null for an organization that does not exist', async () => {
    expect(
      await updateOrganization(db, '00000000-0000-7000-8000-000000000000', { name: 'x' }),
    ).toBeNull();
  });
});

describe('the wire shape the clients already read', () => {
  it('serves `_id` and re-nests credits and settings', async () => {
    /**
     * Three measured readers in `packages/alia-console/src/hooks/use-workspace.ts`:
     * `org._id === updatedOrg._id`, `org.credits?.paid ?? 0` and
     * `org.settings?.billingEmail`. Serving the flat row makes the first TRUE for
     * every pair of organizations, the second render every balance as zero, and
     * the third disappear — three plausible-looking failures, no error.
     */
    const organization = await anOrganization();
    await updateOrganization(db, organization.id, {
      settings: { billingEmail: 'billing@example.com', apiCallLimit: 50 },
    });
    /**
     * A NON-ZERO balance, written past the repository because no caller here may
     * set one. Measured: with the default of 0, a `credits: { paid: 0 }`
     * hard-coded in the mapper passes this test — the assertion agreed with the
     * fixture rather than with the column, which is a test that cannot fail.
     */
    await db
      .update(organizations)
      .set({ creditsPaid: 4242 })
      .where(eq(organizations.id, organization.id));
    const row = await findOrganizationById(db, organization.id);
    if (!row) throw new Error('the fixture organization vanished');

    const response = toOrganizationResponse(row);

    expect(response._id).toBe(row.id);
    expect(response.credits).toEqual({ paid: 4242 });
    expect(response.settings).toEqual({ billingEmail: 'billing@example.com', apiCallLimit: 50 });
  });
});

describe('a member lookup is scoped to its organization', () => {
  it('does not find a member of another organization', async () => {
    const mine = await anOrganization();
    const theirs = await anOrganization({ ownerId: OUTSIDER });
    const theirMember = await seatMember(theirs.id, MEMBER, 'member');

    expect(await findMemberOfOrganization(db, theirMember.id, mine.id)).toBeNull();
    expect(await findMemberOfOrganization(db, theirMember.id, theirs.id)).not.toBeNull();
  });

  it('refuses to change a role in another organization', async () => {
    /**
     * The regression for a live cross-tenant write. The Mongo route checked that
     * the CALLER owned the organization in the URL and then wrote
     * `OrganizationMember.findByIdAndUpdate(memberId, { role })` — the member id
     * was never checked against that organization, so an owner of one
     * organization could promote or demote a member of another.
     */
    const mine = await anOrganization();
    const theirs = await anOrganization({ ownerId: OUTSIDER });
    const theirMember = await seatMember(theirs.id, MEMBER, 'member');

    const written = await updateNonOwnerMemberRole(db, theirMember.id, mine.id, 'admin');

    expect(written).toBeNull();
    const untouched = await findMemberOfOrganization(db, theirMember.id, theirs.id);
    expect(untouched?.role).toBe('member');
  });

  it('refuses to remove a member of another organization', async () => {
    const mine = await anOrganization();
    const theirs = await anOrganization({ ownerId: OUTSIDER });
    const theirMember = await seatMember(theirs.id, MEMBER, 'member');

    expect(await deleteNonOwnerMember(db, theirMember.id, mine.id)).toBeNull();
    expect(await findMemberOfOrganization(db, theirMember.id, theirs.id)).not.toBeNull();
  });

  it('changes a role inside its own organization', async () => {
    // The positive control: without it every assertion above passes on a
    // function that never writes anything.
    const organization = await anOrganization();
    const member = await seatMember(organization.id, MEMBER, 'member');

    const written = await updateNonOwnerMemberRole(db, member.id, organization.id, 'admin');

    expect(written?.role).toBe('admin');
  });

  it('refuses to change the OWNER own role, so an organization cannot be left ownerless', async () => {
    /**
     * The other end of the ownership surface from
     * `organization_members_one_owner_key`. That index stops a SECOND owner; this
     * stops ZERO owners, and the two failures are not symmetric: a second owner
     * is a privilege problem somebody notices, while zero owners is a permanent
     * brick — both `DELETE /organization/:id` and this route require a role that
     * no longer exists, so nothing about the organization can ever be
     * administered again, with no undo and no support path.
     *
     * Enforced by the statement, exactly as `deleteNonOwnerMember` enforces its
     * own, so a role changing between the route's read and this write cannot slip
     * through.
     */
    const organization = await anOrganization();
    const [owner] = await listMembers(db, organization.id);
    if (!owner) throw new Error('the fixture owner vanished');

    expect(await updateNonOwnerMemberRole(db, owner.id, organization.id, 'admin')).toBeNull();
    expect(await findMemberRole(db, organization.id, OWNER)).toBe('owner');
  });

  it('still changes an ADMIN role, which is the half a blanket refusal would break', async () => {
    // The positive control for the exclusion itself. A `WHERE false`, or an
    // exclusion written against the wrong role, refuses the owner AND everybody
    // else — and every assertion above would still pass.
    const organization = await anOrganization();
    const admin = await seatMember(organization.id, ADMIN, 'admin');

    expect((await updateNonOwnerMemberRole(db, admin.id, organization.id, 'member'))?.role).toBe(
      'member',
    );
    expect(await findMemberRole(db, organization.id, ADMIN)).toBe('member');
  });
});

describe('the owner cannot be removed, by the statement rather than by a check', () => {
  it('leaves the owner seated', async () => {
    const organization = await anOrganization();
    const [owner] = await listMembers(db, organization.id);
    if (!owner) throw new Error('the fixture owner vanished');

    expect(await deleteNonOwnerMember(db, owner.id, organization.id)).toBeNull();
    expect(await findMemberRole(db, organization.id, OWNER)).toBe('owner');
  });

  it('removes an ordinary member', async () => {
    const organization = await anOrganization();
    const member = await seatMember(organization.id, MEMBER, 'member');

    expect((await deleteNonOwnerMember(db, member.id, organization.id))?.id).toBe(member.id);
    expect(await findMemberRole(db, organization.id, MEMBER)).toBeNull();
  });
});

describe('an invitation is single-use, and its acceptance is one transaction', () => {
  it('seats the invited account with the invited role', async () => {
    const organization = await anOrganization();
    await createInvite(db, {
      organizationId: organization.id,
      role: 'admin',
      token: 'orgtest-token-accept',
      invitedBy: OWNER,
      expiresAt: inSevenDays(),
    });

    const result = await acceptInvite(db, 'orgtest-token-accept', MEMBER);

    expect(result.status).toBe('accepted');
    expect(await findMemberRole(db, organization.id, MEMBER)).toBe('admin');
  });

  it('records the acceptance as a PAIR, which the CHECK requires', async () => {
    const organization = await anOrganization();
    await createInvite(db, {
      organizationId: organization.id,
      role: 'member',
      token: 'orgtest-token-pair',
      invitedBy: OWNER,
      expiresAt: inSevenDays(),
    });

    await acceptInvite(db, 'orgtest-token-pair', MEMBER);

    const [invite] = await db
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.token, 'orgtest-token-pair'));
    expect(invite?.status).toBe('accepted');
    expect(invite?.acceptedBy).toBe(MEMBER);
    expect(invite?.acceptedAt).toBeInstanceOf(Date);
  });

  it('answers not-found the SECOND time, and seats nobody twice', async () => {
    /**
     * The Mongo idiom this replaces is insert-then-catch-E11000, which does not
     * port: a raised error aborts the whole transaction (`25P02`), so the
     * invitation could not then be marked accepted, and a catch cannot tell a
     * duplicate from a dropped connection. The claim is the UPDATE, and
     * `ON CONFLICT DO NOTHING RETURNING` answers the membership question with no
     * error to classify.
     */
    const organization = await anOrganization();
    await createInvite(db, {
      organizationId: organization.id,
      role: 'member',
      token: 'orgtest-token-replay',
      invitedBy: OWNER,
      expiresAt: inSevenDays(),
    });

    const first = await acceptInvite(db, 'orgtest-token-replay', MEMBER);
    const second = await acceptInvite(db, 'orgtest-token-replay', OUTSIDER);

    expect(first.status).toBe('accepted');
    expect(second).toEqual({ status: 'not-found' });
    // The replay did not seat the second account, and did not unseat the first.
    expect(await findMemberRole(db, organization.id, OUTSIDER)).toBeNull();
    expect(await findMemberRole(db, organization.id, MEMBER)).toBe('member');
  });

  it('answers already-member without raising, and still spends the invitation', async () => {
    const organization = await anOrganization();
    await seatMember(organization.id, MEMBER, 'member');
    await createInvite(db, {
      organizationId: organization.id,
      role: 'admin',
      token: 'orgtest-token-dup',
      invitedBy: OWNER,
      expiresAt: inSevenDays(),
    });

    const result = await acceptInvite(db, 'orgtest-token-dup', MEMBER);

    expect(result).toEqual({ status: 'already-member' });
    // The invitation is marked accepted even so — the Mongo route's behaviour,
    // and what stops the link being reusable by somebody else.
    const [invite] = await db
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.token, 'orgtest-token-dup'));
    expect(invite?.status).toBe('accepted');
    // The existing membership keeps its own role rather than being upgraded.
    expect(await findMemberRole(db, organization.id, MEMBER)).toBe('member');
  });

  it('refuses an EXPIRED invitation, and does not mark it accepted', async () => {
    const organization = await anOrganization();
    await createInvite(db, {
      organizationId: organization.id,
      role: 'member',
      token: 'orgtest-token-expired',
      invitedBy: OWNER,
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await acceptInvite(db, 'orgtest-token-expired', MEMBER);

    expect(result).toEqual({ status: 'not-found' });
    expect(await findMemberRole(db, organization.id, MEMBER)).toBeNull();
    const [invite] = await db
      .select()
      .from(organizationInvites)
      .where(eq(organizationInvites.token, 'orgtest-token-expired'));
    expect(invite?.status).toBe('pending');
  });

  it('declines a live invitation once', async () => {
    const organization = await anOrganization();
    await createInvite(db, {
      organizationId: organization.id,
      role: 'member',
      token: 'orgtest-token-decline',
      invitedBy: OWNER,
      expiresAt: inSevenDays(),
    });

    expect((await declineInvite(db, 'orgtest-token-decline'))?.status).toBe('declined');
    expect(await declineInvite(db, 'orgtest-token-decline')).toBeNull();
    // A declined invitation cannot then be accepted.
    expect(await acceptInvite(db, 'orgtest-token-decline', MEMBER)).toEqual({
      status: 'not-found',
    });
  });
});

describe('invitation listing and revocation are scoped to one organization', () => {
  it('lists only live invitations, newest first', async () => {
    const organization = await anOrganization();
    await createInvite(db, {
      organizationId: organization.id,
      role: 'member',
      token: 'orgtest-live-1',
      invitedBy: OWNER,
      expiresAt: inSevenDays(),
    });
    await createInvite(db, {
      organizationId: organization.id,
      role: 'member',
      token: 'orgtest-stale',
      invitedBy: OWNER,
      expiresAt: new Date(Date.now() - 1000),
    });
    const declined = await createInvite(db, {
      organizationId: organization.id,
      role: 'member',
      token: 'orgtest-declined',
      invitedBy: OWNER,
      expiresAt: inSevenDays(),
    });
    await declineInvite(db, declined.token);

    const listed = await listPendingInvites(db, organization.id);

    expect(listed.map((i) => i.token)).toEqual(['orgtest-live-1']);
  });

  it('refuses to revoke an invitation belonging to another organization', async () => {
    const mine = await anOrganization();
    const theirs = await anOrganization({ ownerId: OUTSIDER });
    const invite = await createInvite(db, {
      organizationId: theirs.id,
      role: 'member',
      token: 'orgtest-token-theirs',
      invitedBy: OUTSIDER,
      expiresAt: inSevenDays(),
    });

    expect(await revokeInvite(db, invite.id, mine.id)).toBeNull();
    expect(await revokeInvite(db, invite.id, theirs.id)).not.toBeNull();
    // Revoked, so the link stops working.
    expect(await acceptInvite(db, 'orgtest-token-theirs', MEMBER)).toEqual({
      status: 'not-found',
    });
  });

  it('finds a live invitation with the organization it names', async () => {
    const organization = await anOrganization();
    await createInvite(db, {
      organizationId: organization.id,
      role: 'member',
      token: 'orgtest-token-info',
      invitedBy: OWNER,
      expiresAt: inSevenDays(),
    });

    const found = await findLiveInviteByToken(db, 'orgtest-token-info');

    expect(found?.organization.id).toBe(organization.id);
    expect(found?.invite.role).toBe('member');
    expect(await findLiveInviteByToken(db, 'orgtest-token-missing')).toBeNull();
  });
});

describe('sharing an agent into an organization', () => {
  const AGENT = '01900000-0000-7000-8000-00000000000a';

  it('is idempotent, and keeps the FIRST sharer', async () => {
    const organization = await anOrganization();

    await shareAgentWithOrganization(db, organization.id, AGENT, OWNER);
    await shareAgentWithOrganization(db, organization.id, AGENT, ADMIN);

    const rows = await db
      .select()
      .from(organizationAgents)
      .where(eq(organizationAgents.organizationId, organization.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.addedBy).toBe(OWNER);
  });

  it('lists shared agents most recently shared first, and unshares once', async () => {
    const organization = await anOrganization();
    const second = '01900000-0000-7000-8000-00000000000b';

    await shareAgentWithOrganization(db, organization.id, AGENT, OWNER);
    await shareAgentWithOrganization(db, organization.id, second, OWNER);
    // Same reason as `pinCreatedAt`: two shares written in the same millisecond
    // tie, and an ordering assertion over a tie cannot fail.
    await db
      .update(organizationAgents)
      .set({ createdAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(organizationAgents.agentId, AGENT));
    await db
      .update(organizationAgents)
      .set({ createdAt: new Date('2026-02-01T00:00:00Z') })
      .where(eq(organizationAgents.agentId, second));

    expect(await listSharedAgentIds(db, organization.id)).toEqual([second, AGENT]);
    expect(await unshareAgentFromOrganization(db, organization.id, AGENT)).toBe(true);
    expect(await unshareAgentFromOrganization(db, organization.id, AGENT)).toBe(false);
    expect(await listSharedAgentIds(db, organization.id)).toEqual([second]);
  });
});

describe('deleting an organization takes everything hanging off it', () => {
  it('removes its members, invitations and shared agents', async () => {
    const organization = await anOrganization();
    await seatMember(organization.id, MEMBER, 'member');
    await createInvite(db, {
      organizationId: organization.id,
      role: 'member',
      token: 'orgtest-token-cascade',
      invitedBy: OWNER,
      expiresAt: inSevenDays(),
    });
    await shareAgentWithOrganization(db, organization.id, '01900000-0000-7000-8000-00000000000c', OWNER);

    await deleteOrganization(db, organization.id);

    expect(await findOrganizationById(db, organization.id)).toBeNull();
    expect(await listMembers(db, organization.id)).toEqual([]);
    expect(await listPendingInvites(db, organization.id)).toEqual([]);
    expect(await listSharedAgentIds(db, organization.id)).toEqual([]);
    // The invitation TOKEN stops working too — a live credential to a deleted
    // organization is what the Mongo route left behind, because it deleted the
    // members by hand and nothing else.
    expect(await findLiveInviteByToken(db, 'orgtest-token-cascade')).toBeNull();
  });
});

describe('every index this domain depends on exists on the migrated server', () => {
  /**
   * An index is the one thing whose absence a functional test cannot detect:
   * a missing NON-UNIQUE index changes no answer, only a query plan, so the
   * uniqueness assertions above say nothing about `organization_members_oxy_user_id_idx`
   * or the two partial indexes on `organization_invites`. This reads
   * `pg_indexes` on the database the real migrate entrypoint just built.
   *
   * By NAME, because "an index on these columns exists somewhere" answers yes
   * for a sibling table — and the partial ones carry a `WHERE`, so the predicate
   * is asserted too: dropping it would double the index's size and, more to the
   * point, would mean the schema no longer says what it meant to say.
   */
  it('carries every declared index, with the partial predicates intact', async () => {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public'
        and tablename in ('organizations', 'organization_members', 'organization_invites', 'organization_agents')
    `);
    const byName = new Map([...rows].map((r) => [r.indexname, r.indexdef]));

    // Vacuity floor: an empty read reports every index missing OR present
    // depending on how the assertion is written, so the count is asserted first.
    expect(byName.size).toBeGreaterThanOrEqual(11);

    const required = [
      'organizations_slug_lower_key',
      'organizations_owner_id_idx',
      'organization_members_org_user_key',
      'organization_members_one_owner_key',
      'organization_members_oxy_user_id_idx',
      'organization_invites_token_key',
      'organization_invites_org_email_idx',
      'organization_invites_email_status_idx',
      'organization_invites_expires_at_idx',
      'organization_agents_org_agent_key',
      'organization_agents_organization_id_idx',
    ];
    expect(required.filter((name) => !byName.has(name))).toEqual([]);

    // The functional index is on `lower(slug)`, not on `slug`.
    expect(byName.get('organizations_slug_lower_key')).toContain('lower(slug)');
    // The two `email` indexes are PARTIAL — Mongo's `sparse: true`.
    expect(byName.get('organization_invites_org_email_idx')).toContain('WHERE');
    expect(byName.get('organization_invites_email_status_idx')).toContain('WHERE');
  });
});

/**
 * The organization half of `lib/__tests__/oxy-user-hydration-real-db.test.ts`,
 * moved here with its data.
 *
 * That file used `OrganizationMember` against a real MongoDB to prove a bug that
 * reached production: `.populate('oxyUserId', …)` on a field declared
 * `ref: 'User'` throws `MissingSchemaError`, but ONLY once there is at least one
 * document to populate — so a fresh organization worked and the endpoint failed
 * the moment somebody used the feature. S9 deleted that model, and deleting the
 * case with it would have retired a regression test on the grounds that its
 * fixture changed database.
 *
 * The NON-EMPTY fixture is the whole point and is why it is worth re-establishing
 * rather than dropping: the empty case is the one that always passed.
 */
describe('an Oxy-owned member is read without a join, on a NON-EMPTY organization', () => {
  it('hydrates the members of a NON-EMPTY organization in one batch call', async () => {
    const organization = await anOrganization();
    await seatMember(organization.id, MEMBER, 'member');

    const members = await listMembers(db, organization.id);
    expect(members.length).toBeGreaterThan(0);

    getUsersByIds.mockResolvedValue([
      { id: MEMBER, username: 'ada', name: { displayName: 'Ada Lovelace' }, avatar: 'file-1' },
      { id: OWNER, username: 'grace', name: {} },
    ]);

    const profiles = await hydrateOxyUsers(members.map((m) => m.oxyUserId));

    expect(profiles.get(MEMBER)).toEqual({
      _id: MEMBER,
      username: 'ada',
      displayName: 'Ada Lovelace',
      avatar: 'file-1',
    });
    // The sanctioned coalesce, never a name recomposed from first/last/full.
    expect(profiles.get(OWNER)?.displayName).toBe('grace');
    // One round trip for the page, not one per row.
    expect(getUsersByIds).toHaveBeenCalledTimes(1);
    expect(getUsersByIds).toHaveBeenCalledWith(expect.arrayContaining([OWNER, MEMBER]));
  });

  it('FAILS OPEN: an Oxy outage leaves the membership readable', async () => {
    const organization = await anOrganization();
    await seatMember(organization.id, MEMBER, 'member');
    getUsersByIds.mockRejectedValue(new Error('oxy is unreachable'));

    const members = await listMembers(db, organization.id);
    const profiles = await hydrateOxyUsers(members.map((m) => m.oxyUserId));

    // An identity lookup must not decide whether a member list renders.
    expect(members).toHaveLength(2);
    expect(profiles.size).toBe(0);
  });
});

describe('the invitation sweep still has its target', () => {
  it('is registered against `expires_at` with a 30-day retention', async () => {
    // The Mongo TTL was `{ expiresAt: 1 }, expireAfterSeconds: 30 days`, so a
    // row leaves 30 days AFTER its own expiry — not at expiry, and not 30 days
    // after creation. `db/__tests__/ttlRegistryCoverage.test.ts` owns that rule;
    // this is the local reminder that the column it names is still indexed.
    const rows = await db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'organization_invites_expires_at_idx'
    `);
    expect([...rows]).toHaveLength(1);
  });
});
