/**
 * Organizations, their members, their pending invitations and the agents they
 * share.
 *
 * ## Every account id here is `text` with no foreign key, and the `ref: 'User'`
 * declarations that named them are gone
 *
 * `owner_id`, `oxy_user_id`, `invited_by`, `accepted_by` and `added_by` all name
 * an account in Oxy, which owns identity. Mongoose declared four of them
 * `Schema.Types.ObjectId, ref: 'User'` — a join against a model this service
 * never registers, inert since #83 replaced the populates with HTTP hydration —
 * and S9 deleted those three model files along with their refs. The fifth,
 * `organization_agents.added_by`, still has its declaration in
 * `models/organization-agent.ts`, which is the last Mongoose file in this domain.
 *
 * `ObjectId` there was a naming accident rather than a type:
 * `DeveloperApp.oxyUserId` was a `String` for the same kind of value. Both port
 * to `text`, and `lib/oxy-user-hydration.ts` is how one is resolved.
 *
 * ## `organizations.slug` needs a FUNCTIONAL unique index
 *
 * Mongoose declared it `lowercase: true, unique: true` — a SETTER plus a unique
 * index, so `Foo` and `foo` were one value and the second insert was rejected.
 * Postgres has no setter, so a plain unique on the stored text would accept both
 * and the port would silently widen a namespace. `unique (lower(slug))`
 * reproduces the original guarantee whatever case a row is stored in, and does
 * not require a CHECK that would fail the backfill on any legacy row a
 * non-validating write path stored differently.
 */

import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';

/** Who may do what inside an organization. `owner` is additionally the row on `organizations.owner_id`. */
export const ORGANIZATION_ROLES = ['owner', 'admin', 'member'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/** The roles an INVITATION may offer. Deliberately narrower — an invite cannot mint an owner. */
export const ORGANIZATION_INVITE_ROLES = ['admin', 'member'] as const;
export type OrganizationInviteRole = (typeof ORGANIZATION_INVITE_ROLES)[number];

export const ORGANIZATION_INVITE_STATUSES = ['pending', 'accepted', 'declined', 'expired'] as const;
export type OrganizationInviteStatus = (typeof ORGANIZATION_INVITE_STATUSES)[number];

/**
 * An organization.
 *
 * `credits_paid` and the two `settings_*` fields are flattened sub-documents,
 * per the `routing_logs` precedent. `credits_paid` is a COUNT of AI credits, not
 * money — the same distinction `billing.ts` draws — so `integer`.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: generatedId(),
    name: text().notNull(),
    /** Unique case-INSENSITIVELY; see the file comment. */
    slug: text().notNull(),
    description: text(),
    image: text(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    ownerId: text().notNull(),
    creditsPaid: integer().notNull().default(0),
    settingsBillingEmail: text(),
    settingsApiCallLimit: integer(),
    stripeCustomerId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * The functional unique, NOT a plain one on the stored column. A plain
     * unique would let `Acme` and `acme` coexist where Mongo's `lowercase`
     * setter folded them into one — a silently widened namespace, and slugs are
     * how organizations are addressed. A `uniqueIndex` rather than `unique()`
     * because only the index form takes an expression, and nothing declares a
     * foreign key against `slug`, so the FK-ordering rule does not apply.
     */
    uniqueIndex('organizations_slug_lower_key').on(sql`lower(${t.slug})`),
    index('organizations_owner_id_idx').on(t.ownerId),
  ],
);

/**
 * One account's membership of one organization.
 *
 * `permissions` is a `text[]` with NO CHECK: the Mongoose field is a bare
 * `[String]` with no enum, so the `auth_health_metrics.method` rule applies and
 * production may hold anything a caller wrote. `role` DOES carry one.
 */
export const organizationMembers = pgTable(
  'organization_members',
  {
    id: generatedId(),
    organizationId: text()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** An Oxy account. No foreign key. */
    oxyUserId: text().notNull(),
    role: text({ enum: ORGANIZATION_ROLES as unknown as [string, ...string[]] })
      .notNull()
      .default('member'),
    permissions: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('organization_members_org_user_key').on(t.organizationId, t.oxyUserId),
    /**
     * AT MOST ONE OWNER PER ORGANIZATION, enforced by the database.
     *
     * `organization_members_role_check` ADMITS `owner` — it has to, because the
     * creator's row is one — so the only thing standing between a live request
     * and a second owner was the `z.enum(['admin', 'member'])` in
     * `routes/organization.ts`. Measured: widening that enum by one word makes
     * `PATCH /organization/:id/members/:memberId` answer 200 and mint a second
     * owner. `updateMemberRole`'s `Exclude<OrganizationRole, 'owner'>` does not
     * help — a type is erased at runtime, and a property enforced by the type
     * system needs a gate in the type system, which a request is not.
     *
     * An owner can delete the organization and rewrite every role in it, so
     * "a validator someone will one day simplify" is the wrong last line.
     *
     * ## What this costs a FUTURE ownership transfer, measured
     *
     * There is no transfer path today and there never has been — the only writer
     * of `role = 'owner'` in the whole history of this repository is the creation
     * insert, and `transferOwnership` appears in no commit. When one is written
     * it MUST demote before it promotes, in one transaction:
     *
     *   - demote-then-promote, two statements, one transaction: WORKS;
     *   - promote-then-demote: fails `23505`, and the error aborts the rest of
     *       the transaction (`25P02`), so the demote never runs either;
     *   - a single `UPDATE ... SET role = CASE ...` swapping both rows: fails,
     *       the classic unique-swap, and it CANNOT be fixed by deferring —
     *       a partial unique index cannot be `DEFERRABLE` and a unique
     *       CONSTRAINT cannot be partial. Both were tried against a real server;
     *       both are syntax errors.
     *
     * ## The alternative, and why it was not taken
     *
     * `EXCLUDE USING btree (organization_id WITH =) WHERE (role = 'owner')
     * DEFERRABLE` gives the same guarantee, needs no extension, and — verified —
     * still refuses a genuine second owner at COMMIT while letting a deferred
     * transaction pass through a transient two-owner state in any order. It was
     * rejected because drizzle 0.45 cannot express an exclusion constraint at
     * all, so it would live only in a hand-written migration, absent from this
     * file and from every snapshot, invisible to `drizzle-kit generate`. The
     * freedom it buys is the freedom to write a transfer in an order nobody has
     * a reason to choose, and a future author has to know the constraint exists
     * either way — deferral is not automatic, it has to be asked for by name.
     */
    uniqueIndex('organization_members_one_owner_key')
      .on(t.organizationId)
      .where(sql`${t.role} = 'owner'`),
    index('organization_members_oxy_user_id_idx').on(t.oxyUserId),
    checkOneOf('organization_members_role_check', t.role, ORGANIZATION_ROLES),
  ],
);

