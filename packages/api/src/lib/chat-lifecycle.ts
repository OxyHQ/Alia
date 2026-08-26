import type { Request } from 'express';
import { saveConversation, generateConversationTitle, generateTitle } from './conversation-saver.js';
import { getRoutingPreset } from './routing/presets.js';
import { finalizeCredits, type CreditReservation, type CreditUsage } from './credits-manager.js';
import { detectCreditAnomaly, type CreditWarning } from './credit-anomaly.js';
import { recordUsage } from '../middleware/api-key-rate-limit.js';
import { runAfterChatHooks } from './hooks/index.js';
import { runAutonomyAfterChat, type AutonomyRuntimeContext } from './autonomy/runtime.js';
import { sendNotification } from './notification-service.js';
import { log } from './logger.js';
import type { ChatMessage } from './message-converter.js';
import { getDb } from '../db/index.js';
import { conversationExists } from '../db/chat/conversationRepository.js';
import { messageExistsInConversation } from '../db/chat/messageRepository.js';

export interface LifecycleContext {
  userId?: string;
  conversationId?: string;
  messages: ChatMessage[];
  /** The alias the provider loop settled on. */
  aliasModelId: string;
  /** What the caller asked for, before resolution. */
  requestedModel: string;
  /**
   * The reasoning parameter, computed where `thinkingMode` is in scope.
   *
   * Recorded beside the model choice rather than inside it: `alia-v1-thinking`
   * and `alia-v1-pro-max` are one routing preset with two names, so a reasoning
   * request buried in a model identifier is a request nothing can count.
   */
  reasoningEffort: string | null;
  creditReservation: CreditReservation | null;
  tokenUsage: CreditUsage;
  requestStartTime: number;
  skillId?: string;
  isApiKey: boolean;
  autonomyRuntime: AutonomyRuntimeContext | null;
}

/**
 * What one turn observed while it ran, shared BY REFERENCE with the streaming
 * and non-streaming branches — the same reason `StreamRunnerState` crosses that
 * boundary mutable: the writes happen inside the branch and the reads happen
 * after it, including on the paths where the branch threw.
 *
 * Both fields exist because a turn is not only "how long did it take": a first
 * token at 400ms followed by a 30-second answer and a first token at 30s are
 * the same `latencyMs` and completely different products, and a turn the user
 * walked away from is not a turn that failed.
 */
export interface TurnObservation {
  /**
   * Milliseconds from the request arriving to the first chunk the MODEL
   * produced — measured where the provider stream is consumed, which is
   * upstream of Alia's own SSE write. Everything below that write (proxy
   * buffering, Nagle, a slow client) is invisible to it; see the column comment
   * in `db/schema/usage.ts`.
   *
   * Null until a chunk arrives, and null forever on the non-streaming path,
   * which has no first token to time.
   */
  timeToFirstTokenMs: number | null;
  /** Set when the caller's socket closed before the turn finished. */
  cancelled: boolean;
}

/**
 * Save conversation and generate title.
 * For streaming: pass titlePromise from parallel title generation.
 * For non-streaming: generates title inline.
 */
/**
 * Did this turn produce anything? Text, or a tool that ran.
 *
 * The one question two different decisions ask: whether there is a turn worth
 * storing, and whether there is a turn worth billing. They were the same test
 * written once, so the billing side did not have it.
 */
export function turnProducedOutput(
  assistantResponse: string,
  toolInvocations?: Array<{ toolCallId: string; toolName: string; state: 'call' | 'result'; args?: unknown; result?: unknown }>,
): boolean {
  return Boolean(assistantResponse) || (toolInvocations?.length ?? 0) > 0;
}

export async function saveConversationResult(
  ctx: LifecycleContext,
  assistantResponse: string,
  toolInvocations?: Array<{ toolCallId: string; toolName: string; state: 'call' | 'result'; args?: unknown; result?: unknown }>,
  agentMessages?: Array<{ role: 'assistant'; content: string; agentInfo: { id: string; name: string; color: string | null; handle: string } }>,
): Promise<void> {
  const { userId, conversationId, messages } = ctx;
  if (!conversationId || !userId || !turnProducedOutput(assistantResponse, toolInvocations)) return;

  try {
    await saveConversation({
      userId,
      conversationId,
      messages,
      assistantResponse,
      toolInvocations,
      agentMessages: agentMessages && agentMessages.length > 0 ? agentMessages : undefined,
    });
    log.v1.info({ conversationId }, 'Conversation saved');
  } catch (error) {
    log.v1.error({ err: error }, 'Error saving conversation');
  }
}

/**
 * Generate a conversation title (non-streaming path).
 * Fire-and-forget — errors are logged but not thrown.
 */
export function generateTitleAsync(userId: string, conversationId: string, messages: ChatMessage[]): void {
  const firstUserMsgRaw = messages.find((m: ChatMessage) => m.role === 'user')?.content;
  const firstUserMsg = typeof firstUserMsgRaw === 'string'
    ? firstUserMsgRaw
    : Array.isArray(firstUserMsgRaw)
      ? (firstUserMsgRaw.find((p: { type: string; text?: string }) => p.type === 'text')?.text ?? '')
      : '';
  if (firstUserMsg) {
    generateConversationTitle(userId, conversationId, firstUserMsg)
      .catch(err => log.v1.error({ err }, 'Background title generation failed'));
  }
}

/**
 * Start title generation in parallel (streaming path).
 * Returns a Promise<string | null> that resolves when the title is ready.
 */
