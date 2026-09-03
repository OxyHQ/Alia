/**
 * ONE agent turn, run from inside somebody else's turn — and PAID FOR.
 *
 * Two tools run an agent this way and they must not diverge: `delegateToAgent`
 * hands work to an agent found in the catalogue, and `askAgent` asks one of the
 * caller's own. What differs between them is which agent they are allowed to
 * name and how they resolve it; what happens once an agent is resolved is this
 * file, in one copy.
 *
 * ## The nested turn was FREE, and that is what this fixes
 *
 * `delegateToAgent` called `generateText` directly, with no reservation of any
 * kind. Nothing upstream covered it either: the outer turn's `tokenUsage` is
 * ASSIGNED from `onUsage` (`lib/chat/provider-loop.ts`), not accumulated, so
 * tokens spent inside a tool never reach `finalizeCredits`. One credit of
 * reservation bought up to {@link AGENT_MAX_STEPS} steps of hosted inference
 * per call, and a model may call the tool more than once in a turn.
 *
 * So a nested turn reserves, settles and refunds on its own, exactly as an
 * ordinary turn does — and this is the one place that decides how.
 *
 * ## The payer is decided by the CALLER, before anything is reserved
 *
 * `payerOxyUserId` is a parameter, resolved when the TOOL was built rather than
 * when the model called it: the account that funds the outer turn funds the
 * turns it spawns. `lib/agent/turn-funding.ts` states the rule this obeys —
 * one reservation, one subject, chosen before the debit and never changed
 * halfway. It is deliberately not `reserveAgentTurn`: that decides between an
 * agent's own balance and its owner's from a column that does not exist yet,
 * and an agent answering a question it did not initiate is not the case that
 * module was written for.
 *
 * Every exit either settles or refunds. A `finally` that has not seen the
 * settlement refunds, so a throw between `generateText` and `finalizeCredits`
 * cannot leave the reservation debited — which is the failure this repository
 * has shipped eight times.
 *
 * ## What the nested agent may reach, and why it cannot nest again
 *
 * `ToolPipeline.forUser` with the CALLEE as the agent, so it reaches what its
 * own owner granted it and nothing more. `actsForPerson` is false and there is
 * no access token: this is not a person's turn, so none of the person-bound
 * tools and none of the connector sources are in scope.
 *
 * It answers as ITSELF, too: the system message is the identity guard plus the
 * agent's remit, the same composition the chat, the voice channel, a trigger
 * and an agent's own Telegram bot use since #453. An agent that answered
 * another agent as "Alia" would be the same defect that shipped on those four.
 *
 * That flag is also the RECURSION BOUND, and it is structural rather than a
 * counter: the `agent` capability family is only built for a turn that acts for
 * a person, so the callee never receives `askAgent` and cannot call back into
 * the caller. Depth is one, by construction, with no number to keep in sync.
 */

import { generateText, stepCountIs } from 'ai';
import { agentPromptName, type HydratedAgent } from '../agent-identity.js';
import { agentRemitPrompt } from '../agent/archetype-prompts.js';
import { buildIdentityGuard } from '../identity-guard.js';
import { resolveOxyRoutingProfileId, getAIModel } from '../chat-core.js';
import { evolveAgentSoul } from '../agent/soul.js';
import {
  finalizeCredits,
  refundReservation,
  reserveCredits,
  type CreditReservation,
} from '../credits-manager.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

export const AGENT_TIMEOUT_MS = 45_000;
export const AGENT_MAX_STEPS = 5;
export const AGENT_MAX_OUTPUT_TOKENS = 4096;

export interface AgentTurnResult {
  response: string;
  tokensUsed: number;
  /** What the nested turn actually cost the payer, after settlement. */
  creditsCharged: number;
  /**
   * Why there is no response, in words the CALLING MODEL is meant to read.
   *
   * A nested turn fails for reasons the outer turn can act on — the payer is
   * out of credits, the agent took too long — so it comes back as a value
   * rather than as a throw that would abort the whole turn.
   */
  error?: string;
}

function failed(error: string): AgentTurnResult {
  return { response: '', tokensUsed: 0, creditsCharged: 0, error };
}

/**
 * Run one turn of `agent` on `task`, billed to `payerOxyUserId`.
 *
 * @param agent The agent that will answer, already resolved and AUTHORISED by
 *   the caller. This function checks nothing about who may reach it: the two
 *   callers authorise differently — a catalogue listing and an owner's own
 *   grant — and a check here would be a third answer neither of them asked for.
 */
