/**
 * Reviewed actions: a payment or a deletion, by Alia or by an agent, that
 * happens only after the person it is for approves that exact action.
 *
 * The policy and the hash live in `action-proposal.ts`; this is the service
 * around them, after CopilotKit/openmuse's `ActionService` (MIT; the design,
 * not its code):
 *
 *  1. **Prepare.** An Oxy tool whose catalog declares a payment or a deletion
 *     does not run; it calls the turn's gate ({@link oxyApprovalGate}), which
 *     files a `direct` row hashed over actor, identity, tool and version,
 *     canonical input and resource, and tells the person where they are:
 *     the chat they are in, the task's own conversation, the agent's thread.
 *     The model is told it is waiting. It has no tool that approves.
 *  2. **Decide.** Only the person the action is for, with a live session
 *     ({@link decideReviewedAction}); the hash they saw must still be the
 *     row's, and an expired request cannot be approved.
 *  3. **Re-bind.** The binding is re-derived NOW — the agent still the
 *     decider's, its bot the same account, its level still reaching that
 *     resource with that tool, the tool at the same catalog version — and
 *     the hash recomputed from those live values. Any difference cancels the
 *     approval: it was given for something that no longer exists.
 *  4. **Claim, then run, once.** `approved` → `executing` is one conditional
 *     UPDATE; only its winner calls the app, as a `direct_request` with the
 *     decider's bearer and the approval's id as idempotency key. It ends
 *     `succeeded`, `failed` or `outcome_unknown` (sent, no answer); a row a
 *     restart left `executing` is made `outcome_unknown` by the sweep
 *     ({@link reapStuckReviewedActions}). No state leads back to `approved`.
 *
 * A runtime tool's approval (an agent's browser typing in the background, a
 * connector) is the `rerun` kind and is performed by a new run of the agent
 * (`deferred-approvals.ts`); the decision only starts that run.
 */

import { randomUUID } from 'node:crypto';
import type { ActorRef, ResourceRef } from '@oxy.so/contracts';
import { getDb } from '../../db/index.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import {
  cancelApprovedAction,
  claimApprovalExecution,
  createAgentApprovalRequest,
  decideAgentApproval,
  findAgentApproval,
  finishApprovalExecution,
  markStuckApprovalExecutions,
  type AgentApprovalRow,
} from '../../db/agents/agentRuntimeRepository.js';
import { getIO } from '../../socket.js';
import { log } from '../logger.js';
import { resolveReviewedOxyAction } from '../tools/oxy-services.js';
import { resolveApprovalDecision, sanitizeArgsForDisplay } from './action-approval.js';
import {
  canonicalJson,
  proposalHash,
  type IdentityMode,
  type OxyActionProposal,
  type OxyApprovalGate,
  type ProposalActor,
  type ReviewKind,
} from './action-proposal.js';
import { postAgentMessage } from './agent-outreach.js';
import {
  ensureAliaTaskConversation,
  postAliaConversationMessage,
  postAliaMessage,
} from './alia-outreach.js';
import { RERUN_APPROVAL_USABLE_FOR_MS, runApprovedAction } from './deferred-approvals.js';

/** How long a person has to answer a reviewed action. */
export const REVIEW_TTL_MS = 24 * 60 * 60 * 1000;

/** A `direct` approval runs in the decision request itself; this is only slack. */
const DIRECT_APPROVAL_USABLE_FOR_MS = 5 * 60_000;

/**
 * Longer than any one tool call (Oxy's 15s, a sandboxed command's few
 * minutes): a row still `executing` after this has lost its executor.
 */
export const STUCK_EXECUTION_MS = 15 * 60_000;

const KIND_LABEL: Record<ReviewKind, string> = { payment: 'Payment', deletion: 'Deletion' };

/** Where the person hears about a request, by surface. */
export type ReviewDelivery =
  /** They are in this chat: the card appears in it; nothing is posted. */
  | { readonly kind: 'present'; readonly conversationId: string | null }
  /** An Alia task: its own conversation, with a notification. */
  | {
      readonly kind: 'alia_task';
      readonly automationId: string;
      readonly objective: string;
      readonly conversationId: string | null;
    }
  /** An agent's background run: a message in its thread with the person. */
  | { readonly kind: 'agent_thread'; readonly threadId: string | null };

export interface ReviewGateTarget {
  /** The person the action is for, and the only one who can decide it. */
  readonly oxyUserId: string;
  readonly actor: ProposalActor;
  /** The turn or run filing it: one row per (turn, exact action). */
  readonly turnId: string;
  readonly delivery: ReviewDelivery;
}

