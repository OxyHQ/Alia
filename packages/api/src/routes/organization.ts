import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth';
import { getDb } from '../db/index.js';
import { findAgentById, findAgentsByIds } from '../db/agents/agentRepository.js';
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
  toInviteResponse,
  toMemberResponse,
  toOrganizationResponse,
  unshareAgentFromOrganization,
  updateNonOwnerMemberRole,
  updateOrganization,
  type OrganizationMemberResponse,
  type OrganizationMemberRow,
  type OrganizationRole,
} from '../db/organizations/organizationRepository.js';
import { uploadToS3, deleteFromS3 } from '../lib/s3';
import { storedMediaUrl } from '../lib/stored-media.js';
import { hydrateOxyUsers, type HydratedOxyUser } from '../lib/oxy-user-hydration.js';
import { attachAgentIdentities } from '../lib/agent-identity.js';
import { z } from 'zod';
import { log } from '../lib/logger.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const router = Router();

// All routes require authentication
/**
 * An organization, with its logo addressable.
 *
 * `image` holds the KEY of a stored object. A key is not an address, and this
 * is the one place an organization's logo gets one — an organization whose logo
 * cannot be addressed reports `null` rather than a string the browser cannot
 * fetch.
 */
function withAddressableLogo(
  req: Request,
  userId: string,
  organization: ReturnType<typeof toOrganizationResponse>,
): ReturnType<typeof toOrganizationResponse> {
  const image = organization.image;
  if (image === null || image === undefined || image === '') return organization;
  return { ...organization, image: storedMediaUrl(req, image, userId) };
}

router.use(authenticateToken);

/**
 * The roles that may administer an organization.
 *
 * Named once so every gate below asks the same question. `findMemberRole`
 * answers with the caller's own role and nothing else, so a route can compare it
 * but cannot accidentally serve somebody else's membership row.
 */
const ADMIN_ROLES: readonly OrganizationRole[] = ['owner', 'admin'];

/**
 * A member as the clients receive it: the row, plus `_id`, with `oxyUserId`
 * replaced by an Oxy profile when one resolved.
 *
 * The union on `oxyUserId` is the contract the console already declares
 * (`string | { _id, username, … }`) and the reason hydration can fail open.
 */
type HydratedMemberResponse = Omit<OrganizationMemberResponse, 'oxyUserId'> & {
  readonly oxyUserId: string | HydratedOxyUser;
};

/**
 * Replace each member's `oxyUserId` with a hydrated Oxy profile.
 *
 * `oxyUserId` names an account in Oxy, not a row here — see
 * `lib/oxy-user-hydration.ts`. One batch call for the whole membership, and an
 * id Oxy cannot resolve stays a bare id rather than removing the member from the
 * list.
 */
async function withHydratedMembers(
  members: readonly OrganizationMemberRow[],
): Promise<HydratedMemberResponse[]> {
  const profiles = await hydrateOxyUsers(members.map((m) => m.oxyUserId));
  return members.map((member) => ({
    ...toMemberResponse(member),
    oxyUserId: profiles.get(member.oxyUserId) ?? member.oxyUserId,
  }));
}

// ===========================================
// INVITE ROUTES (must be before /:id to avoid param conflicts)
// ===========================================

const BASE_URL = process.env.WEB_URL || 'https://alia.onl';

// Get invite info by token (for accept page preview)
router.get('/invites/:token/info', async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token);

    const found = await findLiveInviteByToken(getDb(), token);

    if (!found) {
      return res.status(404).json({ error: 'Invitation not found, expired, or already used' });
    }

    res.json({
      invite: {
        role: found.invite.role,
        expiresAt: found.invite.expiresAt,
        // The `.populate('organizationId', 'name slug image')` projection, kept
        // exactly: this endpoint is reachable by anyone holding a token, so it
        // answers with the organization's public face and no more.
        organization: {
          _id: found.organization.id,
          name: found.organization.name,
          slug: found.organization.slug,
          image: found.organization.image,
        },
      },
    });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error fetching invite info');
    res.status(500).json({ error: 'Failed to fetch invite info' });
  }
});

