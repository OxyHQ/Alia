import { AdminAudit } from '../models/admin-audit.js';
import { log } from './logger.js';
import type { Request } from 'express';

/**
 * Record an admin action. Fire-and-forget -- never blocks the request.
 */
export function recordAudit(
  req: Request,
  action: string,
  resource: string,
  resourceId?: string,
  details?: Record<string, unknown>
): void {
  const actor = req.user?.username || req.service || 'unknown';

  AdminAudit.create({
    actor,
    action,
    resource,
    resourceId,
    details,
  }).catch((err: unknown) => {
    log.admin.warn({ err, action, resource }, 'Failed to record audit log');
  });
}
