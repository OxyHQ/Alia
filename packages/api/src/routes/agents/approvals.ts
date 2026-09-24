import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { decideAgentApproval, listPendingApprovals } from '../../db/agents/agentRuntimeRepository.js';
import { resolveApprovalDecision } from '../../lib/agent/action-approval.js';
import { runApprovedAction } from '../../lib/agent/deferred-approvals.js';
import { authenticateToken } from '../../middleware/auth.js';
import type { NextFunction, Request, Response } from 'express';

/**
 * The person's side of an agent's approval requests.
 *
 * A background run files a request and moves on (`deferred-approvals.ts`), so
 * the answer arrives here, from a screen or a notification, possibly days
 * later. Approving one the run is no longer waiting for starts the run that
 * performs it; an interactive run still waiting in this process is resolved
 * directly, as the socket path does.
 */
const router = Router();
const route = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };

router.get('/approvals', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  const rows = await listPendingApprovals(getDb(), req.user.id);
  res.json({
    approvals: rows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      toolName: row.toolName,
      summary: row.summary,
      details: (row.details as { display?: unknown }).display ?? row.details,
      riskLevel: row.riskLevel,
      threadId: row.threadId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    })),
  });
}));

router.post('/approvals/:approvalId/decision', authenticateToken, route(async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  if (typeof req.body?.approved !== 'boolean') return res.status(400).json({ error: '`approved` must be a boolean' });
  const approvalId = String(req.params.approvalId);
  const decided = await decideAgentApproval(getDb(), {
    approvalId,
    oxyUserId: req.user.id,
    approved: req.body.approved,
  });
  // Not the caller's, already answered, or never existed: one answer for all.
  if (!decided) return res.status(404).json({ error: 'No pending approval with that id' });

  const waiting = resolveApprovalDecision({ requestId: approvalId, approved: req.body.approved });
  const run = req.body.approved && !waiting ? await runApprovedAction(approvalId) : { started: false };
  res.json({ status: decided.status, ...(run.started ? { sessionId: run.sessionId } : {}) });
}));

export default router;