// Accept an invitation (by token)
router.post('/invites/:token/accept', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const token = String(req.params.token);

    const result = await acceptInvite(getDb(), token, userId);

    if (result.status === 'not-found') {
      return res.status(404).json({ error: 'Invitation not found, expired, or already used' });
    }

    if (result.status === 'already-member') {
      // The invitation is spent either way — it was claimed by the same
      // statement that discovered this — so a replay cannot seat anybody.
      return res.status(400).json({ error: 'You are already a member of this organization' });
    }

    log.organization.info(
      { organizationId: result.organization.id, userId },
      'Invitation accepted'
    );

    res.json({
      message: 'Invitation accepted successfully',
      organization: {
        _id: result.organization.id,
        name: result.organization.name,
        slug: result.organization.slug,
        image: result.organization.image,
      },
      role: result.role,
    });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error accepting invitation');
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

// Decline an invitation (by token)
router.post('/invites/:token/decline', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const token = String(req.params.token);

    const invite = await declineInvite(getDb(), token);

    if (!invite) {
      return res.status(404).json({ error: 'Invitation not found, expired, or already used' });
    }

    log.organization.info(
      { organizationId: invite.organizationId, userId, inviteId: invite.id },
      'Invitation declined'
    );

    res.json({ message: 'Invitation declined' });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error declining invitation');
    res.status(500).json({ error: 'Failed to decline invitation' });
  }
});

// ===========================================
// ORGANIZATION ROUTES
// ===========================================

// Get all organizations for the authenticated user
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const memberships = await listOrganizationsForMember(getDb(), userId);

    res.json({
      organizations: memberships.map((m) => ({
        ...withAddressableLogo(req, userId, toOrganizationResponse(m.organization)),
        role: m.role,
        memberCount: m.memberCount,
      })),
    });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error fetching organizations');
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

// Get a single organization by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);

    const role = await findMemberRole(getDb(), id, userId);

    if (!role) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const organization = await findOrganizationById(getDb(), id);

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const members = await listMembers(getDb(), id);
    const hydrated = await withHydratedMembers(members);

    res.json({
      organization: {
        ...withAddressableLogo(req, userId, toOrganizationResponse(organization)),
        role,
        members: hydrated.map((member) => ({
          _id: member._id,
          oxyUserId: member.oxyUserId,
          role: member.role,
          permissions: member.permissions,
          createdAt: member.createdAt,
        })),
      },
    });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error fetching organization');
    res.status(500).json({ error: 'Failed to fetch organization' });
  }
});

// Create a new organization
const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().max(500).optional(),
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const validatedData = createOrgSchema.parse(req.body);

    // The slug check IS the insert: `organizations_slug_lower_key` refuses a
    // duplicate, including one differing only in case, and a null result is
    // that refusal. A `findOne` first would leave a race that seated the loser
    // as the owner of nothing.
    const organization = await createOrganization(getDb(), {
      name: validatedData.name,
      slug: validatedData.slug,
      description: validatedData.description,
      ownerId: userId,
    });

    if (!organization) {
      return res.status(400).json({ error: 'Organization slug already taken' });
    }

    res.status(201).json({ organization: withAddressableLogo(req, userId, toOrganizationResponse(organization)) });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.organization.error({ err: error }, 'Error creating organization');
    res.status(500).json({ error: 'Failed to create organization' });
  }
});

// Update an organization
const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  image: z.string().optional(),
  settings: z.object({
    billingEmail: z.string().email().optional(),
    apiCallLimit: z.number().optional(),
  }).optional(),
});

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);

    const role = await findMemberRole(getDb(), id, userId);

    if (!role || !ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const validatedData = updateOrgSchema.parse(req.body);

    const organization = await updateOrganization(getDb(), id, validatedData);

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({ organization: withAddressableLogo(req, userId, toOrganizationResponse(organization)) });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.organization.error({ err: error }, 'Error updating organization');
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

// Upload organization image
router.post('/:id/image', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);

    const role = await findMemberRole(getDb(), id, userId);

    if (!role || !ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Image file is required' });
    }

    // Delete previous image from S3 if one exists
    const existingOrg = await findOrganizationById(getDb(), id);
    if (existingOrg?.image) {
      await deleteFromS3(existingOrg.image);
    }

    const imageKey = await uploadToS3(file.buffer, file.originalname, `organizations/${id}`, 'logo');

    const organization = await updateOrganization(getDb(), id, { image: imageKey });

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // The KEY is what the row holds; the response carries an address so the
    // uploader can show what it just uploaded.
    const image = storedMediaUrl(req, imageKey, userId);
    if (image === null) {
      return res.status(500).json({ error: 'The logo cannot be served by this deployment' });
    }
    res.json({ image, imageKey });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error uploading organization image');
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Delete an organization
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);

    // Only owner can delete
    const role = await findMemberRole(getDb(), id, userId);

    if (role !== 'owner') {
      return res.status(403).json({ error: 'Only owner can delete organization' });
    }

    // Members, invitations and shared agents go with it, by cascade.
    await deleteOrganization(getDb(), id);

    res.json({ message: 'Organization deleted successfully' });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error deleting organization');
    res.status(500).json({ error: 'Failed to delete organization' });
  }
});