function emitApprovalsChanged(oxyUserId: string): void {
  getIO()?.to(`user:${oxyUserId}`).emit('approvals:changed', { eventVersion: 1 });
}

function summaryOf(proposal: OxyActionProposal): string {
  const display = sanitizeArgsForDisplay(proposal.args);
  return `${KIND_LABEL[proposal.kind]} · ${proposal.appId} ${proposal.tool} ${JSON.stringify(display).slice(0, 300)}`;
}

/** The turn's gate: files a reviewed action and tells the person where. */
export function oxyApprovalGate(target: ReviewGateTarget): OxyApprovalGate {
  return {
    async propose(proposal) {
      const actionHash = proposalHash({
        actor: target.actor,
        identity: proposal.identity,
        tool: { appId: proposal.appId, name: proposal.tool, version: proposal.toolVersion },
        input: proposal.args,
        resource: proposal.resource,
      });
      const conversationId =
        target.delivery.kind === 'present'
          ? target.delivery.conversationId
          : target.delivery.kind === 'alia_task'
            ? await ensureAliaTaskConversation({
                oxyUserId: target.oxyUserId,
                automationId: target.delivery.automationId,
                objective: target.delivery.objective,
                conversationId: target.delivery.conversationId,
              })
            : null;
      const summary = summaryOf(proposal);
      const id = randomUUID();
      const row = await createAgentApprovalRequest(getDb(), {
        id,
        turnId: target.turnId,
        threadId: target.delivery.kind === 'agent_thread' ? target.delivery.threadId : null,
        oxyUserId: target.oxyUserId,
        actorType: target.actor.type,
        agentId: target.actor.type === 'agent' ? target.actor.agentId : null,
        conversationId,
        identityMode: proposal.identity,
        executionMode: 'direct',
        toolName: proposal.toolName,
        riskLevel: 'R2',
        actionHash,
        resource: canonicalJson(proposal.resource),
        summary,
        details: {
          kind: proposal.kind,
          appId: proposal.appId,
          tool: proposal.tool,
          toolVersion: proposal.toolVersion,
          args: proposal.args,
          display: sanitizeArgsForDisplay(proposal.args),
        },
        expiresAt: new Date(Date.now() + REVIEW_TTL_MS),
      });
      // Told once: a repeat of the same call in this turn finds the row it
      // already filed (same turn, same hash) rather than a new one.
      if (row.id === id) {
        await tellAboutRequest(target, summary).catch((err: unknown) =>
          log.agents.warn({ err, approvalId: id }, 'Could not tell the person about a review'),
        );
        emitApprovalsChanged(target.oxyUserId);
      }
      const where =
        target.delivery.kind === 'present'
          ? 'An approval card is shown to them in this conversation'
          : 'They have been asked in their Alia conversation';
      return `Not done yet: this is a ${proposal.kind}, which only happens after the person explicitly approves it. ${where}; it will be carried out once, exactly as prepared, only if they approve, and the result will be posted in the conversation. Do NOT call it again and do not say it is done; tell them it is waiting for their approval.`;
    },
  };
}

async function tellAboutRequest(target: ReviewGateTarget, summary: string): Promise<void> {
  const content = `I need your OK before I do this: ${summary}\n\nApprove or deny it in Alia; nothing happens until you do.`;
  switch (target.delivery.kind) {
    case 'present':
      return;
    case 'alia_task':
      await postAliaMessage({
        oxyUserId: target.oxyUserId,
        automationId: target.delivery.automationId,
        objective: target.delivery.objective,
        conversationId: target.delivery.conversationId,
        content,
      });
      return;
    case 'agent_thread':
      if (target.actor.type !== 'agent') return;
      await postAgentMessage({
        oxyUserId: target.oxyUserId,
        agentId: target.actor.agentId,
        kind: 'result',
        content,
        title: 'Needs your approval',
      });
  }
}

/** What happened, written where the request was seen. */
async function tellOutcome(row: AgentApprovalRow, content: string): Promise<void> {
  try {
    if (row.actorType === 'agent' && row.agentId) {
      await postAgentMessage({
        oxyUserId: row.oxyUserId,
        agentId: row.agentId,
        kind: 'result',
        content,
        title: 'Approved action',
      });
    } else if (row.conversationId) {
      await postAliaConversationMessage({
        oxyUserId: row.oxyUserId,
        conversationId: row.conversationId,
        content,
      });
    }
  } catch (err: unknown) {
    log.agents.warn({ err, approvalId: row.id }, 'Could not tell the person how a review ended');
  }
}

