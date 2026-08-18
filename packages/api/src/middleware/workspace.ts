import { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/index.js';
import { findMemberRole } from '../db/organizations/organizationRepository.js';

/**
 * Resolves the X-Workspace-Id header into req.workspace.
 * - 'personal' or missing → req.workspace = { id: null }
 * - '<orgId>' → verifies membership, sets req.workspace = { id, role }
 *
 * The membership check is what makes the header safe to trust downstream:
 * `routes/developer.ts` turns `req.workspace.id` into the `organization_id` it
 * filters and writes by, and `developer_apps.organization_id` carries a foreign
 * key to `organizations.id`. An id that reaches this point has been proved to
 * name an organization the caller belongs to, so nothing below has to ask again.
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
    res.status(401).json({ error: 'Authentication required', code: 'MISSING_AUTH', message: 'Authentication required' });
    return;
  }

  const role = await findMemberRole(getDb(), workspaceId, userId);

  if (!role) {
    res.status(403).json({ error: 'Not a member of this workspace' });
    return;
  }

  req.workspace = { id: workspaceId, role };
  next();
}
