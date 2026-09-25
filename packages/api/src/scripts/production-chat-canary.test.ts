import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PRODUCTION_CANARY_CASES,
  summarize,
} from './production-chat-canary.js';

describe('production chat canary safe projection', () => {
  it('has the exact default, research, tool, refusal and recovery matrix without duplicate labels', () => {
    expect(PRODUCTION_CANARY_CASES.map(({ label }) => label)).toEqual([
      'default-1',
      'default-2',
      'default-3',
      'default-4',
      'arithmetic-1',
      'arithmetic-2',
      'research-1',
      'research-2',
      'search-tool',
      'controlled-refusal',
      'recovery',
    ]);
    expect(
      new Set(PRODUCTION_CANARY_CASES.map(({ label }) => label)).size,
    ).toBe(11);
    const search = PRODUCTION_CANARY_CASES.find(
      ({ label }) => label === 'search-tool',
    );
    expect(search).toMatchObject({ expectTool: true });
    expect(search?.tools?.[0]).toMatchObject({
      type: 'function',
      function: { name: 'webSearch' },
    });
  });

  it('requires exact, non-empty webSearch evidence', () => {
    const emptyCalls =
      'data: {"choices":[{"delta":{"tool_calls":[]}}]}\n\ndata: [DONE]\n\n';
    const toolishEvent =
      'event: alia.toolish\ndata: {"name":"webSearch"}\n\ndata: [DONE]\n\n';
    const wrongTool =
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"webSearch"}}]}}]}\n\nevent: alia.tool_result\ndata: {"tool_call_id":"call-1","name":"otherTool","output":{"results":[{"title":"Source","url":"https://example.org"}],"count":1}}\n\ndata: [DONE]\n\n';
    const requestedOnly =
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"webSearch"}}]}}]}\n\ndata: [DONE]\n\n';
    const unmatchedResult =
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"webSearch"}}]}}]}\n\nevent: alia.tool_result\ndata: {"tool_call_id":"call-2","name":"webSearch","output":{"results":[{"title":"Source","url":"https://example.org"}],"count":1}}\n\ndata: [DONE]\n\n';
    const executedSearch =
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"webSearch"}}]}}]}\n\nevent: alia.tool_result\ndata: {"tool_call_id":"call-1","name":"webSearch","output":{"results":[{"title":"Source","url":"https://example.org/source","snippet":"Evidence"}],"count":1}}\n\ndata: [DONE]\n\n';

    for (const payload of [
      emptyCalls,
      toolishEvent,
      wrongTool,
      requestedOnly,
      unmatchedResult,
    ]) {
      expect(
        summarize({ label: 'search', marker: '' }, 200, payload).toolEvent,
      ).toBe(false);
    }
    expect(
      summarize({ label: 'search', marker: '' }, 200, executedSearch).toolEvent,
    ).toBe(true);
  });

  it.each([
    undefined,
    { error: 'Clarity request failed with 503', results: [], count: 0 },
    { results: [], count: 0 },
    { results: [{ title: 'Source', url: 'https://example.org' }], count: 0 },
    { results: [{ title: '', url: 'https://example.org' }], count: 1 },
    { results: [{ title: 'Source', url: 'javascript:alert(1)' }], count: 1 },
    { results: [{ title: 'Source', url: 'invalid' }], count: 1 },
    {
      error: 'partial failure',
      results: [{ title: 'Source', url: 'https://example.org' }],
      count: 1,
    },
  ])(
    'rejects an unsuccessful search even when the answer matches: %j',
    (output) => {
      const payload = [
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { id: 'call-1', function: { name: 'webSearch' } },
                  ],
                },
              },
            ],
          }),
        'event: alia.tool_result\ndata: ' +
          JSON.stringify({ tool_call_id: 'call-1', name: 'webSearch', output }),
        'data: ' +
          JSON.stringify({ choices: [{ delta: { content: 'CANARY_OK' } }] }),
        'data: [DONE]',
      ].join('\n\n');
      expect(
        summarize({ label: 'search', marker: 'CANARY_OK' }, 200, payload),
      ).toMatchObject({
        done: true,
        markerMatched: true,
        toolEvent: false,
      });
    },
  );

  it('enters the real HTTP auth router and has a bounded process lifetime', () => {
    const source = readFileSync(
      new URL('./production-chat-canary.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('http://127.0.0.1:3001/alia/chat');
    expect(source).toContain('authorization: `Bearer ${token}`');
    expect(source).toContain("'x-oxy-user-id': qaUserId");
    expect(source).toContain('20 * 60 * 1_000');
    expect(source).not.toContain('handleChatCompletions');
    expect(source).not.toMatch(/req\.(?:user|serviceApp|serviceActingAs)\s*=/);
  });
  it('keeps only product-safe correlation fields', () => {
    const payload = `data: {"id":"chatcmpl-safe","provider":"must-not-leak","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n`;
    expect(summarize({ label: 'auto', marker: 'ok' }, 200, payload)).toEqual({
      label: 'auto',
      reference: 'chatcmpl-safe',
      code: null,
      retryable: null,
      synthetic: false,
      done: true,
      answerPresent: true,
      markerMatched: true,
      toolEvent: false,
      statusCode: 200,
    });
    expect(
      JSON.stringify(summarize({ label: 'auto', marker: 'ok' }, 200, payload)),
    ).not.toContain('must-not-leak');
  });

  it('retains the classified safe failure', () => {
    const payload = `data: {"alia_meta":{"synthetic":true,"retryable":true,"error":{"code":"RATE_LIMITED","reference":"chatcmpl-ref"}},"choices":[{"delta":{"content":"busy"}}]}\n\ndata: [DONE]\n\n`;
    expect(
      summarize({ label: 'recovery', marker: 'busy' }, 200, payload),
    ).toMatchObject({
      reference: 'chatcmpl-ref',
      code: 'RATE_LIMITED',
      retryable: true,
      synthetic: true,
      done: true,
    });
  });

  it('drops oversized references and non-allowlisted error codes', () => {
    const payload = JSON.stringify({
      error: {
        code: 'RAW_PROVIDER_ERROR',
        reference: `chatcmpl-${'x'.repeat(200)}`,
      },
    });
    expect(
      summarize({ label: 'refusal', marker: '' }, 400, payload),
    ).toMatchObject({
      reference: null,
      code: 'REQUEST_REFUSED',
      answerPresent: false,
      synthetic: false,
      done: false,
    });
  });
});
