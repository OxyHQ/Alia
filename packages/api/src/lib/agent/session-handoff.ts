/**
 * Handing an agent session to a worker without losing the caller's credits, and
 * reclaiming the credits of one that was never picked up.
 *
 * ## Why this is one function rather than three copies of four calls
 *
 * Hiring an agent is a fixed sequence: reserve the agent's price, write the
 * session row carrying that reservation, count the hire, enqueue the job. Three
 * call sites did it — `routes/agents/hire.ts`, `lib/agent/routing-handler.ts`
 * and the agent-escalation branch of `routes/v1/chat-completions.ts` — and all
 * three answered a failure of any step with a `log.error` and nothing else.
 *
 * `reserveCredits` DEBITS on the way in. So every one of those failures left the
 * person short by the agent's price, for an agent that never ran, with no record
 * anywhere that it had happened. Three sites, one omission, three times: that is
 * a missing primitive rather than three missing patches, and it is the same
 * reasoning that put the release of a chat turn's reservation in ONE `finally`
 * in `routes/v1/chat-completions.ts` rather than at each of its exits.
 *
 * It is also the seam the two-payer work lands on: the payer is `userId` here
 * and nowhere else in the three callers.
 *
 * ## Settlement is the WORKER's, and that is why the happy path does not refund
 *
 * A successful handoff deliberately leaves the reservation spent. `runner.ts`
 * finalizes it against real token usage when the session completes, and refunds
 * it when the session fails. A `finally` that released it here would refund
 * every hire the instant it was queued and then let the worker charge for it
 * too.
 *
 * The consequence is that a session which is queued and never runs holds a
 * reservation nobody will ever settle — which is what
 * {@link reclaimOrphanedAgentSessions} is for.
 */

import { getDb } from '../../db/index.js';
import { incrementAgentCounters } from '../../db/agents/agentRepository.js';
import {
  cancelUnsettledAgentSession,
  claimOrphanedQueuedAgentSessions,
  createAgentSession,
} from '../../db/agents/agentSessionRepository.js';
import { agentPromptName, attachAgentIdentity } from '../agent-identity.js';
import { reserveCredits, safeRefund } from '../credits-manager.js';
import { log } from '../logger.js';
import { enqueueAgentSession } from '../task-queue.js';

/**
 * What an agent costs to hire when its own row does not say.
 *
 * Was `agent.price || 15` at all three call sites, which also treats a stored
 * price of 0 as unset. Kept exactly, rather than silently repricing free agents
 * as part of a credit fix.
 */
const DEFAULT_AGENT_PRICE = 15;

/**
 * What KIND of act is spending these credits, which is what decides whether it
 * counts as a hire.
 *
 * `hire` — somebody CHOSE this agent: the marketplace hire route, and a chat
 * turn escalating to the agent its conversation is linked to. Moves both
 * counters.
 *
 * `delegation` — a `task_router` agent routed work to it on a trigger. Real
 * usage of the agent, but nobody chose it, so it moves `usageCount` ONLY.
 * `hireCount` is a marketplace reputation signal and internal traffic would
 * inflate it. It is also about to stop meaning one thing: with an agent becoming
 * an Oxy account, hiring becomes membership in an account graph rather than a
 * one-off purchase — and a counter carrying both senses at once cannot be
 * separated back out later.
 *
 * A named act rather than a `countAsHire: boolean`, because the caller knows
 * what it is doing and not which counters that implies; the mapping belongs
 * here, once, with the reason.
 */
export type AgentSessionOrigin = 'hire' | 'delegation';

/**
 * The three fields hiring an agent reads.
 *
 * `oxyAccountId` rather than `name`: an agent IS an Oxy `bot` account and has no
 * name of its own here any more. The queue entry still wants one, so this
 * function resolves it — which is also why the identity lookup lives HERE and
 * not at the three callers. They stopped knowing what a reservation is; they do
 * not get to start knowing what a display name is either.
 */
export interface HirableAgent {
  readonly _id: string;
  readonly oxyAccountId: string;
  readonly price: number | null;
}

export type AgentSessionHandoff =
  | { readonly ok: true; readonly sessionId: string; readonly queued: boolean; readonly jobId?: string }
  /**
   * `creditsNeeded` rides on the refusal so the 402 body does not need a second
   * copy of `agent.price || DEFAULT_AGENT_PRICE` — the price that was actually
   * asked for is reported by whoever asked for it.
   */
  | { readonly ok: false; readonly reason: 'insufficient_credits'; readonly creditsNeeded: number }
  | { readonly ok: false; readonly reason: 'handoff_failed' };

/**
 * Reserve, create, count and enqueue — or give the credits back.
 *
 * `insufficient_credits` is a refusal that debited nothing; `handoff_failed` is
 * a failure that has already been undone. Both are values rather than
 * exceptions because two of the three callers run inside a wider `try` that
 * would swallow a throw into a log line, which is the shape of the bug.
 */