export async function runAgentTurn(input: {
  agent: HydratedAgent;
  task: string;
  payerOxyUserId: string;
}): Promise<AgentTurnResult> {
  const { agent, task, payerOxyUserId } = input;
  const start = Date.now();

  /**
   * Composed the way every other agent surface composes: the identity guard on
   * top, the agent's remit under it.
   *
   * NOT `agent.systemPrompt` with a name sentence built here when it is empty,
   * which is what this path did and what #453 removed from four surfaces at
   * once. Two things were wrong with it and the second is the one a person
   * notices: the sentence was a SECOND owner of the agent's name, and an agent
   * whose owner never wrote a prompt reached the model with no description of
   * itself at all — `archetype` defaults to `general`, for which there is no
   * archetype prompt, so the fallback was the whole remit.
   *
   * `agentRemitPrompt` answers "what describes this agent" once —
   * `systemPrompt`, else the archetype, else the listing, never empty — and
   * emits the `# AGENT: <name>` heading the guard's remit rule POINTS AT. A
   * composition that dropped the heading would leave that rule naming a section
   * that is not there, which reads to the model like no rule at all.
   *
   * The shape is `routes/webhooks.ts`'s, deliberately: an agent answering on its
   * own Telegram bot is the same event as an agent answering another agent —
   * one agent, one `generateText`, its own tools — and the two must not compose
   * differently.
   */
  const systemPrompt = `${buildIdentityGuard({
    agentName: agentPromptName(agent),
  })}\n\n---\n\n${agentRemitPrompt(agent)}`;

  if (agent.routingProfileId === null) {
    return failed('That agent has no exact routing profile configured');
  }
  const resolved = await resolveOxyRoutingProfileId(agent.routingProfileId);
  if (resolved === null) return failed('That agent has no valid routing profile configured');
  const routingProfileId = resolved.routingProfileId;

  const model = getAIModel(resolved, 'agent_run');

  /**
   * Imported lazily to break a real cycle, not for load time.
   *
   * `tool-pipeline.ts` imports the tools that import this module, so a static
   * import here closes the loop and leaves one of the two half-initialised
   * depending on which is entered first. The pipeline is only needed inside
   * this call, which runs long after both modules are loaded.
   */
  const { ToolPipeline } = await import('../tool-pipeline.js');
  const { tools: agentTools } = await ToolPipeline.forUser({
    // The agent's OWN account: this turn is the agent's, not a person's.
    userId: agent.oxyAccountId,
    isDirectSession: false,
    actsForPerson: false,
    agentMode: false,
    toolsEnabled: true,
    webSearch: true,
    isLocalRuntime: false,
    agent,
  });

  /**
   * Reserved before the call and after everything that can refuse without
   * spending, so a turn that was never going to run does not touch a balance.
   */
  const reservation: CreditReservation | null = await reserveCredits(payerOxyUserId);
  if (!reservation) {
    log.credits.info({ agentId: agent._id, payerOxyUserId }, 'Nested agent turn refused: no credits');
    return failed('Not enough credits to run that agent');
  }

  let settled = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: task,
      tools: agentTools,
      stopWhen: stepCountIs(AGENT_MAX_STEPS),
      maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
      temperature: 0.4,
      abortSignal: controller.signal,
    });

    const tokensUsed = result.usage?.totalTokens || 0;
    const { creditsCharged } = await finalizeCredits(
      reservation,
      {
        promptTokens: result.usage?.inputTokens || 0,
        completionTokens: result.usage?.outputTokens || 0,
        totalTokens: tokensUsed,
      },
      routingProfileId,
    );
    // Only once the charge returned. A finalize that threw leaves the
    // reservation unsettled, and therefore refunded rather than kept.
    settled = true;

    log.general.info(
      {
        agentId: agent._id,
        agentName: agentPromptName(agent),
        tokensUsed,
        creditsCharged,
        payerOxyUserId,
        latencyMs: Date.now() - start,
      },
      'Nested agent turn completed',
    );

    // Evolve the agent's soul on ~10% of interactions (fire-and-forget). A
    // failure here is logged rather than swallowed: it changes nothing about
    // the answer, and a silent one would hide the feature being dead.
    if (tokensUsed > 0 && result.text && Math.random() < 0.1) {
      evolveAgentSoul(agent._id, task, result.text).catch((err: unknown) =>
        log.general.warn({ err, agentId: agent._id }, 'Agent soul evolution failed'),
      );
    }

    return { response: result.text, tokensUsed, creditsCharged };
  } catch (error: unknown) {
    log.general.error({ err: error, agentId: agent._id }, 'Nested agent turn failed');
    return failed(
      error instanceof Error && error.name === 'AbortError'
        ? `Agent timed out (${AGENT_TIMEOUT_MS / 1000}s)`
        : getErrorMessage(error),
    );
  } finally {
    clearTimeout(timeout);
    /**
     * The only exit that neither charges nor refunds is one that never
     * reserved, and it returned above. Everything else lands here: a timeout, a
     * provider error, a `finalizeCredits` that threw after the answer arrived.
     */
    if (!settled) await refundReservation(reservation);
  }
}
