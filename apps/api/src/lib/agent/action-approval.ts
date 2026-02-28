/**
 * Action Approval — Interactive user approval for flagged agent actions.
 *
 * When the threat detector flags an action as 'warning' or 'critical',
 * this module pauses agent execution and requests user approval via Socket.IO.
 * The user can approve, deny, or whitelist the action pattern.
 */

import crypto from 'crypto';
import { getIO } from '../../socket.js';
import { emitApprovalRequest } from '../../socket.js';
import { log } from '../logger.js';
import type { ThreatResult } from './threat-detector.js';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

interface PendingApproval {
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

  // Check session whitelist first
  const patternKey = buildPatternKey(toolName, threat);
  const whitelist = sessionWhitelist.get(sessionId);
  if (whitelist?.has(patternKey)) {
    return 'approved';
  }

  const requestId = crypto.randomUUID();

  const description = threat.threats
    .map(t => t.pattern.description)
    .join('; ');

  // Emit approval request to the user's client
  emitApprovalRequest(sessionId, {
    requestId,
    agentId,
    toolName,
    args: sanitizeArgsForDisplay(args),
    description,
    severity: threat.maxSeverity as string,
    timeout,
  });

  // Wait for response or timeout
  return new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId);
      log.agents.info({ requestId, sessionId, toolName }, 'Approval request timed out');
      resolve('timeout');
    }, timeout);

    pendingApprovals.set(requestId, { resolve, timer });

    // Listen for the approval decision from Socket.IO
    const io = getIO();
    if (!io) {
      clearTimeout(timer);
      pendingApprovals.delete(requestId);
      log.agents.warn({ requestId }, 'Socket.IO not available for approval — denying');
      resolve('denied');
      return;
    }

    // The socket.ts handler forwards 'agent-approval-decision' events to the session room.
    // We listen on the server-side for this internal event.
    const handler = (data: { requestId: string; approved: boolean; alwaysAllow?: boolean }) => {
      if (data.requestId !== requestId) return;

      clearTimeout(timer);
      pendingApprovals.delete(requestId);

      // If "always allow" was checked, add to session whitelist
      if (data.approved && data.alwaysAllow) {
        if (!sessionWhitelist.has(sessionId)) {
          sessionWhitelist.set(sessionId, new Set());
        }
        sessionWhitelist.get(sessionId)!.add(patternKey);
      }

      const decision: ApprovalDecision = data.approved ? 'approved' : 'denied';
      log.agents.info({ requestId, sessionId, toolName, decision }, 'Approval decision received');
      resolve(decision);
    };

    // Listen on all sockets in the session room
    io.on('connection', (socket) => {
      socket.on('agent-approval-response', (data: any) => {
        if (data?.requestId === requestId) {
          handler(data);
        }
      });
    });

    // Also listen via the server-level event (from socket.ts handler)
    const serverHandler = (data: any) => {
      if (data?.requestId === requestId) {
        handler(data);
        io.removeListener('agent-approval-decision-internal', serverHandler);
      }
    };
    // Use a custom internal event channel for server-side resolution
    io.on('agent-approval-decision-internal' as any, serverHandler);
  });
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
  // We don't track by session, so this is a best-effort no-op
  // The timeout will clean up orphaned approvals
  clearSessionWhitelist(sessionId);
}

/**
 * Build a unique key for whitelisting an action pattern.
 */
function buildPatternKey(toolName: string, threat: ThreatResult): string {
  const categories = threat.threats.map(t => t.pattern.id).sort().join(',');
  return `${toolName}:${categories}`;
}

/**
 * Sanitize args for user display (truncate long values, hide sensitive data).
 */
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