export async function startAgentSession(input: {
  readonly agent: HirableAgent;
  readonly userId: string;
  readonly task: string;
  readonly origin: AgentSessionOrigin;
  readonly depth?: number;
}): Promise<AgentSessionHandoff> {
  const { agent, userId, task, origin } = input;
  const price = agent.price || DEFAULT_AGENT_PRICE;

  const reservation = await reserveCredits(userId, price);
  if (!reservation) {
    log.agents.info({ userId, agentId: agent._id, price }, 'Agent hire refused: insufficient credits');
    return { ok: false, reason: 'insufficient_credits', creditsNeeded: price };
  }

  let sessionId: string | null = null;
  try {
    const session = await createAgentSession(getDb(), {
      agentId: agent._id,
      oxyUserId: userId,
      task,
      status: 'queued',
      depth: input.depth ?? 0,
      creditReservation: reservation,
    });
    sessionId = session._id;

    /**
     * One statement, not a read-modify-write: two concurrent hires read the
     * same value and wrote the same value+1 before it was `$inc`.
     *
     * `hireCount` only for an act somebody chose — see {@link AgentSessionOrigin}.
     */
    await incrementAgentCounters(getDb(), agent._id, {
      ...(origin === 'hire' ? { hireCount: 1 } : {}),
      usageCount: 1,
    });

    /**
     * The queue label, resolved from the bot account.
     *
     * Inside the `try` and yet unable to widen it: `hydrateOxyUsers` FAILS OPEN
     * — it catches its own transport failure, logs it, and answers an empty map
     * — and `agentPromptName` never returns null. So an Oxy outage costs this
     * handoff a generic label, never a refund. That property is the only reason
     * an identity lookup is allowed to stand between the reservation and the
     * enqueue at all; if it could throw it would belong before `reserveCredits`.
     */
    const { queued, jobId } = await enqueueAgentSession({
      sessionId: session._id,
      userId,
      agentId: agent._id,
      agentName: agentPromptName(await attachAgentIdentity(agent)),
    });

    return { ok: true, sessionId: session._id, queued, ...(jobId === undefined ? {} : { jobId }) };
  } catch (error: unknown) {
    log.agents.error({ err: error, userId, agentId: agent._id, sessionId }, 'Agent session handoff failed');

    /**
     * The row is neutralised BEFORE the refund, and the refund happens only
     * because it was.
     *
     * A row left `queued` with a reservation on it is
     * {@link reclaimOrphanedAgentSessions}'s to give back. If this path refunded
     * first and then failed to cancel — the connection that just broke is the
     * likely reason it would — the sweep would refund the same reservation
     * again and the account would be paid twice. In this order the two are
     * mutually exclusive: whichever of them reaches the row first is the one
     * that pays.
     */
    const neutralised =
      sessionId === null
        ? true
        : await cancelUnsettledAgentSession(getDb(), sessionId, 'Handoff failed before the session started')
            .catch((cancelErr: unknown) => {
              log.agents.error({ err: cancelErr, sessionId }, 'Could not cancel a session whose handoff failed');
              return false;
            });

    if (neutralised) {
      await safeRefund(reservation, 'agent session handoff failed');
    }
    return { ok: false, reason: 'handoff_failed' };
  }
}

/**
 * Give back the credits of every session that was queued and never started.
 *
 * ## The failure it answers is not a code path
 *
 * A queued session's reservation is settled by the worker that runs it. If no
 * worker ever does — Redis dropped the job, the task was killed between the
 * enqueue and the first step, a deploy replaced the process — the row sits in
 * `queued` forever and the reservation is never settled by anybody. Nothing
 * throws, nothing is logged, and the account is simply short.
 *
 * `failOrphanedAudioJobs` answers the same event for audio generation, is
 * started from the same place, and this is deliberately its shape.
 *
 * ## `queued` only, and the cutoff is why that is not timid
 *
 * A `running` session is being driven by SOME task, and there is no owner or
 * lease column that says which — so a sweep that failed one could be stopping a
 * session another API task is halfway through, and the runner would then settle
 * a reservation this refunded. That is a real leak and it is NOT closed here;
 * closing it needs an ownership lease on the row, which is a schema change and a
 * different piece of work.
 *
 * `queued` carries no such ambiguity. A job is claimed within seconds of being
 * enqueued — and the fallback path runs it in-process immediately — so a row
 * still queued after {@link QUEUED_ORPHAN_AFTER_MS} was claimed by nothing.
 *
 * ## The UPDATE is the claim
 *
 * Every API task runs this at boot and a deploy starts several at once. A
 * SELECT followed by a refund would let two of them read the same row and refund
 * it twice. `claimOrphanedQueuedAgentSessions` moves the row out of `queued` and
 * RETURNs it in one statement, so each row is returned to exactly one caller.
 *
 * @param now Injectable so a test can place the cutoff without waiting.
 * @returns how many reservations were given back.
 */
export async function reclaimOrphanedAgentSessions(now: Date = new Date()): Promise<number> {
  const claimed = await claimOrphanedQueuedAgentSessions(getDb(), now);

  let refunded = 0;
  for (const session of claimed) {
    if (!session.creditReservation) continue;
    await safeRefund(session.creditReservation, 'agent session was never picked up');
    refunded++;
  }

  if (claimed.length > 0) {
    log.agents.warn({ stranded: claimed.length, refunded }, 'Reclaimed agent sessions that were never picked up');
  }
  return refunded;
}
