/**
 * Approvals for a run nobody is watching.
 *
 * An R2 action (sending, publishing, writing through a connector) needs the
 * person's OK. In a chat turn the person is there, so the run waits for them
 * (`action-approval.ts`). A background run used to do the same — wait 60s in
 * memory for a prompt nobody could see, then treat the silence as a denial —
 * so an autonomous agent could never send anything at all.
 *
 * Here the run does not wait. It files a durable request, tells the person in
 * its conversation with them, and carries on (or finishes). When the person
 * approves, a new run is started whose only job is that exact action, and the
 * policy lets it through because a granted, unused approval matches its hash.
 * Granted once, spent once: it moves to `executed` as it is used.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../../db/index.js';
import {
  createAgentApprovalRequest,
  findAgentApproval,
  findGrantedApproval,
  markApprovalExecuted,
} from '../../db/agents/agentRuntimeRepository.js';
import { createAgentSession, updateAgentSession, type AgentSessionRecord } from '../../db/agents/agentSessionRepository.js';
import { reserveCredits, safeRefund } from '../credits-manager.js';
import { log } from '../logger.js';
import { enqueueAgentSession } from '../task-queue.js';
import { getOrCreateUserCredits } from '../user-credits-helpers.js';
import { sanitizeArgsForDisplay } from './action-approval.js';
import { postAgentMessage } from './agent-outreach.js';

/** How long a person has to answer. */
const DEFERRED_APPROVAL_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** How long a granted approval stays usable by the run started for it. */
const GRANT_USABLE_FOR_MS = 7 * 24 * 60 * 60 * 1000;

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortJson(v)]));
}

/** The identity of one action by one agent: the same call hashes the same. */
export function deferredActionHash(agentId: string, toolName: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(sortJson(['deferred', agentId, toolName, args]))).digest('hex');
}

export interface DeferredApprovals {
  /** Spend a granted approval for exactly this call, if there is one. */
  granted(toolName: string, args: Record<string, unknown>): Promise<boolean>;
  /** File a request and tell the person; returns what the model is told. */
  request(toolName: string, args: Record<string, unknown>, reason: string): Promise<string>;
}

export function deferredApprovalsFor(session: AgentSessionRecord): DeferredApprovals {
  return {
    async granted(toolName, args) {
      const grant = await findGrantedApproval(getDb(), {
        oxyUserId: session.oxyUserId,
        agentId: session.agentId,
        actionHash: deferredActionHash(session.agentId, toolName, args),
        decidedAfter: new Date(Date.now() - GRANT_USABLE_FOR_MS),
      });
      return grant ? markApprovalExecuted(getDb(), grant.id) : false;
    },

    async request(toolName, args, reason) {
      const display = sanitizeArgsForDisplay(args);
      const summary = `${toolName} ${JSON.stringify(display).slice(0, 300)}`;
      const id = randomUUID();
      const row = await createAgentApprovalRequest(getDb(), {
        id,
        turnId: session._id,
        threadId: session.threadId,
        oxyUserId: session.oxyUserId,
        agentId: session.agentId,
        toolName,
        riskLevel: 'R2',
        actionHash: deferredActionHash(session.agentId, toolName, args),
        summary,
        // The exact arguments, so the run started on approval can repeat the
        // call the person saw; `display` is what a screen shows them.
        details: { args, display, reason },
        expiresAt: new Date(Date.now() + DEFERRED_APPROVAL_TTL_MS),
      });
      // Told once: a repeat of the same call in this run finds the row it
      // already filed (same turn, same hash) rather than a new one.
      if (row.id === id) {
        await postAgentMessage({
          oxyUserId: session.oxyUserId,
          agentId: session.agentId,
          kind: 'result',
          content: `I need your OK before I do this: ${summary}\n\nApprove or deny it in Alia; I'll do it as soon as you approve.`,
          title: 'Needs your approval',
        }).catch((err: unknown) => log.agents.warn({ err, sessionId: session._id }, 'Could not tell the person about an approval'));
      }
      return 'This action needs the person\'s approval. They have been asked, and it will be done in a new run once they approve. Do NOT call it again now; continue with anything else, or finish and say it is waiting for their approval.';
    },
  };
}

/**
 * Start the run that performs an action the person just approved.
 *
 * Only for a request filed by a background run — one whose run is no longer
 * waiting for the answer. Holds credits like any background run.
 */
export async function runApprovedAction(approvalId: string): Promise<{ started: boolean; sessionId?: string }> {
  const approval = await findAgentApproval(getDb(), approvalId);
  if (!approval || approval.status !== 'approved') return { started: false };
  const args = (approval.details as { args?: Record<string, unknown> }).args;
  if (!args) return { started: false };

  await getOrCreateUserCredits(approval.oxyUserId);
  const reservation = await reserveCredits(approval.oxyUserId);
  if (!reservation) return { started: false };

  const task = [
    `The person approved an action you asked for earlier: ${approval.summary}`,
    `Call ${approval.toolName} now, once, with exactly these arguments:`,
    JSON.stringify(args),
    'Then report what happened. Do nothing else.',
  ].join('\n');
  let sessionId: string | undefined;
  try {
    const session = await createAgentSession(getDb(), {
      agentId: approval.agentId,
      oxyUserId: approval.oxyUserId,
      task,
      status: 'queued',
      creditReservation: reservation,
      ...(approval.threadId ? { threadId: approval.threadId } : {}),
    });
    sessionId = session._id;
    await enqueueAgentSession({
      sessionId: session._id,
      userId: approval.oxyUserId,
      agentId: approval.agentId,
      agentName: `Agent ${approval.agentId}`,
    });
    return { started: true, sessionId: session._id };
  } catch (error: unknown) {
    log.agents.error({ err: error, approvalId }, 'Could not start the run for an approved action');
    if (sessionId) {
      await updateAgentSession(getDb(), sessionId, { status: 'failed', result: 'Could not queue the approved action' })
        .catch(() => undefined);
    }
    await safeRefund(reservation, 'approved action could not be started');
    return { started: false };
  }
}
