import type { Request } from 'express';
import { saveConversation, generateConversationTitle, generateTitle } from './conversation-saver.js';
import { finalizeCredits, type CreditReservation, type CreditUsage } from './credits-manager.js';
import { detectCreditAnomaly, type CreditWarning } from './credit-anomaly.js';
import { getClarityModel } from './gateway-client.js';
import { recordUsage } from '../middleware/api-key-rate-limit.js';
import { runAfterChatHooks } from './hooks/index.js';
import { sendNotification } from './notification-service.js';
import { log } from './logger.js';
import type { ChatMessage } from './message-converter.js';
import { Conversation } from '../models/conversation.js';

export interface LifecycleContext {
  userId?: string;
  conversationId?: string;
  messages: ChatMessage[];
  clarityModelId: string;
  creditReservation: CreditReservation | null;
  tokenUsage: CreditUsage;
  requestStartTime: number;
  skillId?: string;
  isApiKey: boolean;
}

/**
 * Save conversation and generate title.
 * For streaming: pass titlePromise from parallel title generation.
 * For non-streaming: generates title inline.
 */
export async function saveConversationResult(
  ctx: LifecycleContext,
  assistantResponse: string,
  toolInvocations?: Array<{ toolCallId: string; toolName: string; state: 'call' | 'result'; args?: unknown; result?: unknown }>,
  agentMessages?: Array<{ role: 'assistant'; content: string; agentInfo: { id: string; name: string; avatar: string | null; handle: string } }>,
): Promise<void> {
  const { userId, conversationId, messages } = ctx;
  if (!conversationId || !userId || (!assistantResponse && (!toolInvocations || toolInvocations.length === 0))) return;

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
  const existing = await Conversation.findOne(
    { oxyUserId: userId, conversationId },
    { _id: 1 }
  ).lean();
  const hasMessages = existing
    ? await (await import('../models/message.js')).Message.exists({ conversationId })
    : false;
  if (existing && hasMessages) return null;

  const firstUserMsgRaw = messages.find((m: ChatMessage) => m.role === 'user')?.content;
  const firstUserMsg = typeof firstUserMsgRaw === 'string'
    ? firstUserMsgRaw
    : Array.isArray(firstUserMsgRaw)
      ? (firstUserMsgRaw.find((p: { type: string; text?: string }) => p.type === 'text')?.text ?? '')
      : '';
  if (!firstUserMsg) return null;

  return generateTitle(firstUserMsg);
}

/**
 * Finalize credits, detect anomalies, and record usage.
 */
export async function finalizeChatCredits(
  ctx: LifecycleContext,
  req: Request,
): Promise<{ creditsCharged: number; creditsRemaining: number; creditWarning: CreditWarning | null }> {
  const { creditReservation, tokenUsage, clarityModelId, userId } = ctx;
  let creditsCharged = 0;
  let creditsRemaining = 0;
  let creditWarning: CreditWarning | null = null;

  if (!creditReservation || !userId) {
    return { creditsCharged, creditsRemaining, creditWarning };
  }

  try {
    const creditResult = await finalizeCredits(creditReservation, tokenUsage, clarityModelId);
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
        creditWarning.currentModelMultiplier = (await getClarityModel(clarityModelId))?.creditMultiplier || 1;
      }
    } catch { /* non-critical anomaly check */ }
  }

  return { creditsCharged, creditsRemaining, creditWarning };
}

/**
 * Run after-chat hooks (fire-and-forget).
 */
export function runPostChatHooks(
  ctx: LifecycleContext,
  assistantResponse: string,
): void {
  const { userId, messages, clarityModelId, tokenUsage, requestStartTime, skillId, isApiKey } = ctx;

  runAfterChatHooks({
    userId,
    conversationId: ctx.conversationId,
    messages,
    model: clarityModelId,
    skillId,
    platform: 'app' as const,
    metadata: { model: clarityModelId },
    response: assistantResponse,
    tokenUsage,
    modelUsed: clarityModelId,
    latencyMs: Date.now() - requestStartTime,
  }).catch(err => log.v1.error({ err }, 'Error in afterChat hooks'));
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
    title: 'Clarity has responded',
    body: assistantResponse.slice(0, 200) + (assistantResponse.length > 200 ? '...' : ''),
    conversationId,
  }).catch(err => log.v1.warn({ err }, 'Failed to send disconnect notification'));
}
