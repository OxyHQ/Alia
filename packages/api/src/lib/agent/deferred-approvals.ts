import { reserveBackgroundProductCredits } from '../product-credit-access';
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
 * policy lets it through because a granted, unclaimed approval matches its
 * hash. Granted once, run once: the run CLAIMS it (`approved` → `executing`,
 * one conditional UPDATE) before the call and records how the call ended
 * (`succeeded`, or `outcome_unknown` if it threw); one the run never finished
 * recording is marked `outcome_unknown` by the sweep and never run again.
 *
 * Only for tools that act through the agent's own runtime (its browser, its
 * computer, a connector). An Oxy app tool never comes here: Oxy authorizes it
 * per call, and its payments and deletions are reviewed and performed by the
 * decision itself (`action-review.ts`).
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/index.js';
import {
  claimApprovalExecution,
  createAgentApprovalRequest,
  findAgentApproval,
  findClaimedApprovalInTurn,
  findGrantedApproval,
  finishApprovalExecution,
} from '../../db/agents/agentRuntimeRepository.js';
import {
  createAgentSession,
  updateAgentSession,
  type AgentSessionRecord,
} from '../../db/agents/agentSessionRepository.js';
import { safeRefund } from '../credits-manager.js';
import { log } from '../logger.js';
import { enqueueAgentSession } from '../task-queue.js';
import { getOrCreateUserCredits } from '../user-credits-helpers.js';
import { sanitizeArgsForDisplay } from './action-approval.js';
import { proposalHash } from './action-proposal.js';
import { postAgentMessage } from './agent-outreach.js';

/** How long a person has to answer. */
const DEFERRED_APPROVAL_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** How long an approval stays claimable by the run started for it. */
export const RERUN_APPROVAL_USABLE_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * The identity of one action by one agent for one person: the same call
 * hashes the same, and the same call by another agent, or for another person,
 * does not. A runtime tool acts through the agent's own runtime, so its
 * identity is `self` unless it reaches the person's account by name.
 */
export function deferredActionHash(
  agentId: string,
  oxyUserId: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  return proposalHash({
    actor: { type: 'agent', agentId },
    identity: toolName.startsWith('oxy_') ? 'for_user' : 'self',
    tool: { name: toolName },
    input: args,
    resource: { person: oxyUserId },
  });
}

/** An approval this run claimed; it records how the call ended, once. */
export interface ClaimedApproval {
  readonly state: 'claimed';
  finish(
    status: 'succeeded' | 'failed' | 'outcome_unknown',
    outcome: Record<string, unknown>,
  ): Promise<void>;
}

export type GrantLookup =
  | ClaimedApproval
  | { readonly state: 'none' }
  | { readonly state: 'already_done' };

export interface DeferredApprovals {
  /**
   * Claim a granted approval for exactly this call, if there is one. A call
   * this run ALREADY performed under an approval is `already_done`: one "yes"
   * covers one action, even within the run started for it.
   */
  granted(toolName: string, args: Record<string, unknown>): Promise<GrantLookup>;
  /** File a request and tell the person; returns what the model is told. */
  request(toolName: string, args: Record<string, unknown>, reason: string): Promise<string>;
}

export function deferredApprovalsFor(session: AgentSessionRecord): DeferredApprovals {
  return {
    async granted(toolName, args) {
      const actionHash = deferredActionHash(session.agentId, session.oxyUserId, toolName, args);
      if (await findClaimedApprovalInTurn(getDb(), { turnId: session._id, actionHash }))
        return { state: 'already_done' };
      const grant = await findGrantedApproval(getDb(), {
        oxyUserId: session.oxyUserId,
        actionHash,
      });
      if (!grant) return { state: 'none' };
      const claimed = await claimApprovalExecution(getDb(), {
        approvalId: grant.id,
        turnId: session._id,
      });
      // Another run got it first: this one must not run it too.
      if (!claimed) return { state: 'already_done' };
      return {
        state: 'claimed',
        async finish(status, outcome) {
          await finishApprovalExecution(getDb(), { approvalId: claimed.id, status, outcome }).catch(
            (err: unknown) =>
              log.agents.warn(
                { err, approvalId: claimed.id },
                'Could not record how an approved action ended; the reaper will mark it unknown',
              ),
          );
        },
      };
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
        actorType: 'agent',
        agentId: session.agentId,
        executionMode: 'rerun',
        toolName,
        riskLevel: 'R2',
        actionHash: deferredActionHash(session.agentId, session.oxyUserId, toolName, args),
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
        }).catch((err: unknown) =>
          log.agents.warn(
            { err, sessionId: session._id },
            'Could not tell the person about an approval',
          ),
        );
      }
      return "This action needs the person's approval. They have been asked, and it will be done in a new run once they approve. Do NOT call it again now; continue with anything else, or finish and say it is waiting for their approval.";
    },
  };
}

/**
 * Start the run that performs an action the person just approved.
 *
 * Only for a request filed by a background run — one whose run is no longer
 * waiting for the answer. Holds credits like any background run.
 */
export async function runApprovedAction(
  approvalId: string,
): Promise<{ started: boolean; sessionId?: string }> {
  const approval = await findAgentApproval(getDb(), approvalId);
  if (approval?.status !== 'approved' || approval.executionMode !== 'rerun' || !approval.agentId)
    return { started: false };
  const agentId = approval.agentId;
  const args = (approval.details as { args?: Record<string, unknown> }).args;
  if (!args) return { started: false };

  await getOrCreateUserCredits(approval.oxyUserId);
  const reservation = await reserveBackgroundProductCredits(approval.oxyUserId);
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
      agentId,
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
      agentId,
      agentName: `Agent ${agentId}`,
    });
    return { started: true, sessionId: session._id };
  } catch (error: unknown) {
    log.agents.error({ err: error, approvalId }, 'Could not start the run for an approved action');
    if (sessionId) {
      await updateAgentSession(getDb(), sessionId, {
        status: 'failed',
        result: 'Could not queue the approved action',
      }).catch(() => undefined);
    }
    await safeRefund(reservation, 'approved action could not be started');
    return { started: false };
  }
}
