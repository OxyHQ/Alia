/** Alia workspace state only. Identity and membership are read from Oxy. */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index';
import { organizationAgents, organizations } from '../schema/organizations';

export type OrganizationRow = typeof organizations.$inferSelect;

export async function findOrganizationById(
  db: Executor,
  id: string,
): Promise<OrganizationRow | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return row ?? null;
}

export async function listOrganizationsForAccounts(
  db: Executor,
  accountIds: string[],
): Promise<OrganizationRow[]> {
  const ids = [...new Set(accountIds)];
  const rows: OrganizationRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    rows.push(
      ...(await db
        .select()
        .from(organizations)
        .where(inArray(organizations.oxyAccountId, ids.slice(offset, offset + 100)))),
    );
  }
  return rows.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

export async function createOrganization(
  db: ApiDatabase,
  oxyAccountId: string,
): Promise<OrganizationRow> {
  const [row] = await db
    .insert(organizations)
    .values({ oxyAccountId, slug: `workspace-${oxyAccountId}` })
    .returning();
  if (!row) throw new Error('Workspace insert returned no row');
  return row;
}

export interface OrganizationUpdate {
  readonly billingEmail?: string | null;
  readonly apiCallLimit?: number | null;
}

/** Merge explicitly provided workspace settings; omitted fields retain their values. */
export async function updateOrganization(
  db: ApiDatabase,
  id: string,
  updates: OrganizationUpdate,
): Promise<OrganizationRow | null> {
  const values: Partial<typeof organizations.$inferInsert> = {};
  if (updates.billingEmail !== undefined) values.settingsBillingEmail = updates.billingEmail;
  if (updates.apiCallLimit !== undefined) values.settingsApiCallLimit = updates.apiCallLimit;
  if (!Object.keys(values).length) return findOrganizationById(db, id);
  const [row] = await db
    .update(organizations)
    .set(values)
    .where(eq(organizations.id, id))
    .returning();
  return row ?? null;
}

/* --------------------------- shared agents --------------------------- */

/**
 * Share an agent into an organization.
 *
 * `ON CONFLICT DO NOTHING`: the unique index is `organization_agents_org_agent_key`, sharing twice is a no-op,
 * and `added_by` keeps naming whoever shared it first. The route answers
 * `{ added: true }` either way.
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
