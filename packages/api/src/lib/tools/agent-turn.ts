import { reserveBackgroundProductCredits } from '../product-credit-access';
/**
 * ONE agent turn, run from inside somebody else's turn, streamed and PAID FOR
 * (Alia ADR 0020 §5).
 *
 * `consultAgent` is the one tool that runs an agent this way: Alia — or an
 * agent granted the `agent` family — asks another agent the person can reach,
 * and that agent answers in its own voice, live, in the same conversation.
 *
 * ## It is the consulted agent's turn FOR THE SAME PERSON
 *
 * The person present is still present: the nested turn is assembled by
 * `ToolPipeline.forUser` as that person's turn with the CALLEE as the agent, so
 * it reaches exactly what an ordinary conversation with the callee would — its
 * own families and memory of this person, and the person's Oxy apps on the
 * lane the person stands in (the owner's levels for its owner, the owner's
 * published ceilings for anybody else; ADR 0020 §2). Nothing is widened by
 * being consulted rather than opened.
 *
 * `nested: true` is the recursion bound and the surface bound at once: a
 * nested turn never receives `consultAgent`, the catalogue search, agent
 * creation, host tools or the SSE tools — there is no second surface to draw
 * them and depth is one by construction.
 *
 * ## The payer is the outer turn's
 *
 * `payerOxyUserId` is resolved when the tool is built: the account that funds
 * the outer turn funds the turns it spawns (`lib/agent/turn-funding.ts`). The
 * nested turn reserves, settles and refunds on its own — the outer turn's
 * usage is assigned from its own stream and never covers tokens spent inside a
 * tool — and every exit either settles or refunds.
 *
 * ## It answers as ITSELF
 *
 * The system message is the identity guard plus the agent's remit — the same
 * composition every agent surface uses.
 */

import { stepCountIs, streamText } from 'ai';
import { agentPromptName, type HydratedAgent } from '../agent-identity.js';
import { agentRemitPrompt } from '../agent/archetype-prompts.js';
import { buildIdentityGuard } from '../identity-guard.js';
import { resolveStoredModel, getAIModel } from '../chat-core.js';
import { evolveAgentSoul } from '../agent/soul.js';
import { finalizeCredits, refundReservation, type CreditReservation } from '../credits-manager.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { servedModelId, servedReferenceOf } from '../models/power-levels.js';

/**
 * Bounded so a consultation fits inside the outer request's own limit
 * (`routes/v1/chat-completions.ts`) with room for the lead to answer after it.
 */
export const AGENT_TIMEOUT_MS = 45_000;
export const AGENT_MAX_STEPS = 8;
export const AGENT_MAX_OUTPUT_TOKENS = 4096;

export interface AgentTurnResult {
  response: string;
  tokensUsed: number;
  /** What the nested turn actually cost the payer, after settlement. */
  creditsCharged: number;
  /**
   * Why there is no response, in words the CALLING MODEL is meant to read: a
   * nested turn fails for reasons the outer turn can act on, so it comes back
   * as a value rather than a throw that would abort the whole turn.
   */
  error?: string;
}

/** The person the nested turn is for, exactly as the outer turn holds them. */
export interface AgentTurnPerson {
  oxyUserId: string;
  /** The person's live bearer, for Oxy direct requests; absent on a channel turn. */
  accessToken?: string;
  isDirectSession: boolean;
}

/** What the nested turn shows while it runs. Each callback is best effort. */
export interface AgentTurnObserver {
  onTextDelta?: (text: string) => void;
  onToolCall?: (call: { toolCallId: string; name: string; input: unknown }) => void;
  onToolResult?: (result: { toolCallId: string; name: string; output: unknown }) => void;
}

function failed(error: string): AgentTurnResult {
  return { response: '', tokensUsed: 0, creditsCharged: 0, error };
}

/**
 * Run one streamed turn of `agent` on `task` for `person`, billed to
 * `payerOxyUserId`.
 *
 * @param agent Already resolved and AUTHORISED by the caller (`canReachAgent`).
 */