/**
 * A pending invitation to join an organization.
 *
 * ## Its TTL is the only one in the schema measured FROM a deadline with a
 * non-zero retention, and getting that wrong deletes rows early
 *
 * Mongo: `{expiresAt: 1}, expireAfterSeconds: 30 days` — so a row leaves 30 days
 * AFTER its own expiry, not 30 days after creation and not at expiry. Every
 * other `expires_at` TTL in this schema (`cache_entries`, `moderation_outboxes`,
 * `moderation_events`, `oauth_states`) is retention ZERO, so the pattern a reader
 * arrives with is the wrong one here:
 *
 *  - registering retention 0 by analogy deletes an invite the moment it expires,
 *    losing the window in which the UI can say "this invitation expired" rather
 *    than 404ing somebody who followed a link from their inbox;
 *  - registering it against `created_at` instead deletes LIVE invitations, because
 *    `expires_at` is `required` with no default and the caller chooses it, so a
 *    31-day-old invite with a 60-day expiry is still valid.
 *
 * `token` is a live credential in the clear — whoever holds it can join the
 * organization. It is `unique`, never logged, and must not appear in any
 * projection but the one that validates a redemption. `provider_keys.key` has
 * the same rule for the same reason.
 */
export const organizationInvites = pgTable(
  'organization_invites',
  {
    id: generatedId(),
    organizationId: text()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /**
     * Mongoose applied `lowercase` and `trim` setters. No unique index depends on
     * them here — both indexes carrying `email` are non-unique — so this is a
     * lookup-normalisation concern for the repository rather than a constraint,
     * and no functional index is needed. Normalise at the call site.
     */
    email: text(),
    role: text({ enum: ORGANIZATION_INVITE_ROLES as unknown as [string, ...string[]] })
      .notNull()
      .default('member'),
    /** A bearer credential. See the table comment. */
    token: text().notNull(),
    /** An Oxy account. No foreign key. */
    invitedBy: text().notNull(),
    status: text({ enum: ORGANIZATION_INVITE_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('pending'),
    /** Chosen by the caller, not defaulted. The sweep measures 30 days from HERE. */
    expiresAt: timestamptz().notNull(),
    acceptedAt: timestamptz(),
    /** An Oxy account. No foreign key. */
    acceptedBy: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('organization_invites_token_key').on(t.token),
    // Partial, the equivalent of Mongo's `sparse: true` on a nullable column.
    index('organization_invites_org_email_idx')
      .on(t.organizationId, t.email)
      .where(sql`${t.email} is not null`),
    index('organization_invites_email_status_idx')
      .on(t.email, t.status)
      .where(sql`${t.email} is not null`),
    // The expiry sweep's predicate column. Indexed because the sweep scans it.
    index('organization_invites_expires_at_idx').on(t.expiresAt),
    checkOneOf('organization_invites_role_check', t.role, ORGANIZATION_INVITE_ROLES),
    checkOneOf('organization_invites_status_check', t.status, ORGANIZATION_INVITE_STATUSES),
    // An acceptance names its accepter, or neither is recorded. Mongo could not
    // state this; both fields are written by one operation.
    check(
      'organization_invites_accepted_pair_check',
      sql`(${t.acceptedAt} is null) = (${t.acceptedBy} is null)`,
    ),
  ],
);

/**
 * An agent shared into an organization.
 *
 * `agent_id` names an `agents` row and carries no foreign key: that table is
 * batch 9, deliberately last because `Agent` has 29 production readers. Revisit
 * when it lands — a cascade is probably right here, since a shared agent that no
 * longer exists is not a sharing anybody can act on.
 */
export const organizationAgents = pgTable(
  'organization_agents',
  {
    id: generatedId(),
    organizationId: text()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    agentId: text().notNull(),
    /** An Oxy account. No foreign key. */
    addedBy: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('organization_agents_org_agent_key').on(t.organizationId, t.agentId),
    index('organization_agents_organization_id_idx').on(t.organizationId),
  ],
);
