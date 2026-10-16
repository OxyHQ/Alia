import { Router, type Request, type Response } from 'express';
import type { OxyServices } from '@oxy.so/core';
import { isUniqueViolation } from '@oxy.so/db';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth';
import { getDb } from '../db/index.js';
import {
  createOrganization,
  findOrganizationById,
  listOrganizationsForAccounts,
  listSharedAgentIds,
  shareAgentWithOrganization,
  unshareAgentFromOrganization,
  updateOrganization,
} from '../db/organizations/organizationRepository.js';
import { findAgentsByIds, withoutInternalAgentBindings } from '../db/agents/agentRepository.js';
import { attachAgentIdentities } from '../lib/agent-identity.js';
import { loadAgentForActor, refusalStatus, refusalMessage } from '../lib/agent-account.js';
import {
  hasOrganizationPermission,
  requireOrganizationPermission,
  OrganizationAccessError,
  organizationDirectory,
  withOrganizationSession,
  workspaceResponse,
} from '../lib/organization-access.js';
import { log } from '../lib/logger.js';

const router = Router();
router.use(authenticateToken);

type Handler = (req: Request, res: Response, client: OxyServices) => Promise<unknown>;
function session(handler: Handler) {
  return async (req: Request, res: Response) => {
    try {
      if (!req.user?.id || req.machineCredential)
        throw new OrganizationAccessError(401, 'An Oxy user session is required');
      await withOrganizationSession(req.accessToken, (client) => handler(req, res, client));
    } catch (error) {
      if (error instanceof OrganizationAccessError)
        return res.status(error.status).json({ error: error.message });
      if (error instanceof z.ZodError)
        return res
          .status(400)
          .json({ error: 'Invalid organization request', details: error.flatten() });
      if (isUniqueViolation(error))
        return res.status(409).json({ error: 'This organization already has an Alia workspace' });
      log.organization.error({ err: error }, 'Organization request failed');
      return res.status(500).json({ error: 'Organization request failed' });
    }
  };
}

async function workspace(req: Request, client: OxyServices, permission: string) {
  const row = await findOrganizationById(getDb(), String(req.params.id));
  if (!row) throw new OrganizationAccessError(404, 'Workspace not found');
  const directory = await organizationDirectory(client, [row.oxyAccountId]);
  const organization = directory.get(row.oxyAccountId);
  if (!organization) throw new OrganizationAccessError(404, 'Organization unavailable');
  const node = await client.accounts.get(organization.accountId);
  requireOrganizationPermission(node, permission);
  return { row, organization, node };
}

// Legacy links never read or redeem the retired local credential table.
router.all('/invites/:token/:action', (_req, res) =>
  res.status(410).json({
    error:
      'This invitation is no longer available. Ask an organization administrator for access in Oxy.',
  }),
);
router.get(
  '/',
  session(async (_req, res, client) => {
    const nodes = (await client.accounts.list()).filter((node) =>
      hasOrganizationPermission(node, 'account:read'),
    );
    const byAccount = new Map(nodes.map((node) => [node.accountId, node]));
    const rows = await listOrganizationsForAccounts(
      getDb(),
      nodes.map((node) => node.accountId),
    );
    const directory = await organizationDirectory(
      client,
      rows.map((row) => row.oxyAccountId),
    );
    res.json({
      organizations: rows.flatMap((row) => {
        const organization = directory.get(row.oxyAccountId);
        const node = organization && byAccount.get(organization.accountId);
        return organization && node ? [workspaceResponse(row, organization, node)] : [];
      }),
    });
  }),
);

router.post(
  '/',
  session(async (req, res, client) => {
    const { oxyAccountId } = z
      .object({ oxyAccountId: z.string().trim().min(1).max(128) })
      .strict()
      .parse(req.body);
    const directory = await organizationDirectory(client, [oxyAccountId]);
    const organization = directory.get(oxyAccountId);
    if (!organization || organization.status !== 'active' || organization.claimStatus !== 'claimed')
      throw new OrganizationAccessError(403, 'Select an active organization claimed in Oxy');
    const node = await client.accounts.get(organization.accountId);
    requireOrganizationPermission(node, 'account:update');
    if (!['owner', 'admin'].includes(node.callerMembership!.role))
      throw new OrganizationAccessError(403, 'Organization administrator access is required');
    const row = await createOrganization(getDb(), organization.accountId);
    res.status(201).json({ organization: workspaceResponse(row, organization, node) });
  }),
);
router.get(
  '/:id',
  session(async (req, res, client) => {
    const { row, organization, node } = await workspace(req, client, 'account:read');
    res.json({ organization: workspaceResponse(row, organization, node) });
  }),
);
router.patch(
  '/:id',
  session(async (req, res, client) => {
    const { settings } = z
      .object({
        settings: z
          .object({
            billingEmail: z.string().email().nullable().optional(),
            apiCallLimit: z.number().int().nonnegative().nullable().optional(),
          })
          .strict(),
      })
      .strict()
      .parse(req.body);
    const { row, organization, node } = await workspace(req, client, 'account:read');
    if (settings.billingEmail !== undefined) requireOrganizationPermission(node, 'billing:manage');
    if (settings.apiCallLimit !== undefined) requireOrganizationPermission(node, 'account:update');
    const updated = await updateOrganization(getDb(), row.id, settings);
    if (!updated) throw new OrganizationAccessError(404, 'Workspace not found');
    res.json({ organization: workspaceResponse(updated, organization, node) });
  }),
);
router.delete(
  '/:id',
  session(async (req, _res, client) => {
    await workspace(req, client, 'account:delete');
    throw new OrganizationAccessError(
      409,
      'Workspace records are retained with their billing and sharing history',
    );
  }),
);
router.post(
  '/:id/logo',
  session(async (req, _res, client) => {
    await workspace(req, client, 'account:update');
    throw new OrganizationAccessError(410, 'Manage the organization name and logo in Oxy');
  }),
);

