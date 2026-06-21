/**
 * Action Approval — Interactive user approval for flagged agent actions.
 *
 * Threat-detected actions can pause execution until user decision.
 * This module owns the pending-approval registry and resolves decisions
 * received via Socket.IO.
 */

import crypto from 'crypto';
import { emitApprovalRequest, emitApprovalResult } from '../../socket.js';
import { log } from '../logger.js';
import type { ThreatResult } from './threat-detector.js';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

interface PendingApproval {
  sessionId: string;
  patternKey: string;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
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
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId);
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
    });
  });
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