// ===========================================
// MEMBER ROUTES
// ===========================================

// Get organization members
router.get('/:id/members', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);

    const role = await findMemberRole(getDb(), id, userId);

    if (!role) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const members = await withHydratedMembers(await listMembers(getDb(), id));

    res.json({ members });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error fetching members');
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Create invite link for organization
const inviteMemberSchema = z.object({
  role: z.enum(['admin', 'member']),
});

const INVITE_EXPIRY_DAYS = 7;

router.post('/:id/members', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const callerRole = await findMemberRole(getDb(), id, userId);

    if (!callerRole || !ADMIN_ROLES.includes(callerRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { role } = inviteMemberSchema.parse(req.body);

    // Verify the organization exists
    const organization = await findOrganizationById(getDb(), id);
    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Generate secure invite token
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const invite = await createInvite(getDb(), {
      organizationId: id,
      role,
      token,
      invitedBy: userId,
      expiresAt,
    });

    const inviteUrl = `${BASE_URL}/org-invite/${token}`;

    log.organization.info(
      { organizationId: id, role, inviteId: invite.id },
      'Organization invite link created'
    );

    res.status(201).json({
      invite: {
        _id: invite.id,
        role: invite.role,
        status: invite.status,
        token: invite.token,
        inviteUrl,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
      },
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.organization.error({ err: error }, 'Error creating invite link');
    res.status(500).json({ error: 'Failed to create invite link' });
  }
});

// List pending invitations for an organization
router.get('/:id/invites', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);

    const role = await findMemberRole(getDb(), id, userId);

    if (!role || !ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const invites = await listPendingInvites(getDb(), id);

    res.json({ invites: invites.map(toInviteResponse) });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error fetching invitations');
    res.status(500).json({ error: 'Failed to fetch invitations' });
  }
});

// Revoke (cancel) a pending invitation
router.delete('/:id/invites/:inviteId', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);
    const inviteId = String(req.params.inviteId);

    const role = await findMemberRole(getDb(), id, userId);

    if (!role || !ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const invite = await revokeInvite(getDb(), inviteId, id);

    if (!invite) {
      return res.status(404).json({ error: 'Invitation not found or already processed' });
    }

    log.organization.info({ inviteId, organizationId: id }, 'Invitation revoked');
    res.json({ message: 'Invitation revoked successfully' });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error revoking invitation');
    res.status(500).json({ error: 'Failed to revoke invitation' });
  }
});

// Update member role
const updateMemberSchema = z.object({
  role: z.enum(['admin', 'member']),
});