// These endpoints manage the Oxy ORGANIZATION membership, across its products.
router.get(
  '/:id/members',
  session(async (req, res, client) => {
    const { organization } = await workspace(req, client, 'members:read');
    res.json({
      membershipScope: 'organization',
      oxyAccountId: organization.accountId,
      members: await client.accounts.members.list(organization.accountId),
    });
  }),
);
const memberRole = z.enum(['admin', 'editor', 'developer', 'billing', 'viewer']);
// Oxy grants access only after the invitee confirms, so a member is never
// added directly: create an invitation and let the recipient accept it in Oxy.
router.post(
  '/:id/members',
  session(async (req, _res, client) => {
    await workspace(req, client, 'members:read');
    throw new OrganizationAccessError(
      410,
      'Members join by invitation: POST /organization/:id/invitations with an email and role',
    );
  }),
);
router.get(
  '/:id/invitations',
  session(async (req, res, client) => {
    const { organization } = await workspace(req, client, 'members:read');
    res.json({
      membershipScope: 'organization',
      invitations: await client.accounts.invitations.list(organization.accountId),
    });
  }),
);
router.post(
  '/:id/invitations',
  session(async (req, res, client) => {
    const body = z
      .object({ email: z.string().trim().email().max(254), role: memberRole })
      .strict()
      .parse(req.body);
    const { organization } = await workspace(req, client, 'members:invite');
    res.status(201).json({
      membershipScope: 'organization',
      invitation: await client.accounts.invitations.create(organization.accountId, body),
    });
  }),
);
router.post(
  '/:id/invitations/:invitationId/resend',
  session(async (req, res, client) => {
    const { organization } = await workspace(req, client, 'members:invite');
    res.json({
      membershipScope: 'organization',
      invitation: await client.accounts.invitations.resend(
        organization.accountId,
        String(req.params.invitationId),
      ),
    });
  }),
);
router.delete(
  '/:id/invitations/:invitationId',
  session(async (req, res, client) => {
    const { organization } = await workspace(req, client, 'members:remove');
    await client.accounts.invitations.cancel(
      organization.accountId,
      String(req.params.invitationId),
    );
    res.json({ membershipScope: 'organization', cancelled: true });
  }),
);
router.patch(
  '/:id/members/:memberId',
  session(async (req, res, client) => {
    const body = z.object({ role: memberRole }).strict().parse(req.body);
    const { organization } = await workspace(req, client, 'members:update');
    res.json({
      membershipScope: 'organization',
      member: await client.accounts.members.update(
        organization.accountId,
        String(req.params.memberId),
        body,
      ),
    });
  }),
);
router.delete(
  '/:id/members/:memberId',
  session(async (req, res, client) => {
    const { organization } = await workspace(req, client, 'members:remove');
    await client.accounts.members.remove(organization.accountId, String(req.params.memberId));
    res.json({ membershipScope: 'organization', removed: true });
  }),
);
router.all(
  ['/:id/invites', '/:id/invites/:inviteId'],
  session(async (req, _res, client) => {
    await workspace(req, client, 'members:read');
    throw new OrganizationAccessError(410, 'Manage organization access in Oxy');
  }),
);

router.post(
  '/:id/agents',
  session(async (req, res, client) => {
    const { agentId } = z
      .object({ agentId: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    const { row } = await workspace(req, client, 'apps:update');
    // Sharing does not delegate the owner's app data. Only a live bot operator may share it.
    const loaded = await loadAgentForActor(getDb(), {
      agentId,
      oxyUserId: req.user!.id,
      accessToken: req.accessToken!,
      cache: false,
    });
    if (!loaded.ok)
      throw new OrganizationAccessError(
        loaded.refusal === 'agent_not_found' ? 404 : refusalStatus(loaded.refusal),
        loaded.refusal === 'agent_not_found' ? 'Agent not found' : refusalMessage(loaded.refusal),
      );
    if (loaded.agent.ownerOxyAccountId !== req.user!.id)
      throw new OrganizationAccessError(403, 'Only the agent owner may share it');
    await shareAgentWithOrganization(getDb(), row.id, agentId, req.user!.id);
    res.json({ added: true });
  }),
);
router.get(
  '/:id/agents',
  session(async (req, res, client) => {
    const { row } = await workspace(req, client, 'apps:read');
    const ids = await listSharedAgentIds(getDb(), row.id);
    const byId = new Map((await findAgentsByIds(getDb(), ids)).map((agent) => [agent.id, agent]));
    const agents = ids.flatMap((id) => {
      const agent = byId.get(id);
      return agent ? [agent] : [];
    });
    res.json({ agents: await attachAgentIdentities(agents.map(withoutInternalAgentBindings)) });
  }),
);
router.delete(
  '/:id/agents/:agentId',
  session(async (req, res, client) => {
    const { row } = await workspace(req, client, 'apps:update');
    const removed = await unshareAgentFromOrganization(getDb(), row.id, String(req.params.agentId));
    if (!removed) throw new OrganizationAccessError(404, 'Agent not found in workspace');
    res.json({ removed: true });
  }),
);
export default router;
