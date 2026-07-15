/**
 * The non-streaming (`body.stream !== true`) path for /v1/chat/completions.
 *
 * Runs a single `generateText` provider attempt, captures token usage, maps the
 * SDK tool calls into both the conversation-save invocation shape and the
 * OpenAI `tool_calls` array, runs the post-request lifecycle (save + title +
 * credit finalize + afterChat hooks), and writes the OpenAI-compatible JSON
 * envelope. Clears the global request timer on success.
 *
 * Called inside the provider retry loop's per-attempt try: `generateText`
 * throws propagate to the loop's catch for provider fallback, so this function
 * intentionally does not swallow them.
 *
 * Behaviour is byte-identical to the inline branch it replaced. Import seams
 * (`ai`, `../chat-lifecycle.js`, `../logger.js`) match the paths the route used
 * inline so the timeout suite's module mocks keep intercepting them.
 */
import type { Request, Response } from 'express';
import { generateText } from 'ai';
import {
  saveConversationResult,
  generateTitleAsync,
  finalizeChatCredits,
  runPostChatHooks,
  type LifecycleContext,
} from '../chat-lifecycle.js';
import { buildCompletionResponse } from './response-shapes.js';
import { log } from '../logger.js';
import type { CreditReservation, CreditUsage } from '../credits-manager.js';
import type { ChatMessage } from '../message-converter.js';
import type { AutonomyRuntimeContext } from '../autonomy/runtime.js';

export interface NonStreamingParams {
  req: Request;
  res: Response;
  requestId: string;
  globalTimer: NodeJS.Timeout;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK config is dynamically extended; strict SDK param types don't support this pattern
  baseConfig: any;
  clearFirstByteTimer: () => void;
  aliasModelId: string;
  conversationId: string | undefined;
  messages: ChatMessage[];
  creditReservation: CreditReservation | null;
  systemPromptTokens: number;
  requestStartTime: number;
  skillId: string | undefined;
  autonomyRuntime: AutonomyRuntimeContext | null;
  toolNameMapping: Map<string, string>;
}

/** Handle one non-streaming provider attempt end to end; writes the JSON response. */
export async function runNonStreaming(params: NonStreamingParams): Promise<void> {
  const {
    req, res, requestId, globalTimer, baseConfig, clearFirstByteTimer,
    aliasModelId, conversationId, messages, creditReservation,
    systemPromptTokens, requestStartTime, skillId, autonomyRuntime, toolNameMapping,
  } = params;

  log.v1.info('Non-streaming request, using generateText');

  const result = await generateText(baseConfig);
  clearFirstByteTimer();

  // Capture token usage (AI SDK uses inputTokens/outputTokens)
  let tokenUsage: CreditUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    systemPromptTokens,
  };
  if (result.usage) {
    tokenUsage = {
      promptTokens: result.usage.inputTokens || 0,
      completionTokens: result.usage.outputTokens || 0,
      totalTokens: result.usage.totalTokens || 0,
      systemPromptTokens,
    };
    log.v1.info({ usage: tokenUsage }, 'Token usage');
  }

  const assistantResponse = result.text || '';

  // Build tool invocations from generateText result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK TypedToolCall shape varies per tool config
  const nonStreamToolInvocations = (result.toolCalls || []).map((tc: any) => {
    const toolResult = (result.toolResults || []).find((tr: any) => tr.toolCallId === tc.toolCallId);
    return {
      toolCallId: tc.toolCallId,
      toolName: toolNameMapping.get(tc.toolName) || tc.toolName,
      state: toolResult ? 'result' as const : 'call' as const,
      args: tc.args,
      ...(toolResult && { result: toolResult.output }),
    };
  });

  // Build lifecycle context for post-request operations
  const lifecycleCtx: LifecycleContext = {
    userId: req.user?.id,
    conversationId,
    messages,
    aliasModelId,
    creditReservation,
    tokenUsage,
    requestStartTime,
    skillId,
    isApiKey: !!req.apiKey,
    autonomyRuntime,
  };

  // Save conversation + generate title
  await saveConversationResult(lifecycleCtx, assistantResponse, nonStreamToolInvocations);
  if (conversationId && req.user?.id && assistantResponse) {
    generateTitleAsync(req.user.id, conversationId, messages);
  }

  // Finalize credits + detect anomalies
  const { creditsCharged, creditsRemaining, creditWarning } = await finalizeChatCredits(lifecycleCtx, req);

  // Fire afterChat hooks (non-blocking)
  runPostChatHooks(lifecycleCtx, assistantResponse);

  // Build tool_calls array if there were any tool calls
  const toolCalls = result.toolCalls?.map((tc: { toolCallId?: string; toolName: string; args?: unknown }, index: number) => {
    const originalToolName = toolNameMapping.get(tc.toolName) || tc.toolName;
    return {
      id: tc.toolCallId || `call_${Date.now()}_${index}`,
      type: 'function' as const,
      function: {
        name: originalToolName,
        arguments: JSON.stringify(tc.args || {})
      }
    };
  });

  // Return OpenAI-compatible non-streaming response
  res.json(buildCompletionResponse({
    requestId,
    model: aliasModelId,
    content: assistantResponse,
    finishReason: result.finishReason || 'stop',
    toolCalls,
    usage: tokenUsage,
    aliaUsage: {
      system_prompt_tokens: tokenUsage.systemPromptTokens || 0,
      billable_tokens: Math.max(0, tokenUsage.totalTokens - (tokenUsage.systemPromptTokens || 0)),
      credits_charged: creditsCharged,
      credits_remaining: creditsRemaining,
      credit_warning: creditWarning,
    },
  }));
  clearTimeout(globalTimer);
}
