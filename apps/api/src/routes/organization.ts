import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { Organization } from '../models/organization';
import { OrganizationMember } from '../models/organization-member';
import { z } from 'zod';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

// ===========================================
// ORGANIZATION ROUTES
// ===========================================

// Get all organizations for the authenticated user
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Find all organizations where user is a member
    const memberships = await OrganizationMember.find({ userId });
    const orgIds = memberships.map((m) => m.organizationId);

    const organizations = await Organization.find({ _id: { $in: orgIds } })
      .sort({ createdAt: -1 });

    // Add role to each organization
    const orgsWithRole = organizations.map((org) => {
      const membership = memberships.find((m) => m.organizationId.toString() === org._id.toString());
      return {
        ...org.toObject(),
        role: membership?.role,
      };
    });

    res.json({ organizations: orgsWithRole });
  } catch (error) {
    console.error('Error fetching organizations:', error);
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
      userId,
    });

    if (!membership) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const organization = await Organization.findById(id);

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({
      organization: {
        ...organization.toObject(),
        role: membership.role,
      },
    });
  } catch (error) {
    console.error('Error fetching organization:', error);
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
      userId,
      role: 'owner',
      permissions: ['*'],
    });

    res.status(201).json({ organization });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Error creating organization:', error);
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
      userId,
      role: { $in: ['owner', 'admin'] },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const validatedData = updateOrgSchema.parse(req.body);

    const organization = await Organization.findByIdAndUpdate(
      id,
      { $set: validatedData },
      { new: true }
    );

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    res.json({ organization });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Error updating organization:', error);
    res.status(500).json({ error: 'Failed to update organization' });
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
      userId,
      role: 'owner',
    });

    if (!membership) {
      return res.status(403).json({ error: 'Only owner can delete organization' });
    }

    await Organization.findByIdAndDelete(id);
    await OrganizationMember.deleteMany({ organizationId: id });

    res.json({ message: 'Organization deleted successfully' });
  } catch (error) {
    console.error('Error deleting organization:', error);
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
      userId,
    });

    if (!membership) {
      return res.status(403).json({ error: 'Not a member of this organization' });
    }

    const members = await OrganizationMember.find({ organizationId: id })
      .populate('userId', 'email name image')
      .sort({ createdAt: -1 });

    res.json({ members });
  } catch (error) {
    console.error('Error fetching members:', error);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Invite member to organization
const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']),
});

router.post('/:id/members', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Check if user is admin or owner
    const membership = await OrganizationMember.findOne({
      organizationId: id,
      userId,
      role: { $in: ['owner', 'admin'] },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { email, role } = inviteMemberSchema.parse(req.body);

    // TODO: Implement email invitation system
    // For now, just return a message
    res.json({
      message: 'Invitation feature coming soon',
      email,
      role,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Error inviting member:', error);
    res.status(500).json({ error: 'Failed to invite member' });
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
      userId,
      role: 'owner',
    });

    if (!membership) {
      return res.status(403).json({ error: 'Only owner can change member roles' });
    }

    const { role } = updateMemberSchema.parse(req.body);

    const member = await OrganizationMember.findByIdAndUpdate(
      memberId,
      { role },
      { new: true }
    );

    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json({ member });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    console.error('Error updating member:', error);
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
      userId,
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
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

export default router;
