/**
 * Organizations, their members, their invitations and the agents they share, on
 * Postgres.
 *
 * ## Every membership read is scoped by organization, and the Mongo code was not
 *
 * `routes/organization.ts` used to reach a member row by id alone —
 * `OrganizationMember.findByIdAndUpdate(memberId, { role })`,
 * `findById(memberId)`, `findByIdAndDelete(memberId)` — after checking only that
 * the CALLER was an owner or admin of the organization in the URL. The member id
 * was never checked against that organization, so an owner of one organization
 * could pass the id of a member of another and change or delete that row. That
 * is cross-tenant privilege escalation, not merely an IDOR, and it is fixed here
 * rather than at the route: every function taking a member id also takes the
 * organization it must belong to, so the pattern cannot be lost by reaching for
 * a conveniently narrower one. `organizationRepository.pgdb.test.ts` holds the
 * regression.
 *
 * ## A permission check answers a ROLE, never a row
 *
 * {@link findMemberRole} returns the caller's own role or `null`. Nothing here
 * hands a route somebody else's membership row to filter in JavaScript, so a
 * future leak cannot be one forgotten `if`.
 *
 * ## `id` is a uuid v7 string, where Mongo had an ObjectId
 *
 * An organization or member id from an OLD client is an ObjectId hex string that
 * matches nothing — a 404 rather than the CastError Mongoose threw.
 */

import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index';
import {
  organizationAgents,
  organizationInvites,
  organizationMembers,
  organizations,
  type OrganizationInviteRole,
  type OrganizationRole,
} from '../schema/organizations';

/**
 * Re-exported so a route can name the role type without importing the SCHEMA.
 *
 * Not a barrel: `OrganizationRole` is the tuple that types this repository's own
 * arguments and returns, so it is part of this module's surface rather than a
 * convenience pass-through. A route importing `db/schema` directly would be a
 * route that can also reach the tables.
 */
export type { OrganizationInviteRole, OrganizationRole };

export type OrganizationRow = typeof organizations.$inferSelect;
export type OrganizationMemberRow = typeof organizationMembers.$inferSelect;
export type OrganizationInviteRow = typeof organizationInvites.$inferSelect;

/**
 * What `routes/organization.ts` puts on the wire for an organization.
 *
 * ## `_id`, `credits` and `settings` are a versioned contract, and dropping any
 * of them corrupts a page rather than erroring
 *
 * `packages/alia-console/src/hooks/use-workspace.ts` declares all three on
 * `ApiOrganization` and does not merely display them:
 *
 *  - it compares on `_id` (`org._id === updatedOrg._id`), so serving a row with
 *    `id` alone leaves `undefined === undefined` reading TRUE for every
 *    organization and renaming one rewrites the whole cached list;
 *  - it reads `org.credits?.paid ?? 0`, so a flattened `creditsPaid` renders
 *    every workspace's balance as **zero** — a number, in the right place,
 *    silently wrong;
 *  - it reads `org.settings?.billingEmail`, which simply disappears.
 *
 * So the two flattened sub-documents are reassembled here. That is the opposite
 * call to `developer_apps`' `rateLimit*`, and deliberately: those columns were
 * measured to have NO client reader, these were measured to have three.
 */