export async function startParallelTitleGeneration(
  userId: string,
  conversationId: string,
  messages: ChatMessage[],
): Promise<string | null> {
  /**
   * Two existence checks, and the second is deliberately NOT scoped to the user
   * — the source counted messages by `conversationId` alone. A conversation id
   * is a `randomUUID()`, so the cross-account reading is theoretical, but it is
   * what decides whether a title is generated and tightening it silently would
   * change when titles appear.
   */
  const existing = await conversationExists(getDb(), userId, conversationId);
  const hasMessages = existing ? await messageExistsInConversation(getDb(), conversationId) : false;
  if (existing && hasMessages) return null;

  const firstUserMsgRaw = messages.find((m: ChatMessage) => m.role === 'user')?.content;
  const firstUserMsg = typeof firstUserMsgRaw === 'string'
    ? firstUserMsgRaw
    : Array.isArray(firstUserMsgRaw)
      ? (firstUserMsgRaw.find((p: { type: string; text?: string }) => p.type === 'text')?.text ?? '')
      : '';
  if (!firstUserMsg) {
    // A turn whose only content part is an attachment reaches here. Nothing to
    // title on is a legitimate outcome, but it is indistinguishable from a
    // broken titler at the sidebar, which is the whole reason it is said aloud.
    log.v1.warn({ conversationId }, 'Title generation skipped: the turn carries no user text');
    return null;
  }

  return generateTitle(firstUserMsg);
}

/**
 * Finalize credits, detect anomalies, and record usage.
 */
export async function finalizeChatCredits(
  ctx: LifecycleContext,
  req: Request,
  /**
   * Marked the moment the charge lands, so the handler's release point knows
   * not to refund on top of it. Taken here rather than set by each caller: the
   * streaming and non-streaming paths both finalize, and only one of them
   * remembered.
   */
  settlement: { creditsSettled: boolean },
): Promise<{ creditsCharged: number; creditsRemaining: number; creditWarning: CreditWarning | null }> {
  const { creditReservation, tokenUsage, aliasModelId, userId } = ctx;
  let creditsCharged = 0;
  let creditsRemaining = 0;
  let creditWarning: CreditWarning | null = null;

  if (!creditReservation || !userId) {
    return { creditsCharged, creditsRemaining, creditWarning };
  }

  try {
    const creditResult = await finalizeCredits(creditReservation, tokenUsage, aliasModelId);
    // Only once the charge returned. A finalize that threw leaves the
    // reservation unsettled, and therefore refunded rather than kept.
    settlement.creditsSettled = true;
    creditsCharged = creditResult.creditsCharged;
    creditsRemaining = creditResult.creditsRemaining;

    // Record usage with credits info
    recordUsage(req, 200, tokenUsage.totalTokens, undefined, creditsCharged).catch(err =>
      log.v1.error({ err }, 'Error recording session usage')
    );
  } catch (error) {
    log.v1.error({ err: error }, 'Error finalizing credits');
  }

  // Detect spending anomalies for proactive warnings
  if (userId) {
    try {
      creditWarning = await detectCreditAnomaly(userId);
      if (creditWarning) {
        // The number the turn was BILLED on, from the same seam `credits-manager`
        // charges through. Reading it off the catalogue instead let the warning
        // quote a multiplier the bill never used, once the preset became the
        // source of price.
        creditWarning.currentModelMultiplier = getRoutingPreset(aliasModelId)?.creditMultiplier ?? 1;
      }
    } catch { /* non-critical anomaly check */ }
  }

  return { creditsCharged, creditsRemaining, creditWarning };
}

/**
 * Run after-chat hooks and autonomy learning (fire-and-forget).
 *
 * Called on FAILED turns as well as successful ones (#139 ws19). That is what
 * gives `chat_analytics.error_class` values: before it, the only call sites
 * were the two success paths, so a turn that exhausted every provider or timed
 * out left no usage record at all and the failure classes `lib/errors` already
 * computes aggregated nowhere.
 *
 * One consequence to state rather than discover: `runAutonomyAfterChat` scores
 * a run by `!!assistantResponse`, so a failed turn is now learned as an
 * unsuccessful run instead of not being learned at all. That is the more
 * correct signal, and it is a behaviour change.
 */
export function runPostChatHooks(
  ctx: LifecycleContext,
  assistantResponse: string,
  observation: TurnObservation,
  errorClass: string | null,
): void {
  const { userId, messages, aliasModelId, requestedModel, reasoningEffort, tokenUsage, requestStartTime, skillId, isApiKey, autonomyRuntime } = ctx;

  runAfterChatHooks({
    userId,
    conversationId: ctx.conversationId,
    messages,
    model: aliasModelId,
    skillId,
    platform: isApiKey ? 'telegram' as const : 'app' as const,
    metadata: { model: aliasModelId },
    response: assistantResponse,
    tokenUsage,
    modelUsed: aliasModelId,
    requestedModel,
    reasoningEffort,
    latencyMs: Date.now() - requestStartTime,
    timeToFirstTokenMs: observation.timeToFirstTokenMs,
    errorClass,
    cancelled: observation.cancelled,
  }).catch(err => log.v1.error({ err }, 'Error in afterChat hooks'));

  runAutonomyAfterChat({
    userId,
    runtimeContext: autonomyRuntime,
    messages,
    assistantResponse,
    latencyMs: Date.now() - requestStartTime,
  }).catch(err => log.v1.warn({ err }, 'Autonomy after-chat learn failed'));
}

/**
 * Send a push notification if the client disconnected before the stream finished.
 */
export function notifyDisconnectedClient(
  userId: string,
  conversationId: string,
  assistantResponse: string,
): void {
  if (assistantResponse.length === 0) return;

  sendNotification({
    userId,
    type: 'chat_response_ready',
    title: 'Alia has responded',
    body: assistantResponse.slice(0, 200) + (assistantResponse.length > 200 ? '...' : ''),
    conversationId,
  }).catch(err => log.v1.warn({ err }, 'Failed to send disconnect notification'));
}
