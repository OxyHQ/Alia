import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PRODUCTION_CANARY_CASES,
  summarize,
} from './production-chat-canary.js';

describe('production chat canary safe projection', () => {
  it('has the exact mode, tool, refusal and recovery matrix without duplicate labels', () => {
    expect(PRODUCTION_CANARY_CASES.map(({ label }) => label)).toEqual([
      'instant-1',
      'instant-2',
      'auto-1',
      'auto-2',
      'thinking-1',
      'thinking-2',
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
      'event: alia.tool_result\ndata: {"name":"otherTool"}\n\ndata: [DONE]\n\n';
    const executedSearch =
      'event: alia.tool_result\ndata: {"name":"webSearch"}\n\ndata: [DONE]\n\n';

    for (const payload of [emptyCalls, toolishEvent, wrongTool]) {
      expect(summarize({ label: 'search', marker: '' }, 200, payload).toolEvent).toBe(
        false,
      );
    }
    expect(
      summarize({ label: 'search', marker: '' }, 200, executedSearch).toolEvent,
    ).toBe(true);
  });

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
