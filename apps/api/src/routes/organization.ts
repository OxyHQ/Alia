import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { authenticateToken, oxyClient } from '../middleware/auth';
import { Organization } from '../models/organization';
import { OrganizationMember } from '../models/organization-member';
import { OrganizationAgent } from '../models/organization-agent';
import { OrganizationInvite } from '../models/organization-invite';
import { Agent } from '../models/agent';
import { uploadToS3, deleteFromS3 } from '../lib/s3';
import { sendEmail, buildInviteEmailHtml } from '../lib/email';
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
router.use(authenticateToken);

// ===========================================
// INVITE ROUTES (must be before /:id to avoid param conflicts)
// ===========================================

// Get pending invitations for the current user (across all orgs)
router.get('/invites/mine', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Get user's email from Oxy
    let userEmail: string | undefined;
    try {
      const oxyUser = await oxyClient.getUserById(userId);
      userEmail = oxyUser?.email;
    } catch {
      return res.status(500).json({ error: 'Could not determine your email address' });
    }

    if (!userEmail) {
      return res.json({ invites: [] });
    }

    const invites = await OrganizationInvite.find({
      email: userEmail.toLowerCase(),
      status: 'pending',
      expiresAt: { $gt: new Date() },
    })
      .populate('organizationId', 'name slug image')
      .sort({ createdAt: -1 });

    res.json({ invites });
  } catch (error) {
    log.organization.error({ err: error }, 'Error fetching user invitations');
    res.status(500).json({ error: 'Failed to fetch invitations' });
  }
});

// Accept an invitation (by token)
router.post('/invites/:token/accept', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { token } = req.params;

    const invite = await OrganizationInvite.findOne({
      token,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    });

    if (!invite) {
      return res.status(404).json({ error: 'Invitation not found, expired, or already used' });
    }

    // Check if user is already a member
    const existingMember = await OrganizationMember.findOne({
      organizationId: invite.organizationId,
      oxyUserId: userId,
    });

    if (existingMember) {
      // Mark invite as accepted even if already a member
      invite.status = 'accepted';
      invite.acceptedAt = new Date();
      invite.acceptedBy = userId as any;
      await invite.save();

      return res.status(400).json({ error: 'You are already a member of this organization' });
    }

    // Add user as a member with the invited role
    await OrganizationMember.create({
      organizationId: invite.organizationId,
      oxyUserId: userId,
      role: invite.role,
      permissions: [],
    });

    // Mark invite as accepted
    invite.status = 'accepted';
    invite.acceptedAt = new Date();
    invite.acceptedBy = userId as any;
    await invite.save();

    // Fetch the organization to return
    const organization = await Organization.findById(invite.organizationId);

    log.organization.info(
      { organizationId: invite.organizationId, userId, inviteId: invite._id },
      'Invitation accepted'
    );

    res.json({
      message: 'Invitation accepted successfully',
      organization: organization ? {
        _id: organization._id,
        name: organization.name,
        slug: organization.slug,
        image: organization.image,
      } : null,
      role: invite.role,
    });
  } catch (error) {
    log.organization.error({ err: error }, 'Error accepting invitation');
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

// Decline an invitation (by token)
router.post('/invites/:token/decline', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { token } = req.params;

    const invite = await OrganizationInvite.findOneAndUpdate(
      {
        token,
        status: 'pending',
        expiresAt: { $gt: new Date() },
      },
      { status: 'declined' },
      { returnDocument: 'after' }
    );

    if (!invite) {
      return res.status(404).json({ error: 'Invitation not found, expired, or already used' });
    }

    log.organization.info(
      { organizationId: invite.organizationId, userId, inviteId: invite._id },
      'Invitation declined'
    );

    res.json({ message: 'Invitation declined' });
  } catch (error) {
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

    // Find all organizations where user is a member
    const memberships = await OrganizationMember.find({ oxyUserId: userId });
    const orgIds = memberships.map((m) => m.organizationId);

    const organizations = await Organization.find({ _id: { $in: orgIds } })
      .sort({ createdAt: -1 });

    // Get member counts per organization
    const memberCounts = await OrganizationMember.aggregate([
      { $match: { organizationId: { $in: orgIds } } },
      { $group: { _id: '$organizationId', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(memberCounts.map((c) => [c._id.toString(), c.count]));

    // Add role and memberCount to each organization
    const orgsWithRole = organizations.map((org) => {
      const membership = memberships.find((m) => m.organizationId.toString() === org._id.toString());
      return {
        ...org.toObject(),
        role: membership?.role,
        memberCount: countMap.get(org._id.toString()) || 0,
      };
    });

    res.json({ organizations: orgsWithRole });
  } catch (error) {
    log.organization.error({ err: error }, 'Error fetching organizations');
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
});

// Get a single organization by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Check if user is a member
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
    });

    if (!membership) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const organization = await Organization.findById(id);

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Fetch members with populated user data
    const members = await OrganizationMember.find({ organizationId: id })
      .populate('oxyUserId', 'email username name image')
      .sort({ createdAt: -1 });

    res.json({
      organization: {
        ...organization.toObject(),
        role: membership.role,
        members: members.map((m) => ({
          _id: m._id,
          oxyUserId: m.oxyUserId,
          role: m.role,
          permissions: m.permissions,
          createdAt: m.createdAt,
        })),
      },
    });
  } catch (error) {
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

    // Check if slug is already taken
    const existing = await Organization.findOne({ slug: validatedData.slug });
    if (existing) {
      return res.status(400).json({ error: 'Organization slug already taken' });
    }

    const organization = new Organization({
      ...validatedData,
      ownerId: userId,
    });

    await organization.save();

    // Add creator as owner
    await OrganizationMember.create({
      organizationId: organization._id,
      oxyUserId: userId,
      role: 'owner',
      permissions: ['*'],
    });

    res.status(201).json({ organization });
  } catch (error) {
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
    const { id } = req.params;

    // Check if user is admin or owner
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
      role: { $in: ['owner', 'admin'] },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const validatedData = updateOrgSchema.parse(req.body);

    const organization = await Organization.findByIdAndUpdate(
      id,
      { $set: validatedData },
      { returnDocument: 'after' }
    );

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({ organization });
  } catch (error) {
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
    const { id } = req.params;

    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
      role: { $in: ['owner', 'admin'] },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined;
    if (!file) {
      return res.status(400).json({ error: 'Image file is required' });
    }

    // Delete previous image from S3 if one exists
    const existingOrg = await Organization.findById(id);
    if (existingOrg?.image) {
      await deleteFromS3(existingOrg.image);
    }

    const imageUrl = await uploadToS3(file.buffer, file.originalname, `organizations/${id}`, 'logo');

    const organization = await Organization.findByIdAndUpdate(
      id,
      { $set: { image: imageUrl } },
      { returnDocument: 'after' },
    );

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({ image: imageUrl });
  } catch (error) {
    log.organization.error({ err: error }, 'Error uploading organization image');
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Delete an organization
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Only owner can delete
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
      role: 'owner',
    });

    if (!membership) {
      return res.status(403).json({ error: 'Only owner can delete organization' });
    }

    await Organization.findByIdAndDelete(id);
    await OrganizationMember.deleteMany({ organizationId: id });

    res.json({ message: 'Organization deleted successfully' });
  } catch (error) {
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
    const { id } = req.params;

    // Check if user is a member
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
    });

    if (!membership) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const members = await OrganizationMember.find({ organizationId: id })
      .populate('oxyUserId', 'email username name image')
      .sort({ createdAt: -1 });

    res.json({ members });
  } catch (error) {
    log.organization.error({ err: error }, 'Error fetching members');
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Invite member to organization
const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']),
});

