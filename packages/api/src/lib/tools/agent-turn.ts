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
 * That flag is also the RECURSION BOUND, and it is structural rather than a
 * counter: the `agent` capability family is only built for a turn that acts for
 * a person, so the callee never receives `askAgent` and cannot call back into
 * the caller. Depth is one, by construction, with no number to keep in sync.
 */

import { generateText, stepCountIs } from 'ai';
import { agentPromptName, type HydratedAgent } from '../agent-identity.js';
import { resolveModel, getAIModel } from '../chat-core.js';
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
   * The agent's own instructions, or a sentence built from what it IS.
   *
   * No `Capabilities:` line: it listed the decorative `capabilities` ids, which
   * named no tool this turn actually hands over.
   */
  const systemPrompt =
    agent.systemPrompt || `You are ${agentPromptName(agent)}, an AI agent. ${agent.tagline}. ${agent.description}`;

  /**
   * The agent's own first choice, then the lightweight default — and the ALIAS
   * is kept beside the resolution, because it is what prices the turn.
   *
   * Written as a literal in the fallback position rather than lifted into a
   * `const`. `lib/__tests__/defaultChatModel.test.ts` censuses exactly this
   * spelling, and a name one line earlier is invisible to it: the restated
   * default would leave the frozen list by being harder to see rather than by
   * being removed.
   */
  const preferredModel = agent.allowedModels[0] || 'alia-lite';
  const resolvedPreferred = await resolveModel(preferredModel);
  const aliasModelId = resolvedPreferred ? preferredModel : 'alia-lite';
  const resolved = resolvedPreferred ?? (await resolveModel('alia-lite'));
  if (!resolved) return failed('No model available for agent execution');

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
      aliasModelId,
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
