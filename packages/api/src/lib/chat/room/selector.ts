/** The room selector has no tools and cannot act for any member. */
import { generateObject } from 'ai';
import { getAIModel, resolveUtilityModel, utilityOutputTokens } from '../../chat-core.js';
import { reserveBackgroundProductCredits } from '../../product-credit-access.js';
import { finalizeCredits, refundReservation } from '../../credits-manager.js';
import { servedModelId, servedReferenceOf } from '../../models/power-levels.js';
import { log } from '../../logger.js';
import {
  ROOM_SELECTION_SYSTEM,
  REACTION_SELECTION_SYSTEM,
  ReactionDecisionSchema,
  reactionRoomDecision,
  RoomDecisionSchema,
  roomSelectionData,
  validateRoomDecision,
  type RoomDecision,
  type RoomSelectionInput,
} from './decision.js';

export async function selectRoomDecision(input: RoomSelectionInput): Promise<RoomDecision> {
  const prompt = roomSelectionData(input);
  const resolved = await resolveUtilityModel();
  const reservation = await reserveBackgroundProductCredits(input.userId);
  if (!reservation) throw new Error('Room selection requires credits');
  let settled = false;
  const started = Date.now();
  try {
    const result = await generateObject({
      model: getAIModel(resolved, 'agent_run'),
      schema: input.trigger ? ReactionDecisionSchema : RoomDecisionSchema,
      system: input.trigger ? REACTION_SELECTION_SYSTEM : ROOM_SELECTION_SYSTEM,
      prompt,
      maxOutputTokens: utilityOutputTokens(512),
      maxRetries: 1,
      abortSignal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
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
      input.trigger ? reactionRoomDecision(result.object, input.trigger) : result.object,
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
