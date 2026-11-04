import { OxyApiError, type AccountNode, type OxyServices } from '@oxy.so/core';
import { OxyAccessError, accessErrorStatus, type OxyAccountAccess } from '@oxy.so/core/server';
import type { Organization } from '@oxy.so/contracts';
import type { Request } from 'express';
import type { OrganizationRow } from '../db/organizations/organizationRepository.js';
import { oxy } from './oxy.js';

export class OrganizationAccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ACCESS_MESSAGES: Record<number, string> = {
  401: 'Your Oxy session is no longer valid',
  403: 'Organization access is required',
  404: 'Organization access is required',
  503: 'Organization access is temporarily unavailable',
};

/**
 * One outcome mapping for every Oxy answer these routes read: a gone session
 * is 401, a definitive "no" (403/404) is 403, and anything else — an outage, a
 * timeout, an unreadable answer — is 503, never a refusal.
 */
function organizationAccessError(error: unknown): unknown {
  if (error instanceof OrganizationAccessError) return error;
  if (error instanceof OxyAccessError) {
    const status = accessErrorStatus(error);
    return new OrganizationAccessError(status === 404 ? 403 : status, ACCESS_MESSAGES[status]);
  }
  if (error instanceof OxyApiError) {
    const status =
      error.status === 401 ? 401 : error.status === 403 || error.status === 404 ? 403 : 503;
    return new OrganizationAccessError(status, ACCESS_MESSAGES[status]);
  }
  return error;
}

/**
 * Run `run` as the person behind `req` (`oxy.withUser`): exactly their verified
 * bearer, disposed when it settles. The shared client is never given a session.
 */
export async function withOrganizationSession<T>(
  req: Request,
  run: (client: OxyServices) => Promise<T>,
): Promise<T> {
  try {
    return await oxy.withUser(req, run);
  } catch (error) {
    throw organizationAccessError(error);
  }
}

/** What the caller may do in one Oxy account, as these routes ask it. */
export type OrganizationAccess = Pick<OxyAccountAccess, 'kind' | 'role' | 'has'>;

/**
 * The caller's effective access in organization `accountId`
 * (`oxy.accountAccessFor`), read fresh before a write.
 */
export async function organizationAccessFor(
  req: Request,
  accountId: string,
): Promise<OrganizationAccess> {
  try {
    return await oxy.accountAccessFor(req, accountId, { fresh: req.method !== 'GET' });
  } catch (error) {
    throw organizationAccessError(error);
  }
}

/** The caller's access as one entry of their own account list states it. */
export function listedOrganizationAccess(node: AccountNode): OrganizationAccess {
  const member = node.callerMembership;
  const permissions = member?.status === 'active' ? member.permissions : [];
  return {
    kind: node.kind,
    role: member?.role ?? '',
    has: (permission) => permissions.includes(permission),
  };
}

export function hasOrganizationPermission(access: OrganizationAccess, permission: string): boolean {
  return access.kind === 'organization' && access.has(permission);
}

export function requireOrganizationPermission(
  access: OrganizationAccess,
  permission: string,
): void {
  if (!hasOrganizationPermission(access, permission))
    throw new OrganizationAccessError(403, 'Insufficient organization permissions');
}

/**
 * Globally deduplicated, bounded identity hydration; archived names never
 * become fallback identities. The directory is public, so it is read by Alia's
 * own client and never carries the person's bearer.
 */
export async function organizationDirectory(
  accountIds: string[],
): Promise<Map<string, Organization>> {
  const ids = [...new Set(accountIds)];
  const directory = new Map<string, Organization>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    let result;
    try {
      result = await oxy.organizations.batch({ ids: ids.slice(offset, offset + 100) });
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
  access: OrganizationAccess,
) {
  return {
    _id: row.id,
    id: row.id,
    oxyAccountId: organization.accountId,
    name: organization.name,
    image: organization.avatar ?? null,
    slug: row.slug,
    role: access.role,
    membershipScope: 'organization' as const,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    settings: {
      ...(hasOrganizationPermission(access, 'billing:read')
        ? { billingEmail: row.settingsBillingEmail }
        : {}),
      apiCallLimit: row.settingsApiCallLimit,
    },
    ...(hasOrganizationPermission(access, 'billing:read')
      ? { credits: { paid: row.creditsPaid }, stripeCustomerId: row.stripeCustomerId }
      : {}),
  };
}
