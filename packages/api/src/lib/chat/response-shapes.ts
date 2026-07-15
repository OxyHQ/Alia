/**
 * OpenAI-compatible chat.completion response envelopes.
 * Single builder for the three places that previously hand-assembled the
 * envelope (global-timeout fallback, non-streaming success, last-resort
 * synthetic) so the shape can no longer drift between them.
 */
import type { CreditWarning } from '../credit-anomaly.js';

export interface CompletionToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface CompletionTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AliaUsage {
  system_prompt_tokens: number;
  billable_tokens: number;
  credits_charged: number;
  credits_remaining: number;
  credit_warning?: CreditWarning | null;
}

export interface CompletionResponseOptions {
  requestId: string;
  model: string;
  content: string;
  finishReason?: string;
  toolCalls?: CompletionToolCall[];
  /** Omitted → zeroed usage block (timeout/synthetic responses). */
  usage?: CompletionTokenUsage;
  aliaUsage?: AliaUsage;
  aliaMeta?: Record<string, unknown>;
}

/** Build a complete OpenAI-compatible `chat.completion` response body. */
export function buildCompletionResponse(opts: CompletionResponseOptions): Record<string, unknown> {
  const { requestId, model, content, finishReason = 'stop', toolCalls, usage, aliaUsage, aliaMeta } = opts;
  return {
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: 'fp_alia',
    service_tier: 'default',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
        refusal: null,
        ...(toolCalls && toolCalls.length > 0 && { tool_calls: toolCalls }),
      },
      logprobs: null,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: usage?.promptTokens ?? 0,
      completion_tokens: usage?.completionTokens ?? 0,
      total_tokens: usage?.totalTokens ?? 0,
      prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
    },
    ...(aliaUsage && { alia_usage: aliaUsage }),
    ...(aliaMeta && { alia_meta: aliaMeta }),
  };
}