export interface OrganizationResponse {
  readonly _id: string;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly image: string | null;
  readonly ownerId: string;
  readonly credits: { readonly paid: number };
  readonly settings: {
    readonly billingEmail: string | null;
    readonly apiCallLimit: number | null;
  };
  readonly stripeCustomerId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toOrganizationResponse(row: OrganizationRow): OrganizationResponse {
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    image: row.image,
    ownerId: row.ownerId,
    credits: { paid: row.creditsPaid },
    settings: {
      billingEmail: row.settingsBillingEmail,
      apiCallLimit: row.settingsApiCallLimit,
    },
    stripeCustomerId: row.stripeCustomerId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A membership as the clients read it.
 *
 * `_id` is the id the console puts in the URL of `DELETE
 * /organization/:id/members/:memberId` and `PATCH …/:memberId`, so it is load
 * bearing rather than cosmetic. `oxyUserId` stays a bare id here; the routes
 * replace it with a hydrated profile through `lib/oxy-user-hydration.ts`, which
 * is the shape the clients already accept for it.
 */
export interface OrganizationMemberResponse extends OrganizationMemberRow {
  readonly _id: string;
}

export function toMemberResponse(row: OrganizationMemberRow): OrganizationMemberResponse {
  return { ...row, _id: row.id };
}

/**
 * An invitation as a LIST serves it — without the token.
 *
 * `token` is a live bearer credential: whoever holds it joins the organization,
 * and the schema comment for this table says so beside the column. The Mongo
 * route served the whole document from `GET /:id/invites`, which put an
 * unexpired join-link for the organization into every administrator's browser
 * cache and every proxy between. Measured before narrowing it: `useOrgInvites`
 * in `packages/app` has **zero** call sites and `packages/alia-console` has no
 * invitations hook at all, so nothing reads it. The one response that must carry
 * a token is the CREATE, which is where the inviter is handed the link, and that
 * route builds its own literal.
 *
 * Omitted BY TYPE rather than by deletion, exactly as `DeveloperApiKeyResponse`
 * drops `keyHash`: a new response shape has to opt in rather than remember to
 * opt out.
 */
export type OrganizationInviteResponse = Omit<OrganizationInviteRow, 'token'> & {
  readonly _id: string;
};

export function toInviteResponse(row: OrganizationInviteRow): OrganizationInviteResponse {
  const { token: _token, ...rest } = row;
  return { ...rest, _id: row.id };
}

/** An organization as it appears in the caller's own list. */
export interface OrganizationMembershipSummary {
  readonly organization: OrganizationRow;
  readonly role: OrganizationRole;
  readonly memberCount: number;
}

/**
 * How many members an organization has, as a correlated sub-select.
 *
 * `.mapWith(Number)` is not decoration: `count(*)` is `int8`, and `postgres.js`
 * decodes `int8` as a **string** while the `sql<number>` above claims otherwise.
 * Without it `memberCount` reaches the client as `"3"`, which renders correctly,
 * compares wrongly and sorts alphabetically. drizzle's own `count()` helper
 * carries the same mapper for the same reason; a correlated sub-select has to
 * ask for it.
 */
const memberCountOf = sql<number>`(
  select count(*) from ${organizationMembers}
  where ${organizationMembers.organizationId} = ${organizations.id}
)`.mapWith(Number);

/**
 * Every organization this account belongs to, newest first, with its own role
 * and the total membership.
 *
 * One statement where Mongo took three (memberships, organizations, a
 * `$group` aggregate). The join IS the membership filter, so an organization the
 * caller does not belong to cannot appear.
 */
export async function listOrganizationsForMember(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<OrganizationMembershipSummary[]> {
  const rows = await db
    .select({
      organization: organizations,
      role: organizationMembers.role,
      memberCount: memberCountOf,
    })
    .from(organizations)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizations.id),
        eq(organizationMembers.oxyUserId, oxyUserId),
      ),
    )
    .orderBy(desc(organizations.createdAt));

  return rows.map((row) => ({
    organization: row.organization,
    role: row.role as OrganizationRole,
    memberCount: row.memberCount,
  }));
}

export async function findOrganizationById(
  db: Executor,
  organizationId: string,
): Promise<OrganizationRow | null> {
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ?? null;
}

/**
 * The caller's role in an organization, or `null` when they are not a member.
 *
 * The permission gate, and it returns a ROLE rather than the row so nothing
 * downstream can leak a membership it only meant to test. Every route that
 * required `role: { $in: ['owner', 'admin'] }` compares the answer instead.
 */
export async function findMemberRole(
  db: Executor,
  organizationId: string,
  oxyUserId: string,
): Promise<OrganizationRole | null> {
  const [row] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.oxyUserId, oxyUserId),
      ),
    )
    .limit(1);
  return row ? (row.role as OrganizationRole) : null;
}

export interface CreateOrganizationInput {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly ownerId: string;
}

/**
 * Create an organization and seat its creator as owner, atomically.
 *
 * Returns `null` when the slug is taken — including when it differs only in
 * case, because `organizations_slug_lower_key` is a unique index on
 * `lower(slug)`.
 *
 * `ON CONFLICT DO NOTHING RETURNING` rather than a `SELECT` first and rather
 * than catching a duplicate-key error. The read-then-write is a race that seats
 * the loser as owner of nothing; the catch cannot tell a duplicate from a
 * dropped connection, and inside a transaction a raised error has already
 * aborted every later statement (`25P02`), so the owner INSERT below could not
 * run in the same transaction anyway. An empty `RETURNING` leaves the
 * transaction healthy and says exactly one thing.
 *
 * Only the four fields a caller may choose are written. `ownerId` is the
 * authenticated account, supplied by the route, never taken from the body.
 *
 * The TRANSACTION guards the gap between the two inserts: an organization whose
 * owner membership never landed has nobody who can administer or delete it, and
 * it has burned its slug permanently. That path is not asserted by the suite and
 * the test says so — no statement-level failure of the second insert is
 * reachable, and provoking one needs DDL on a database every other
 * `*.pgdb.test.ts` shares.
 */
