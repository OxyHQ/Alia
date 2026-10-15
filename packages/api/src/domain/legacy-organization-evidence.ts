/** Retired Alia membership/invitation vocabularies, preserved only for immutable audit evidence. */
export const ORGANIZATION_ROLES = ['owner', 'admin', 'member'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const ORGANIZATION_INVITE_ROLES = ['admin', 'member'] as const;
export type OrganizationInviteRole = (typeof ORGANIZATION_INVITE_ROLES)[number];

export const ORGANIZATION_INVITE_STATUSES = ['pending', 'accepted', 'declined', 'expired'] as const;
export type OrganizationInviteStatus = (typeof ORGANIZATION_INVITE_STATUSES)[number];
