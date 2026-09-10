/**
 * Action Approval — Interactive user approval for flagged agent actions.
 *
 * Threat-detected actions can pause execution until user decision.
 * This module owns the pending-approval registry and resolves decisions
 * received via Socket.IO.
 */

import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { emitApprovalRequest, emitApprovalResult } from '../../socket.js';
import { getDb } from '../../db/index.js';
import { agentSessions } from '../../db/schema/agent-sessions.js';
import { agentApprovalRequests } from '../../db/schema/agent-runtime.js';
import { createAgentApprovalRequest, findAgentApproval } from '../../db/agents/agentRuntimeRepository.js';
import { log } from '../logger.js';
import type { ThreatResult } from './threat-detector.js';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

interface PendingApproval {
  sessionId: string;
  patternKey: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setInterval>;
}

/** In-memory map of pending approval requests: requestId → resolver */
const pendingApprovals = new Map<string, PendingApproval>();

/** Per-session whitelist of approved patterns: sessionId → Set<patternKey> */
const sessionWhitelist = new Map<string, Set<string>>();

/**
 * Request user approval for a flagged agent action.
 * Pauses execution until the user responds or timeout expires.
 */
export async function requestApproval(opts: {
  sessionId: string;
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  threat: ThreatResult;
  timeout?: number;
}): Promise<ApprovalDecision> {
  const { sessionId, agentId, toolName, args, threat, timeout = 60_000 } = opts;

  const patternKey = buildPatternKey(toolName, threat);
  const whitelist = sessionWhitelist.get(sessionId);
  if (whitelist?.has(patternKey)) {
    return 'approved';
  }

  const requestId = crypto.randomUUID();
  const description = threat.threats.map((t) => t.pattern.description).join('; ');
  const expiresAt = new Date(Date.now() + timeout);
  let durable = false;

  try {
    const [session] = await getDb().select({
      threadId: agentSessions.threadId,
      oxyUserId: agentSessions.oxyUserId,
    }).from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
    if (session?.threadId) {
      await createAgentApprovalRequest(getDb(), {
        id: requestId,
        turnId: sessionId,
        threadId: session.threadId,
        oxyUserId: session.oxyUserId,
        agentId,
        toolName,
        riskLevel: threat.maxSeverity === 'critical' ? 'R2' : 'R1',
        actionHash: crypto.createHash('sha256').update(JSON.stringify({ patternKey, args })).digest('hex'),
        summary: description || `${toolName} requires approval`,
        details: sanitizeArgsForDisplay(args),
        expiresAt,
      });
      durable = true;
    }
  } catch (error) {
    // Legacy sessions and isolated tests retain the real-time path. A durable
    // thread never silently loses its prompt: the failure is visible in logs.
    log.agents.warn({ err: error, requestId, sessionId }, 'Could not persist approval request');
  }

  emitApprovalRequest(sessionId, {
    eventVersion: 1,
    requestId,
    agentId,
    toolName,
    args: sanitizeArgsForDisplay(args),
    description,
    severity: threat.maxSeverity as string,
    timeout,
  });

  return new Promise<ApprovalDecision>((resolve) => {
    const poll = durable ? setInterval(() => {
      void findAgentApproval(getDb(), requestId).then((row) => {
        if (!row || row.status === 'pending') return;
        const pending = pendingApprovals.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingApprovals.delete(requestId);
        const decision: ApprovalDecision = row.status === 'approved' ? 'approved'
          : row.status === 'expired' ? 'timeout' : 'denied';
        emitApprovalResult(sessionId, { eventVersion: 1, requestId, decision });
        pending.resolve(decision);
      }).catch((error) => log.agents.warn({ err: error, requestId }, 'Approval poll failed'));
    }, 500) : undefined;
    poll?.unref?.();
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId);
      if (poll) clearInterval(poll);
      if (durable) {
        void getDb().update(agentApprovalRequests).set({ status: 'expired', updatedAt: new Date() })
          .where(eq(agentApprovalRequests.id, requestId))
          .catch((error) => log.agents.warn({ err: error, requestId }, 'Approval expiry persistence failed'));
      }
      emitApprovalResult(sessionId, {
        eventVersion: 1,
        requestId,
        decision: 'timeout',
      });
      log.agents.info({ requestId, sessionId, toolName }, 'Approval request timed out');
      resolve('timeout');
    }, timeout);

    pendingApprovals.set(requestId, {
      sessionId,
      patternKey,
      resolve,
      timer,
      ...(poll && { poll }),
    });
  });
}

/**
 * Look up the sessionId bound to a pending approval request, if any.
 * Used to authorize a Socket.IO approval-response against the request's session.
 */
export function getPendingApprovalSession(requestId: string): string | null {
  return pendingApprovals.get(requestId)?.sessionId ?? null;
}

/**
 * Resolve a pending approval from Socket.IO decision input.
 */
export function resolveApprovalDecision(data: {
  requestId: string;
  approved: boolean;
  alwaysAllow?: boolean;
}): boolean {
  const pending = pendingApprovals.get(data.requestId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  if (pending.poll) clearInterval(pending.poll);
  pendingApprovals.delete(data.requestId);

  if (data.approved && data.alwaysAllow) {
    if (!sessionWhitelist.has(pending.sessionId)) {
      sessionWhitelist.set(pending.sessionId, new Set());
    }
    sessionWhitelist.get(pending.sessionId)!.add(pending.patternKey);
  }

  const decision: ApprovalDecision = data.approved ? 'approved' : 'denied';
  emitApprovalResult(pending.sessionId, {
    eventVersion: 1,
    requestId: data.requestId,
    decision,
  });
  pending.resolve(decision);

  return true;
}

/**
 * Clean up whitelist when a session ends.
 */
export function clearSessionWhitelist(sessionId: string): void {
  sessionWhitelist.delete(sessionId);
}

/**
 * Cancel all pending approvals for a session (e.g., on cancellation).
 */
export function cancelPendingApprovals(sessionId: string): void {
  for (const [requestId, pending] of pendingApprovals.entries()) {
    if (pending.sessionId !== sessionId) continue;
    clearTimeout(pending.timer);
    if (pending.poll) clearInterval(pending.poll);
    pendingApprovals.delete(requestId);
    pending.resolve('denied');
  }
  clearSessionWhitelist(sessionId);
}

function buildPatternKey(toolName: string, threat: ThreatResult): string {
  const categories = threat.threats.map((t) => t.pattern.id).sort().join(',');
  return `${toolName}:${categories}`;
}

function sanitizeArgsForDisplay(args: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      safe[key] = value.length > 500 ? value.slice(0, 500) + '...' : value;
    } else {
      safe[key] = value;
    }
  }
  return safe;
}
