import { OxyApiError, OxyServices, type AccountNode } from '@oxy.so/core';
import type { Organization } from '@oxy.so/contracts';
import type { OrganizationRow } from '../db/organizations/organizationRepository.js';

export class OrganizationAccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Original verified human bearer; no mutation of the shared authentication client. */
export async function withOrganizationSession<T>(
  accessToken: string | undefined,
  run: (client: OxyServices) => Promise<T>,
): Promise<T> {
  if (!accessToken) throw new OrganizationAccessError(401, 'An Oxy session is required');
  const client = new OxyServices({
    baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
    enableCache: false,
    enableRetry: false,
    requestTimeout: 5000,
  });
  client.session.setAccessToken(accessToken);
  try {
    return await run(client);
  } catch (error) {
    if (error instanceof OrganizationAccessError) throw error;
    if (error instanceof OxyApiError) {
      if (error.status === 401)
        throw new OrganizationAccessError(401, 'Your Oxy session is no longer valid');
      if (error.status === 403 || error.status === 404)
        throw new OrganizationAccessError(403, 'Organization access is required');
      throw new OrganizationAccessError(503, 'Organization access is temporarily unavailable');
    }
    throw error;
  } finally {
    client.dispose();
  }
}

export function hasOrganizationPermission(node: AccountNode, permission: string): boolean {
  const member = node.callerMembership;
  return (
    node.kind === 'organization' &&
    member?.status === 'active' &&
    member.permissions.includes(permission)
  );
}

export function requireOrganizationPermission(node: AccountNode, permission: string): void {
  if (!hasOrganizationPermission(node, permission))
    throw new OrganizationAccessError(403, 'Insufficient organization permissions');
}

/** Globally deduplicated, bounded identity hydration; archived names never become fallback identities. */
export async function organizationDirectory(
  client: OxyServices,
  accountIds: string[],
): Promise<Map<string, Organization>> {
  const ids = [...new Set(accountIds)];
  const directory = new Map<string, Organization>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    let result;
    try {
      result = await client.organizations.batch({ ids: ids.slice(offset, offset + 100) });
    } catch {
      throw new OrganizationAccessError(503, 'Organization directory is temporarily unavailable');
    }
    for (const item of result.items)
      if (item.organization.status !== 'suppressed')
        directory.set(item.requestedAccountId, item.organization);
  }
  return directory;
}

export function workspaceResponse(
  row: OrganizationRow,
  organization: Organization,
  node: AccountNode,
) {
  return {
    _id: row.id,
    id: row.id,
    oxyAccountId: organization.accountId,
    name: organization.name,
    image: organization.avatar ?? null,
    slug: row.slug,
    role: node.callerMembership?.role,
    membershipScope: 'organization' as const,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    settings: {
      ...(hasOrganizationPermission(node, 'billing:read')
        ? { billingEmail: row.settingsBillingEmail }
        : {}),
      apiCallLimit: row.settingsApiCallLimit,
    },
    ...(hasOrganizationPermission(node, 'billing:read')
      ? { credits: { paid: row.creditsPaid }, stripeCustomerId: row.stripeCustomerId }
      : {}),
  };
}
