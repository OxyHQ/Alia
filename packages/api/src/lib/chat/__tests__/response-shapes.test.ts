import { describe, it, expect } from 'vitest';
import { buildCompletionResponse } from '../response-shapes.js';

describe('buildCompletionResponse', () => {
  it('builds a synthetic envelope with zeroed usage and alia_meta', () => {
    const body = buildCompletionResponse({
      requestId: 'chatcmpl-test',
      model: 'alia-v1',
      content: 'Sorry, busy.',
      aliaMeta: { synthetic: true, retryable: true },
    });

    expect(body).toMatchObject({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: 'alia-v1',
      system_fingerprint: 'fp_alia',
      service_tier: 'default',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Sorry, busy.', refusal: null },
        logprobs: null,
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
      },
      alia_meta: { synthetic: true, retryable: true },
    });
    expect(body).not.toHaveProperty('alia_usage');
    expect((body.choices as Array<{ message: object }>)[0].message).not.toHaveProperty('tool_calls');
    expect(typeof body.created).toBe('number');
  });

  it('builds a full non-streaming envelope with usage, alia_usage, and tool_calls', () => {
    const body = buildCompletionResponse({
      requestId: 'chatcmpl-full',
      model: 'alia-v1-pro',
      content: 'done',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      aliaUsage: {
        system_prompt_tokens: 4,
        billable_tokens: 11,
        credits_charged: 1,
        credits_remaining: 99,
        credit_warning: null,
      },
    });

    expect(body).toMatchObject({
      choices: [{
        message: {
          content: 'done',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      alia_usage: { billable_tokens: 11, credits_charged: 1, credits_remaining: 99 },
    });
    expect(body).not.toHaveProperty('alia_meta');
  });

  it('omits tool_calls for an empty array', () => {
    const body = buildCompletionResponse({
      requestId: 'chatcmpl-empty',
      model: 'alia-v1',
      content: 'hi',
      toolCalls: [],
    });
    expect((body.choices as Array<{ message: object }>)[0].message).not.toHaveProperty('tool_calls');
  });
});