const INVITE_EXPIRY_DAYS = 7;

router.post('/:id/members', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Check if user is admin or owner
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
      role: { $in: ['owner', 'admin'] },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { email, role } = inviteMemberSchema.parse(req.body);

    // Verify the organization exists
    const organization = await Organization.findById(id);
    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    // Check if user with this email is already a member (search Oxy profiles)
    try {
      const searchResult = await oxyClient.searchProfiles(email);
      const profiles = (searchResult as any)?.users || (searchResult as any)?.profiles || [];
      const matchedUser = profiles.find((p: any) =>
        p.email?.toLowerCase() === email.toLowerCase()
      );

      if (matchedUser) {
        const existingMember = await OrganizationMember.findOne({
          organizationId: id,
          oxyUserId: matchedUser._id || matchedUser.id,
        });

        if (existingMember) {
          return res.status(400).json({ error: 'User is already a member of this organization' });
        }
      }
    } catch {
      // Oxy profile search is best-effort; continue with the invite
    }

    // Check for existing pending invite for this email + org
    const existingInvite = await OrganizationInvite.findOne({
      organizationId: id,
      email: email.toLowerCase(),
      status: 'pending',
      expiresAt: { $gt: new Date() },
    });

    if (existingInvite) {
      return res.status(400).json({
        error: 'A pending invitation already exists for this email',
        invite: {
          _id: existingInvite._id,
          email: existingInvite.email,
          role: existingInvite.role,
          expiresAt: existingInvite.expiresAt,
        },
      });
    }

    // Generate secure invite token
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // Create the invite record
    const invite = await OrganizationInvite.create({
      organizationId: id,
      email: email.toLowerCase(),
      role,
      token,
      invitedBy: userId,
      status: 'pending',
      expiresAt,
    });

    // Get inviter name for the email
    let inviterName = 'A team member';
    try {
      const inviterUser = await oxyClient.getUserById(userId);
      inviterName = inviterUser?.name?.full || inviterUser?.name?.first || inviterUser?.username || 'A team member';
    } catch {
      // Use default name
    }

    // Build accept URL
    const appUrl = process.env.APP_URL || process.env.WEB_URL || 'http://localhost:3000';
    const acceptUrl = `${appUrl}/invite/${token}`;

    // Send the invitation email
    const emailSent = await sendEmail({
      to: email,
      subject: `You've been invited to join ${organization.name} on Alia`,
      html: buildInviteEmailHtml({
        organizationName: organization.name,
        inviterName,
        role,
        acceptUrl,
      }),
      text: `${inviterName} has invited you to join ${organization.name} as a ${role} on Alia. Accept the invitation: ${acceptUrl}`,
    });

    log.organization.info(
      { organizationId: id, email, role, emailSent, inviteId: invite._id },
      'Organization invitation created'
    );

    res.status(201).json({
      invite: {
        _id: invite._id,
        email: invite.email,
        role: invite.role,
        status: invite.status,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
      },
      emailSent,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.organization.error({ err: error }, 'Error inviting member');
    res.status(500).json({ error: 'Failed to invite member' });
  }
});

