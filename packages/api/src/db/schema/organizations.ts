/** Workspace records, frozen legacy authority evidence, and shared-agent relationships.
 * Oxy owns identity and membership. No runtime path reads the evidence tables.
 * Old invitation tokens are destroyed during post-rollout; metadata survives.
 */
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { checkOneOf } from './columns';

import {
  ORGANIZATION_ROLES,
  ORGANIZATION_INVITE_ROLES,
  ORGANIZATION_INVITE_STATUSES,
} from '../../domain/legacy-organization-evidence';

export const organizations = pgTable(
  'organizations',
  {
    id: generatedId(),
    oxyAccountId: text().notNull(),
    slug: text().notNull(),
    creditsPaid: integer().notNull().default(0),
    settingsBillingEmail: text(),
    settingsApiCallLimit: integer(),
    stripeCustomerId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('organizations_slug_lower_key').on(sql`lower(${t.slug})`),
    uniqueIndex('organizations_oxy_account_key').on(t.oxyAccountId),
  ],
);

export const organizationMembers = pgTable(
  'organization_members',
  {
    id: generatedId(),
    organizationId: text()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
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
    uniqueIndex('organization_members_one_owner_key')
      .on(t.organizationId)
      .where(sql`${t.role} = 'owner'`),
    index('organization_members_oxy_user_id_idx').on(t.oxyUserId),
    checkOneOf('organization_members_role_check', t.role, ORGANIZATION_ROLES),
  ],
);

export const organizationInvites = pgTable(
  'organization_invites',
  {
    id: generatedId(),
    organizationId: text()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text(),
    role: text({ enum: ORGANIZATION_INVITE_ROLES as unknown as [string, ...string[]] })
      .notNull()
      .default('member'),
    invitedBy: text().notNull(),
    status: text({ enum: ORGANIZATION_INVITE_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('pending'),
    expiresAt: timestamptz().notNull(),
    acceptedAt: timestamptz(),
    acceptedBy: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Partial over a nullable column: only invites addressed to an email.
    index('organization_invites_org_email_idx')
      .on(t.organizationId, t.email)
      .where(sql`${t.email} is not null`),
    index('organization_invites_email_status_idx')
      .on(t.email, t.status)
      .where(sql`${t.email} is not null`),
    // Historical deadline index retained for audit queries; no active expiry writer.
    index('organization_invites_expires_at_idx').on(t.expiresAt),
    checkOneOf('organization_invites_role_check', t.role, ORGANIZATION_INVITE_ROLES),
    checkOneOf('organization_invites_status_check', t.status, ORGANIZATION_INVITE_STATUSES),
    // An acceptance names its accepter, or neither is recorded; both fields
    // are written by one operation.
    check(
      'organization_invites_accepted_pair_check',
      sql`(${t.acceptedAt} is null) = (${t.acceptedBy} is null)`,
    ),
  ],
);

export const organizationAgents = pgTable(
  'organization_agents',
  {
    id: generatedId(),
    organizationId: text()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    agentId: text().notNull(),
    addedBy: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('organization_agents_org_agent_key').on(t.organizationId, t.agentId),
    index('organization_agents_organization_id_idx').on(t.organizationId),
  ],
);

export const organizationIdentityArchives = pgTable('organization_identity_archives', {
  organizationId: text()
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'restrict' }),
  name: text().notNull(),
  description: text(),
  image: text(),
  ownerId: text().notNull(),
  archivedAt: createdAt(),
});
