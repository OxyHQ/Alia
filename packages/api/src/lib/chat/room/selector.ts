/** The room selector has no tools and cannot act for any member. */
import { generateObject } from 'ai';
import {
  getAIModel,
  resolveDefaultModel,
  resolveUtilityModel,
  utilityOutputTokens,
} from '../../chat-core.js';
import { reserveBackgroundProductCredits } from '../../product-credit-access.js';
import { finalizeCredits, refundReservation } from '../../credits-manager.js';
import { servedModelId, servedReferenceOf } from '../../models/power-levels.js';
import { log } from '../../logger.js';
import {
  ROOM_SELECTION_SYSTEM,
  REACTION_SELECTION_SYSTEM,
  ReactionDecisionSchema,
  reactionRoomDecision,
  roomDecisionChoices,
  roomChoiceSchema,
  roomChoiceDecision,
  roomSelectionData,
  validateRoomDecision,
  type RoomDecision,
  type RoomSelectionInput,
} from './decision.js';

// Auto planning may reason within its token allowance; binary feedback remains a short utility job.
const ROOM_SELECTION_TIMEOUT_MS = 30_000;
const REACTION_SELECTION_TIMEOUT_MS = 10_000;
// Planning must leave room for reasoning before the structured decision. Oxy's
// internal relationship also bounds this request; it must admit this allowance.
const ROOM_SELECTION_OUTPUT_TOKENS = 8_192;

export async function selectRoomDecision(input: RoomSelectionInput): Promise<RoomDecision> {
  const choices = input.trigger ? undefined : roomDecisionChoices(input);
  const schema = choices ? roomChoiceSchema(choices) : ReactionDecisionSchema;
  const prompt = roomSelectionData(input, choices);
  // Multi-member planning uses Oxy's capability-aware default; the fixed-recipient binary
  // feedback decision remains a utility call. Structured output reaches Oxy unchanged.
  const resolved = input.trigger ? await resolveUtilityModel() : resolveDefaultModel();
  const reservation = await reserveBackgroundProductCredits(input.userId);
  if (!reservation) throw new Error('Room selection requires credits');
  let settled = false;
  const started = Date.now();
  try {
    const timeout = AbortSignal.timeout(
      input.trigger ? REACTION_SELECTION_TIMEOUT_MS : ROOM_SELECTION_TIMEOUT_MS,
    );
    const result = await generateObject({
      model: getAIModel(resolved, 'agent_run'),
      schema,
      system: input.trigger ? REACTION_SELECTION_SYSTEM : ROOM_SELECTION_SYSTEM,
      prompt,
      maxOutputTokens: input.trigger ? utilityOutputTokens(512) : ROOM_SELECTION_OUTPUT_TOKENS,
      maxRetries: 1,
      abortSignal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
    });
    const usage = result.usage;
    const { creditsCharged } = await finalizeCredits(
      reservation,
      {
        promptTokens: usage.inputTokens ?? 0,
        completionTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
      },
      servedModelId(
        resolved.modelId,
        servedReferenceOf({ providerMetadata: result.providerMetadata }),
      ),
    );
    settled = true;
    const decision = validateRoomDecision(
      input.trigger
        ? reactionRoomDecision(result.object, input.trigger)
        : roomChoiceDecision(result.object, choices!),
      input,
    );
    log.agents.info(
      {
        conversationId: input.conversationId,
        triggerId: input.triggerId,
        action: decision.action,
        agentId: decision.agentId,
        reason: decision.reason,
        latencyMs: Date.now() - started,
        tokensUsed: usage.totalTokens ?? 0,
        creditsCharged,
      },
      'Room participation selected',
    );
    return decision;
  } finally {
    if (!settled) await refundReservation(reservation);
  }
}