interface DirectDetails {
  kind: ReviewKind;
  appId: string;
  tool: string;
  args: Record<string, unknown>;
}

function directDetails(row: AgentApprovalRow): DirectDetails | null {
  const details = row.details as Partial<DirectDetails>;
  if (
    typeof details.appId !== 'string' ||
    typeof details.tool !== 'string' ||
    (details.kind !== 'payment' && details.kind !== 'deletion') ||
    typeof details.args !== 'object' ||
    details.args === null
  )
    return null;
  return { kind: details.kind, appId: details.appId, tool: details.tool, args: details.args };
}

function parseResource(raw: string | null): ResourceRef | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ResourceRef>;
    return typeof value.appId === 'string' &&
      typeof value.effectiveAccountId === 'string' &&
      typeof value.resourceType === 'string' &&
      typeof value.resourceId === 'string'
      ? (value as ResourceRef)
      : null;
  } catch {
    return null;
  }
}

export type ReviewExecution =
  | { readonly status: 'succeeded' | 'failed' | 'outcome_unknown'; readonly reason?: string }
  | { readonly status: 'cancelled'; readonly reason: string }
  /** Somebody else holds or held the claim; this call ran nothing. */
  | { readonly status: 'not_claimed'; readonly current: string };

/** Cancel an approval that can no longer run as approved, and say so. */
async function refuse(row: AgentApprovalRow, reason: string): Promise<ReviewExecution> {
  await cancelApprovedAction(getDb(), { approvalId: row.id, outcome: { reason } });
  await tellOutcome(
    row,
    `I did not do it: ${row.summary}\n\nWhat you approved no longer matches (${reason.replace(/_/g, ' ')}). Ask again if you still want it.`,
  );
  return { status: 'cancelled', reason };
}

/**
 * Perform one approved `direct` action, as the decider, at most once.
 * Exported for the tests; the route reaches it through {@link decideReviewedAction}.
 */
export async function executeReviewedAction(
  row: AgentApprovalRow,
  decider: { accountId: string; accessToken: string },
): Promise<ReviewExecution> {
  if (row.oxyUserId !== decider.accountId) return refuse(row, 'not_the_person');
  const details = directDetails(row);
  const resource = parseResource(row.resource);
  const identity = row.identityMode as IdentityMode | null;
  if (!details || !resource || (identity !== 'for_user' && identity !== 'self'))
    return refuse(row, 'malformed');

  // The actor as it stands NOW. An agent no longer the decider's, or whose
  // bot changed, is not the actor that was approved.
  let actorRef: ActorRef;
  let actor: ProposalActor;
  if (row.actorType === 'agent') {
    const agent = row.agentId ? await findAgentById(getDb(), row.agentId) : null;
    if (!agent || agent.ownerOxyAccountId !== decider.accountId)
      return refuse(row, 'binding_changed');
    actorRef = { type: 'agent', accountId: agent.oxyAccountId };
    actor = { type: 'agent', agentId: agent._id, accountId: agent.oxyAccountId };
  } else {
    actorRef = { type: 'alia', ownerAccountId: decider.accountId };
    actor = { type: 'alia' };
  }

  const resolved = await resolveReviewedOxyAction({
    appId: details.appId,
    tool: details.tool,
    resource,
    identity,
    args: details.args,
    actor: actorRef,
    deciderAccountId: decider.accountId,
    userAccessToken: decider.accessToken,
    operationId: row.id,
  });
  if (!resolved.ok) return refuse(row, resolved.reason);

  // The hash from LIVE values: the actor's current account, the catalog's
  // current version, and the stored input and resource. A row edited after
  // the person saw it, or a bot or tool that changed since, fails here.
  const live = proposalHash({
    actor,
    identity,
    tool: { appId: details.appId, name: details.tool, version: resolved.toolVersion },
    input: details.args,
    resource,
  });
  if (live !== row.actionHash) return refuse(row, 'binding_changed');

  const claimed = await claimApprovalExecution(getDb(), {
    approvalId: row.id,
    turnId: `decision:${row.id}`,
  });
  if (!claimed) {
    const current = await findAgentApproval(getDb(), row.id);
    return { status: 'not_claimed', current: current?.status ?? 'unknown' };
  }

  const outcome = await resolved.execute();
  const recorded =
    outcome.status === 'succeeded'
      ? { resultPreview: JSON.stringify(outcome.result ?? null).slice(0, 500) }
      : { reason: outcome.reason };
  await finishApprovalExecution(getDb(), {
    approvalId: row.id,
    status: outcome.status,
    outcome: recorded,
  }).catch((err: unknown) =>
    log.agents.error(
      { err, approvalId: row.id },
      'Could not record how an approved action ended; the sweep will mark it unknown',
    ),
  );
  await tellOutcome(
    row,
    outcome.status === 'succeeded'
      ? `Done, as you approved: ${row.summary}`
      : outcome.status === 'failed'
        ? `It did not happen: ${row.summary}\n\nThe app refused or failed (${outcome.reason}). Nothing was changed.`
        : `I could not confirm whether this happened: ${row.summary}\n\nThe app did not answer. Check before asking for it again; I will not repeat it.`,
  );
  emitApprovalsChanged(row.oxyUserId);
  return outcome.status === 'succeeded'
    ? { status: 'succeeded' }
    : { status: outcome.status, reason: outcome.reason };
}