// List pending invitations for an organization
router.get('/:id/invites', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Check if user is admin or owner
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
      role: { $in: ['owner', 'admin'] },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const invites = await OrganizationInvite.find({
      organizationId: id,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    res.json({ invites });
  } catch (error) {
    log.organization.error({ err: error }, 'Error fetching invitations');
    res.status(500).json({ error: 'Failed to fetch invitations' });
  }
});

// Revoke (cancel) a pending invitation
router.delete('/:id/invites/:inviteId', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id, inviteId } = req.params;

    // Check if user is admin or owner
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
      role: { $in: ['owner', 'admin'] },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const invite = await OrganizationInvite.findOneAndUpdate(
      {
        _id: inviteId,
        organizationId: id,
        status: 'pending',
      },
      { status: 'expired' },
      { returnDocument: 'after' }
    );

    if (!invite) {
      return res.status(404).json({ error: 'Invitation not found or already processed' });
    }

    log.organization.info({ inviteId, organizationId: id }, 'Invitation revoked');
    res.json({ message: 'Invitation revoked successfully' });
  } catch (error) {
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
    const { id, memberId } = req.params;

    // Check if user is owner (only owners can change roles)
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
      role: 'owner',
    });

    if (!membership) {
      return res.status(403).json({ error: 'Only owner can change member roles' });
    }

    const { role } = updateMemberSchema.parse(req.body);

    const member = await OrganizationMember.findByIdAndUpdate(
      memberId,
      { role },
      { returnDocument: 'after' }
    );

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json({ member });
  } catch (error) {
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
    const { id, memberId } = req.params;

    // Check if user is admin or owner
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
      role: { $in: ['owner', 'admin'] },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const memberToRemove = await OrganizationMember.findById(memberId);

    if (!memberToRemove) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Cannot remove owner
    if (memberToRemove.role === 'owner') {
      return res.status(400).json({ error: 'Cannot remove organization owner' });
    }

    await OrganizationMember.findByIdAndDelete(memberId);

    res.json({ message: 'Member removed successfully' });
  } catch (error) {
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
    const { id } = req.params;
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }

    // Check if user is admin or owner
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
      role: { $in: ['owner', 'admin'] },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Verify agent exists
    const agent = await Agent.findById(agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Upsert to avoid duplicates
    await OrganizationAgent.findOneAndUpdate(
      { organizationId: id, agentId },
      { $setOnInsert: { addedBy: userId } },
      { upsert: true, returnDocument: 'after' },
    );

    res.json({ added: true });
  } catch (error) {
    log.organization.error({ err: error }, 'Error adding agent to organization');
    res.status(500).json({ error: 'Failed to add agent' });
  }
});

// List agents in an organization
router.get('/:id/agents', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Check if user is a member
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
    });

    if (!membership) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const orgAgents = await OrganizationAgent.find({ organizationId: id })
      .populate('agentId')
      .sort({ createdAt: -1 });

    const agents = orgAgents
      .filter(oa => oa.agentId != null)
      .map(oa => oa.agentId);

    res.json({ agents });
  } catch (error) {
    log.organization.error({ err: error }, 'Error fetching organization agents');
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// Remove an agent from an organization
router.delete('/:id/agents/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id, agentId } = req.params;

    // Check if user is admin or owner
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      oxyUserId: userId,
      role: { $in: ['owner', 'admin'] },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const result = await OrganizationAgent.deleteOne({ organizationId: id, agentId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Agent not found in organization' });
    }

    res.json({ removed: true });
  } catch (error) {
    log.organization.error({ err: error }, 'Error removing agent from organization');
    res.status(500).json({ error: 'Failed to remove agent' });
  }
});

export default router;
