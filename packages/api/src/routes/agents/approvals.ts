import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { listPendingApprovals } from '../../db/agents/agentRuntimeRepository.js';
import { decideReviewedAction } from '../../lib/agent/action-review.js';
import { authenticateToken } from '../../middleware/auth.js';
import type { NextFunction, Request, Response } from 'express';

/**
 * The person's side of every approval request — Alia's and agents'.
 *
 * A turn files a request and moves on (`action-review.ts` for a payment or a
 * deletion in an Oxy app, `deferred-approvals.ts` for an agent's runtime
 * tool), so the answer arrives here, from a card in the conversation or a
 * notification, possibly much later. Only the person the action is for can
 * answer, and only from their own session: a service acting for them cannot.
 * Approving an Oxy action performs it here, once, with that person's bearer;
 * approving a runtime action starts the agent run that performs it.
 */
const router = Router();
const route =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };

router.get(
  '/approvals',
  authenticateToken,
  route(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    const rows = await listPendingApprovals(getDb(), req.user.id);
    res.json({
      approvals: rows.map((row) => ({
        id: row.id,
        actorType: row.actorType,
        agentId: row.agentId,
        conversationId: row.conversationId,
        kind: (row.details as { kind?: unknown }).kind ?? null,
        // What the screen echoes back with its decision: the exact action seen.
        hash: row.actionHash,
        toolName: row.toolName,
        summary: row.summary,
        details: (row.details as { display?: unknown }).display ?? row.details,
        riskLevel: row.riskLevel,
        threadId: row.threadId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      })),
    });
  }),
);

router.post(
  '/approvals/:approvalId/decision',
  authenticateToken,
  route(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    if (typeof req.body?.approved !== 'boolean')
      return res.status(400).json({ error: '`approved` must be a boolean' });
    if (req.body.hash !== undefined && typeof req.body.hash !== 'string')
      return res.status(400).json({ error: '`hash` must be a string' });
    // A delegated service may read the list; it never answers for the person.
    if (req.serviceApp) return res.status(403).json({ error: 'Only the person can decide' });
    const decision = await decideReviewedAction({
      approvalId: String(req.params.approvalId),
      deciderAccountId: req.user.id,
      approved: req.body.approved,
      ...(typeof req.body.hash === 'string' ? { hash: req.body.hash } : {}),
      ...(req.accessToken ? { accessToken: req.accessToken } : {}),
    });
    switch (decision.kind) {
      // Not the caller's, already answered, expired, or never existed.
      case 'not_found':
        return res.status(404).json({ error: 'No pending approval with that id' });
      case 'changed':
        return res
          .status(409)
          .json({ error: 'This request changed. Open its latest version before deciding.' });
      case 'needs_session':
        return res.status(403).json({ error: 'Approve it from your own Alia session' });
      case 'decided':
        return res.json({
          status: decision.status,
          ...(decision.sessionId ? { sessionId: decision.sessionId } : {}),
        });
    }
  }),
);

export default router;