export async function createOrganization(
  db: ApiDatabase,
  input: CreateOrganizationInput,
): Promise<OrganizationRow | null> {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizations)
      .values({
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        ownerId: input.ownerId,
      })
      .onConflictDoNothing()
      .returning();

    if (!organization) return null;

    await tx.insert(organizationMembers).values({
      organizationId: organization.id,
      oxyUserId: input.ownerId,
      role: 'owner',
      permissions: ['*'],
    });

    return organization;
  });
}

/**
 * What a caller may change about an organization.
 *
 * `settings` is nested rather than flattened BECAUSE the Mongo statement was
 * `$set: { settings: { … } }`, which replaced the whole sub-document: a PATCH
 * carrying only `billingEmail` cleared `apiCallLimit`. Flattening it here would
 * quietly turn that into a partial update — a behaviour change invisible in
 * review and untestable from the column list. {@link updateOrganization}
 * reproduces the replacement, and the pgdb suite pins it.
 *
 * `ownerId`, `slug`, `creditsPaid` and `stripeCustomerId` are absent BY TYPE.
 * The route's zod schema already refuses them, but a whitelist that lives in the
 * repository is the one a second route cannot forget: `credits_paid` is a
 * balance and `owner_id` decides who may delete the organization.
 */
export interface OrganizationUpdate {
  readonly name?: string;
  readonly description?: string;
  readonly image?: string;
  readonly settings?: {
    readonly billingEmail?: string;
    readonly apiCallLimit?: number;
  };
}

/**
 * Apply an update, or `null` when no such organization exists.
 *
 * The SET clause is built from DEFINED keys only. `$set: { x: undefined }` is a
 * no-op in Mongo and writes NULL in Postgres, so spreading the parsed body would
 * erase whatever the caller did not mention.
 */
export async function updateOrganization(
  db: ApiDatabase,
  organizationId: string,
  updates: OrganizationUpdate,
): Promise<OrganizationRow | null> {
  const values: Partial<typeof organizations.$inferInsert> = {};
  if (updates.name !== undefined) values.name = updates.name;
  if (updates.description !== undefined) values.description = updates.description;
  if (updates.image !== undefined) values.image = updates.image;
  if (updates.settings !== undefined) {
    // The whole sub-document, exactly as `$set: { settings: … }` replaced it.
    values.settingsBillingEmail = updates.settings.billingEmail ?? null;
    values.settingsApiCallLimit = updates.settings.apiCallLimit ?? null;
  }

  if (Object.keys(values).length === 0) return findOrganizationById(db, organizationId);

  const [row] = await db
    .update(organizations)
    .set(values)
    .where(eq(organizations.id, organizationId))
    .returning();
  return row ?? null;
}

/**
 * Delete an organization.
 *
 * Its members, invitations and shared agents go with it through
 * `ON DELETE CASCADE`, which is asserted directly in
 * `db/__tests__/organizations.pgdb.test.ts` ("removes members, invites and
 * shared agents when the organization goes"). The Mongo route deleted the
 * members by hand and LEAKED the invitations and the shared agents — a live
 * invitation token to a deleted organization outlived it — so this is a fix
 * carried by the schema rather than a redundancy removed from the route.
 */
export async function deleteOrganization(
  db: ApiDatabase,
  organizationId: string,
): Promise<OrganizationRow | null> {
  const [row] = await db
    .delete(organizations)
    .where(eq(organizations.id, organizationId))
    .returning();
  return row ?? null;
}

/* ------------------------------ members ------------------------------ */

/** One organization's members, newest first. */
export async function listMembers(
  db: ApiDatabase,
  organizationId: string,
): Promise<OrganizationMemberRow[]> {
  return db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, organizationId))
    .orderBy(desc(organizationMembers.createdAt));
}