router.patch('/:id/members/:memberId', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);
    const memberId = String(req.params.memberId);

    // Check if user is owner (only owners can change roles)
    const callerRole = await findMemberRole(getDb(), id, userId);

    if (callerRole !== 'owner') {
      return res.status(403).json({ error: 'Only owner can change member roles' });
    }

    const { role } = updateMemberSchema.parse(req.body);

    const memberToChange = await findMemberOfOrganization(getDb(), memberId, id);

    if (!memberToChange) {
      return res.status(404).json({ error: 'Member not found' });
    }

    /**
     * The owner's own role is not changeable, and the answer is a 400 saying so
     * rather than the 404 a bare statement-level exclusion would produce — the
     * member exists, the caller may administer them, and the refusal is about
     * WHICH member. `DELETE …/members/:memberId` one route down answers "Cannot
     * remove organization owner" for the same reason and in the same shape.
     *
     * The only caller who can reach this is the owner naming their own row, and
     * the result would be an organization with zero owners: both this route and
     * the delete-organization route require a role that would no longer exist,
     * so nothing could ever be administered again. Self-demotion could not have
     * been a step towards handing ownership on, because `owner` is not a role
     * this route can grant.
     */
    if (memberToChange.role === 'owner') {
      return res.status(400).json({ error: 'Cannot change the role of the organization owner' });
    }

    // Scoped to THIS organization, and the owner exclusion is repeated in the
    // UPDATE itself so a role changing between the read and the write cannot
    // demote an owner. The Mongo statement took the member id alone, so an owner
    // here could rewrite a role in an organization they have nothing to do with.
    const member = await updateNonOwnerMemberRole(getDb(), memberId, id, role);

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json({ member: toMemberResponse(member) });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.organization.error({ err: error }, 'Error updating member');
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// Remove member from organization
router.delete('/:id/members/:memberId', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);
    const memberId = String(req.params.memberId);

    const callerRole = await findMemberRole(getDb(), id, userId);

    if (!callerRole || !ADMIN_ROLES.includes(callerRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const memberToRemove = await findMemberOfOrganization(getDb(), memberId, id);

    if (!memberToRemove) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Cannot remove owner
    if (memberToRemove.role === 'owner') {
      return res.status(400).json({ error: 'Cannot remove organization owner' });
    }

    // The exclusion is repeated in the DELETE itself, so a role changing between
    // the read and the write cannot remove an owner.
    await deleteNonOwnerMember(getDb(), memberId, id);

    res.json({ message: 'Member removed successfully' });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error removing member');
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// ===========================================
// ORGANIZATION AGENT ROUTES
// ===========================================

// Add an agent to an organization
router.post('/:id/agents', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);
    const agentId: unknown = req.body?.agentId;

    if (typeof agentId !== 'string' || agentId === '') {
      return res.status(400).json({ error: 'agentId is required' });
    }

    const role = await findMemberRole(getDb(), id, userId);

    if (!role || !ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Verify agent exists. `organization_agents.agent_id` carries no foreign key
    // — see the schema comment — so this read is what stops a share naming
    // nothing.
    const agent = await findAgentById(getDb(), agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    await shareAgentWithOrganization(getDb(), id, agentId, userId);

    res.json({ added: true });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error adding agent to organization');
    res.status(500).json({ error: 'Failed to add agent' });
  }
});

// List agents in an organization
router.get('/:id/agents', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);

    const role = await findMemberRole(getDb(), id, userId);

    if (!role) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    /**
     * `.populate('agentId')` followed by a `!= null` filter — a share whose
     * agent no longer exists was dropped from the list rather than serving a
     * null. `findAgentsByIds` answers with exactly the agents that exist, which
     * is the same set.
     *
     * The ORDER is restored here rather than taken from that answer.
     * `listSharedAgentIds` is sorted by when the agent was SHARED, which is what
     * the Mongo `.sort({ createdAt: -1 })` sorted by (the join row's timestamp,
     * not the agent's); `findAgentsByIds` is an `inArray` with no `ORDER BY`, so
     * Postgres may return any order at all. Serving that directly would reshuffle
     * the list on an unrelated day, which is the kind of difference nobody
     * reports and nobody can reproduce.
     */
    const agentIds = await listSharedAgentIds(getDb(), id);
    const byId = new Map(
      (await findAgentsByIds(getDb(), agentIds)).map((agent) => [agent.id, agent]),
    );
    const agents = agentIds.flatMap((agentId) => {
      const agent = byId.get(agentId);
      return agent ? [agent] : [];
    });

    // Identity is the bot account's, resolved for the whole page in one call.
    res.json({ agents: await attachAgentIdentities(agents) });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error fetching organization agents');
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// Remove an agent from an organization
router.delete('/:id/agents/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);
    const agentId = String(req.params.agentId);

    const role = await findMemberRole(getDb(), id, userId);

    if (!role || !ADMIN_ROLES.includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const removed = await unshareAgentFromOrganization(getDb(), id, agentId);

    if (!removed) {
      return res.status(404).json({ error: 'Agent not found in organization' });
    }

    res.json({ removed: true });
  } catch (error: unknown) {
    log.organization.error({ err: error }, 'Error removing agent from organization');
    res.status(500).json({ error: 'Failed to remove agent' });
  }
});

export default router;
