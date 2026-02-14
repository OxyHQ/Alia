import { Request, Response, NextFunction } from 'express';
import { OrganizationMember } from '../models/organization-member.js';

/**
 * Resolves the X-Workspace-Id header into req.workspace.
 * - 'personal' or missing → req.workspace = { id: null }
 * - '<orgId>' → verifies membership, sets req.workspace = { id, role }
 */
export async function resolveWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const workspaceId = req.headers['x-workspace-id'] as string | undefined;

  if (!workspaceId || workspaceId === 'personal') {
    req.workspace = { id: null };
    return next();
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const member = await OrganizationMember.findOne({
    organizationId: workspaceId,
    oxyUserId: userId,
  });

  if (!member) {
    res.status(403).json({ error: 'Not a member of this workspace' });
    return;
  }

  req.workspace = { id: workspaceId, role: member.role };
  next();
}