/** One member, but only if it belongs to this organization. */
export async function findMemberOfOrganization(
  db: ApiDatabase,
  memberId: string,
  organizationId: string,
): Promise<OrganizationMemberRow | null> {
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.id, memberId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Change a member's role.
 *
 * The new role is `admin` or `member` BY TYPE. `owner` is not a role an update
 * may grant: it is the counterpart of `organizations.owner_id`, and letting this
 * write it would mint a second owner from a route whose whole check is "the
 * caller is the owner". The organization scope is required, so an owner of one
 * organization cannot rewrite a role in another.
 */
export async function updateMemberRole(
  db: ApiDatabase,
  memberId: string,
  organizationId: string,
  role: Exclude<OrganizationRole, 'owner'>,
): Promise<OrganizationMemberRow | null> {
  const [row] = await db
    .update(organizationMembers)
    .set({ role })
    .where(
      and(
        eq(organizationMembers.id, memberId),
        eq(organizationMembers.organizationId, organizationId),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Remove a member, unless it is the owner.
 *
 * The owner exclusion is part of the STATEMENT rather than a check the caller
 * makes after a read: the route's read-then-delete could always be raced, and a
 * removed owner leaves an organization nobody can administer. Returns `null`
 * when there is no such member for this organization — the caller distinguishes
 * that from the owner case with {@link findMemberOfOrganization}.
 */
export async function deleteNonOwnerMember(
  db: ApiDatabase,
  memberId: string,
  organizationId: string,
): Promise<OrganizationMemberRow | null> {
  const [row] = await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.id, memberId),
        eq(organizationMembers.organizationId, organizationId),
        sql`${organizationMembers.role} <> 'owner'`,
      ),
    )
    .returning();
  return row ?? null;
}

/* ------------------------------ invitations ------------------------------ */

export interface CreateInviteInput {
  readonly organizationId: string;
  readonly role: OrganizationInviteRole;
  readonly token: string;
  readonly invitedBy: string;
  readonly expiresAt: Date;
}

/**
 * Issue an invitation.
 *
 * `email` is deliberately not a parameter. The Mongoose field carried
 * `lowercase`/`trim` setters and no route ever wrote it — the console posts an
 * `email` that the route's zod schema drops — so adding a writer here would be
 * inventing a feature during a port. If one is added later it normalises at this
 * call site, per the schema comment; no index depends on the normalisation.
 */
export async function createInvite(
  db: ApiDatabase,
  input: CreateInviteInput,
): Promise<OrganizationInviteRow> {
  const [row] = await db
    .insert(organizationInvites)
    .values({
      organizationId: input.organizationId,
      role: input.role,
      token: input.token,
      invitedBy: input.invitedBy,
      status: 'pending',
      expiresAt: input.expiresAt,
    })
    .returning();
  if (!row) throw new Error('inserting an organization invitation returned no row');
  return row;
}

/** An organization's live invitations, newest first. */
export async function listPendingInvites(
  db: ApiDatabase,
  organizationId: string,
  now: Date = new Date(),
): Promise<OrganizationInviteRow[]> {
  return db
    .select()
    .from(organizationInvites)
    .where(
      and(
        eq(organizationInvites.organizationId, organizationId),
        eq(organizationInvites.status, 'pending'),
        gt(organizationInvites.expiresAt, now),
      ),
    )
    .orderBy(desc(organizationInvites.createdAt));
}

export interface PendingInviteWithOrganization {
  readonly invite: OrganizationInviteRow;
  readonly organization: OrganizationRow;
}

/**
 * A live invitation and the organization it names, by token.
 *
 * An INNER join, unlike the developer platform's `populate` replacement: the
 * foreign key is `NOT NULL` and cascades, so an invitation without its
 * organization cannot exist, and answering with a null organization would put
 * the accept page into a state it has no rendering for.
 *
 * "Live" is `pending` AND not past `expires_at` — an expired invitation is not
 * found rather than found-and-refused, which is what the route's single 404
 * ("not found, expired, or already used") already told the caller.
 */
export async function findLiveInviteByToken(
  db: ApiDatabase,
  token: string,
  now: Date = new Date(),
): Promise<PendingInviteWithOrganization | null> {
  const [row] = await db
    .select({ invite: organizationInvites, organization: organizations })
    .from(organizationInvites)
    .innerJoin(organizations, eq(organizationInvites.organizationId, organizations.id))
    .where(
      and(
        eq(organizationInvites.token, token),
        eq(organizationInvites.status, 'pending'),
        gt(organizationInvites.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * What accepting an invitation did.
 *
 * A discriminated union rather than a nullable row, because the route answers
 * three different statuses and `already-member` is a 400 that still MARKS the
 * invitation accepted — a distinction a `null` cannot carry.
 */
export type AcceptInviteResult =
  | { readonly status: 'not-found' }
  | { readonly status: 'already-member' }
  | {
      readonly status: 'accepted';
      readonly organization: OrganizationRow;
      readonly role: OrganizationInviteRole;
    };

/**
 * Accept an invitation by token.
 *
 * ## The duplicate membership is handled by the STATEMENT, not by a catch
 *
 * Mongo read the membership first and, on a hit, marked the invitation accepted
 * and answered 400. That read-then-write is a race, and the Mongo idiom it
 * invites — insert, catch E11000, treat it as "already done" — does not port:
 * inside a transaction the raised error aborts every later statement (`25P02`),
 * so the invitation could not then be marked accepted, and a catch cannot tell a
 * duplicate from a dropped connection. `ON CONFLICT DO NOTHING RETURNING` on
 * `organization_members_org_user_key` answers the same question with no error to
 * classify: an empty result means the row was already there, and the transaction
 * is still healthy enough to finish marking the invitation.
 *
 * ## The invitation is claimed FIRST, and that is what makes it single-use
 *
 * The `UPDATE … WHERE status = 'pending'` is the claim: two concurrent
 * acceptances of one token both reach it, one updates a row and one updates
 * none, and the loser leaves with `not-found`. Reading the invitation and then
 * updating it would let both through.
 *
 * `accepted_at` and `accepted_by` are written together because
 * `organization_invites_accepted_pair_check` requires it — an acceptance names
 * its accepter or records neither.
 */
export async function acceptInvite(
  db: ApiDatabase,
  token: string,
  oxyUserId: string,
  now: Date = new Date(),
): Promise<AcceptInviteResult> {
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .update(organizationInvites)
      .set({ status: 'accepted', acceptedAt: now, acceptedBy: oxyUserId })
      .where(
        and(
          eq(organizationInvites.token, token),
          eq(organizationInvites.status, 'pending'),
          gt(organizationInvites.expiresAt, now),
        ),
      )
      .returning();

    if (!invite) return { status: 'not-found' };

    const [member] = await tx
      .insert(organizationMembers)
      .values({
        organizationId: invite.organizationId,
        oxyUserId,
        role: invite.role,
        permissions: [],
      })
      .onConflictDoNothing()
      .returning();

    if (!member) return { status: 'already-member' };

    const organization = await findOrganizationById(tx, invite.organizationId);
    // The foreign key is NOT NULL and the row was just joined to; a miss here is
    // a broken database rather than a state the route has an answer for.
    if (!organization) {
      throw new Error(`invitation ${invite.id} names a missing organization`);
    }

    return {
      status: 'accepted',
      organization,
      role: invite.role as OrganizationInviteRole,
    };
  });
}

/** Decline a live invitation; `null` means there was none to decline. */
export async function declineInvite(
  db: ApiDatabase,
  token: string,
  now: Date = new Date(),
): Promise<OrganizationInviteRow | null> {
  const [row] = await db
    .update(organizationInvites)
    .set({ status: 'declined' })
    .where(
      and(
        eq(organizationInvites.token, token),
        eq(organizationInvites.status, 'pending'),
        gt(organizationInvites.expiresAt, now),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Revoke a pending invitation.
 *
 * Scoped by organization for the same reason every member function is: the
 * caller proved they administer THIS organization and nothing else.
 */
export async function revokeInvite(
  db: ApiDatabase,
  inviteId: string,
  organizationId: string,
): Promise<OrganizationInviteRow | null> {
  const [row] = await db
    .update(organizationInvites)
    .set({ status: 'expired' })
    .where(
      and(
        eq(organizationInvites.id, inviteId),
        eq(organizationInvites.organizationId, organizationId),
        eq(organizationInvites.status, 'pending'),
      ),
    )
    .returning();
  return row ?? null;
}

/* --------------------------- shared agents --------------------------- */

/**
 * Share an agent into an organization.
 *
 * `ON CONFLICT DO NOTHING` where Mongo used an upsert with `$setOnInsert`: the
 * unique index is `organization_agents_org_agent_key`, sharing twice is a no-op,
 * and `added_by` keeps naming whoever shared it first. The route answers
 * `{ added: true }` either way, exactly as the upsert did.
 */
export async function shareAgentWithOrganization(
  db: ApiDatabase,
  organizationId: string,
  agentId: string,
  addedBy: string,
): Promise<void> {
  await db
    .insert(organizationAgents)
    .values({ organizationId, agentId, addedBy })
    .onConflictDoNothing();
}

/** The agents shared into an organization, most recently shared first. */
export async function listSharedAgentIds(
  db: ApiDatabase,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ agentId: organizationAgents.agentId })
    .from(organizationAgents)
    .where(eq(organizationAgents.organizationId, organizationId))
    .orderBy(desc(organizationAgents.createdAt));
  return rows.map((row) => row.agentId);
}

/** Stop sharing an agent; `false` means it was not shared here. */
export async function unshareAgentFromOrganization(
  db: ApiDatabase,
  organizationId: string,
  agentId: string,
): Promise<boolean> {
  const [row] = await db
    .delete(organizationAgents)
    .where(
      and(
        eq(organizationAgents.organizationId, organizationId),
        eq(organizationAgents.agentId, agentId),
      ),
    )
    .returning({ id: organizationAgents.id });
  return row !== undefined;
}