export async function runAgentTurn(input: {
  agent: HydratedAgent;
  task: string;
  person: AgentTurnPerson;
  payerOxyUserId: string;
  observer?: AgentTurnObserver;
}): Promise<AgentTurnResult> {
  const { agent, task, person, payerOxyUserId, observer } = input;
  const start = Date.now();

  const systemPrompt = `${buildIdentityGuard({
    agentName: agentPromptName(agent),
  })}\n\n---\n\n${agentRemitPrompt(agent)}`;

  const resolved = await resolveStoredModel(agent.modelId).catch(() => null);
  if (resolved === null) return failed('No model is available for that agent right now');
  const modelId = resolved.modelId;
  const model = getAIModel(resolved, 'agent_run');

  /**
   * Imported lazily to break a real cycle: `tool-pipeline.ts` imports the tool
   * that imports this module.
   */
  const { ToolPipeline } = await import('../tool-pipeline.js');
  const {
    tools: agentTools,
    routing: toolRouting,
    appCatalogPrompt,
    toolNameMapping,
  } = await ToolPipeline.forUser({
    userId: person.oxyUserId,
    ...(person.accessToken ? { accessToken: person.accessToken } : {}),
    isDirectSession: person.isDirectSession,
    actsForPerson: true,
    requesterAccountId: person.oxyUserId,
    nested: true,
    inputLimits: resolved.catalogue,
    toolsEnabled: true,
    webSearch: true,
    isLocalRuntime: false,
    agent,
  });

  /** Reserved after everything that can refuse without spending. */
  const reservation: CreditReservation | null =
    await reserveBackgroundProductCredits(payerOxyUserId);
  if (!reservation) {
    log.credits.info({ agentId: agent._id, payerOxyUserId }, 'Consultation refused: no credits');
    return failed('Not enough credits to consult that agent');
  }

  let settled = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  const nameOf = (toolName: string) => toolNameMapping.get(toolName) ?? toolName;
  const observe = (call: () => void) => {
    try {
      call();
    } catch (error: unknown) {
      log.general.warn({ err: error, agentId: agent._id }, 'A consultation observer threw');
    }
  };

  try {
    const result = streamText({
      model,
      system: systemPrompt + appCatalogPrompt,
      prompt: task,
      tools: agentTools,
      ...toolRouting,
      stopWhen: stepCountIs(AGENT_MAX_STEPS),
      maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
      temperature: 0.4,
      abortSignal: controller.signal,
    });

    let response = '';
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta' && part.text) {
        response += part.text;
        observe(() => observer?.onTextDelta?.(part.text));
      } else if (part.type === 'tool-call') {
        observe(() =>
          observer?.onToolCall?.({
            toolCallId: part.toolCallId,
            name: nameOf(part.toolName),
            input: part.input,
          }),
        );
      } else if (part.type === 'tool-result') {
        observe(() =>
          observer?.onToolResult?.({
            toolCallId: part.toolCallId,
            name: nameOf(part.toolName),
            output: part.output,
          }),
        );
      } else if (part.type === 'error') {
        throw part.error;
      }
    }

    const usage = await result.totalUsage;
    const tokensUsed = usage?.totalTokens || 0;
    const { creditsCharged } = await finalizeCredits(
      reservation,
      {
        promptTokens: usage?.inputTokens || 0,
        completionTokens: usage?.outputTokens || 0,
        totalTokens: tokensUsed,
      },
      servedModelId(
        modelId,
        servedReferenceOf({ providerMetadata: await result.providerMetadata }),
      ),
    );
    // Only once the charge returned: a finalize that threw is refunded below.
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
      'Consultation completed',
    );

    if (tokensUsed > 0 && response && Math.random() < 0.1) {
      evolveAgentSoul(agent._id, task, response).catch((err: unknown) =>
        log.general.warn({ err, agentId: agent._id }, 'Agent soul evolution failed'),
      );
    }

    return { response, tokensUsed, creditsCharged };
  } catch (error: unknown) {
    log.general.error({ err: error, agentId: agent._id }, 'Consultation failed');
    return failed(
      controller.signal.aborted
        ? `The agent took too long (${AGENT_TIMEOUT_MS / 1000}s)`
        : getErrorMessage(error),
    );
  } finally {
    clearTimeout(timeout);
    if (!settled) await refundReservation(reservation);
  }
}