export type ReviewDecision =
  | { readonly kind: 'not_found' }
  /** The hash the person saw is not the row's: they must look again. */
  | { readonly kind: 'changed' }
  /** Approving a `direct` action needs the person's own live session. */
  | { readonly kind: 'needs_session' }
  | {
      readonly kind: 'decided';
      readonly status: string;
      readonly sessionId?: string;
      readonly execution?: ReviewExecution;
    };

/**
 * The person's answer to one request. Only the person the action is for may
 * give it (`oxy_user_id`), only once (`pending` → …), only before it expires.
 */
export async function decideReviewedAction(input: {
  approvalId: string;
  deciderAccountId: string;
  approved: boolean;
  /** The `hash` the screen showed; when given it must still match. */
  hash?: string;
  accessToken?: string;
}): Promise<ReviewDecision> {
  const row = await findAgentApproval(getDb(), input.approvalId);
  if (!row || row.oxyUserId !== input.deciderAccountId) return { kind: 'not_found' };
  if (input.hash !== undefined && input.hash !== row.actionHash) return { kind: 'changed' };
  const direct = row.executionMode === 'direct';
  if (direct && input.approved && !input.accessToken) return { kind: 'needs_session' };

  const decided = await decideAgentApproval(getDb(), {
    approvalId: input.approvalId,
    oxyUserId: input.deciderAccountId,
    approved: input.approved,
    usableUntil: new Date(
      Date.now() + (direct ? DIRECT_APPROVAL_USABLE_FOR_MS : RERUN_APPROVAL_USABLE_FOR_MS),
    ),
  });
  // Already answered, expired, or never existed: one answer for all.
  if (!decided) return { kind: 'not_found' };
  emitApprovalsChanged(decided.oxyUserId);

  if (!direct) {
    // An interactive run still waiting in this process takes the answer
    // itself; a background one gets a run that performs the action.
    const waiting = resolveApprovalDecision({
      requestId: input.approvalId,
      approved: input.approved,
    });
    const run =
      input.approved && !waiting ? await runApprovedAction(input.approvalId) : { started: false };
    return {
      kind: 'decided',
      status: decided.status,
      ...(run.started && 'sessionId' in run ? { sessionId: run.sessionId } : {}),
    };
  }
  if (!input.approved || !input.accessToken) return { kind: 'decided', status: decided.status };

  const execution = await executeReviewedAction(decided, {
    accountId: input.deciderAccountId,
    accessToken: input.accessToken,
  });
  const status = execution.status === 'not_claimed' ? execution.current : execution.status;
  return { kind: 'decided', status, execution };
}

/**
 * Claimed actions whose executor vanished: `outcome_unknown`, and the person
 * is told to check. Part of the agent run reaper's sweep.
 */
export async function reapStuckReviewedActions(now = new Date()): Promise<number> {
  const rows = await markStuckApprovalExecutions(
    getDb(),
    new Date(now.getTime() - STUCK_EXECUTION_MS),
    now,
  );
  for (const row of rows) {
    log.agents.warn(
      { approvalId: row.id, toolName: row.toolName },
      'Approved action outcome unknown',
    );
    await tellOutcome(
      row,
      `I could not confirm whether this happened: ${row.summary}\n\nIt was interrupted while running. Check before asking for it again; I will not repeat it.`,
    );
  }
  return rows.length;
}
