/**
 * Host tools (ADR 0020 §6, `docs/agent-embedding.md` §2): the embedding app's
 * UI effects, declared per request, dispatched to the client that declared
 * them, and answered by the outcome that client reports next.
 */
import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  applyHostOutcomes,
  base64DecodedLength,
  buildHostTools,
  HOST_IMAGE_INVALID_DETAIL,
  HOST_IMAGE_MAX_BYTES,
  HOST_RESULT_STALE,
  HOST_TOOL_DISPATCHED,
  hostAwaitsResults,
  hostImageOf,
  hostOutcomeResult,
  hostResultModelOutput,
  hostToolName,
  parseHostRequest,
  type AwaitedHostTurn,
} from '../host-tools.js';

const APPLY_SEARCH = {
  name: 'apply_search',
  description: 'Show listings for a search on the Explore screen.',
  inputSchema: {
    type: 'object',
    properties: { location: { type: 'string' }, priceMax: { type: 'number' } },
    required: ['location'],
    additionalProperties: false,
  },
};

interface Executable {
  description?: string;
  execute: (
    input: Record<string, unknown>,
    options: { toolCallId: string; abortSignal?: AbortSignal },
  ) => Promise<unknown>;
  inputSchema: { validate?: (value: unknown) => { success: boolean } };
}

describe('parseHostRequest', () => {
  it('accepts a declared app and its tools, and no host at all', () => {
    expect(parseHostRequest(undefined)).toEqual({ ok: true, host: undefined });
    const parsed = parseHostRequest({ app: 'homiio', version: 1, tools: [APPLY_SEARCH] });
    expect(parsed).toMatchObject({ ok: true, host: { app: 'homiio', tools: [APPLY_SEARCH] } });
  });

  it('refuses what would let a client smuggle in more than UI effects', () => {
    const refuse = (host: unknown) => expect(parseHostRequest(host).ok).toBe(false);
    refuse({ app: 'Homiio', version: 1, tools: [] });
    refuse({ app: 'homiio', version: 2, tools: [] });
    refuse({ app: 'homiio', version: 1, tools: [{ ...APPLY_SEARCH, name: 'Apply-Search' }] });
    refuse({ app: 'homiio', version: 1, tools: [APPLY_SEARCH, APPLY_SEARCH] });
    refuse({
      app: 'homiio',
      version: 1,
      tools: [{ ...APPLY_SEARCH, inputSchema: { type: 'string' } }],
    });
    refuse({
      app: 'homiio',
      version: 1,
      tools: Array.from({ length: 17 }, (_, i) => ({ ...APPLY_SEARCH, name: `t${i}` })),
    });
    refuse({ app: 'homiio', version: 1, tools: [], context: { screen: 'explore' } });
    refuse({
      app: 'homiio',
      version: 1,
      tools: [],
      outcomes: [{ toolCallId: 'c', outcome: 'done' }],
    });
  });
});

describe('buildHostTools', () => {
  it('names each tool for its app, dispatches it to the client and answers "dispatched"', async () => {
    const emit = vi.fn();
    const tools = buildHostTools({ app: 'homiio', version: 1, tools: [APPLY_SEARCH] }, { emit });
    const name = hostToolName('homiio', 'apply_search');
    expect(Object.keys(tools)).toEqual([name]);
    const tool = tools[name] as unknown as Executable;
    expect(tool.description).toMatch(/^\[In the app on the person's screen\] Show listings/);
    expect(await tool.execute({ location: 'Gràcia' }, { toolCallId: 'call-1' })).toEqual(
      HOST_TOOL_DISPATCHED,
    );
    expect(emit).toHaveBeenCalledWith('alia.host_action', {
      eventVersion: 1,
      toolCallId: 'call-1',
      app: 'homiio',
      name: 'apply_search',
      input: { location: 'Gràcia' },
    });
  });

  it('validates the model’s input against the declared schema', () => {
    const tools = buildHostTools(
      { app: 'homiio', version: 1, tools: [APPLY_SEARCH] },
      { emit: vi.fn() },
    );
    const tool = tools[hostToolName('homiio', 'apply_search')] as unknown as Executable;
    expect(tool.inputSchema.validate?.({ location: 'Gràcia' }).success).toBe(true);
    expect(tool.inputSchema.validate?.({ priceMax: 1000 }).success).toBe(false);
    expect(tool.inputSchema.validate?.({ location: 'x', extra: true }).success).toBe(false);
  });
});

const READ_TAB = {
  name: 'read_tab',
  description: 'The text of the tab the person is looking at.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  awaitsResult: true as const,
};

describe('awaited host tools', () => {
  const TURN = {
    id: '6f1c2d3e-4b5a-4c6d-8e7f-001122334455',
    authorityKey: 'authority',
    conversationId: null,
  };
  const KEY = { turnId: TURN.id, toolCallId: 'call-9', authorityKey: 'authority' };

  function awaited(answer: Awaited<ReturnType<AwaitedHostTurn['results']['wait']>>) {
    const order: string[] = [];
    const results = {
      open: vi.fn(async () => {
        order.push('open');
      }),
      wait: vi.fn(async () => {
        order.push('wait');
        return answer;
      }),
    };
    return { order, results, turn: { turn: TURN, results } };
  }

  it('accepts `awaitsResult: true` only, and says whether a host declares one', () => {
    const parsed = parseHostRequest({ app: 'astro', version: 1, tools: [READ_TAB] });
    expect(parsed).toMatchObject({ ok: true, host: { tools: [READ_TAB] } });
    expect(parsed.ok && hostAwaitsResults(parsed.host)).toBe(true);
    expect(
      parseHostRequest({ app: 'astro', version: 1, tools: [{ ...READ_TAB, awaitsResult: false }] })
        .ok,
    ).toBe(false);
    expect(
      parseHostRequest({ app: 'astro', version: 1, tools: [{ ...READ_TAB, awaitsResult: 'yes' }] })
        .ok,
    ).toBe(false);
    expect(hostAwaitsResults({ app: 'astro', version: 1, tools: [APPLY_SEARCH] })).toBe(false);
    expect(hostAwaitsResults(undefined)).toBe(false);
  });

  it('is not offered without the turn it answers within', () => {
    const tools = buildHostTools(
      { app: 'astro', version: 1, tools: [APPLY_SEARCH, READ_TAB] },
      { emit: vi.fn() },
    );
    expect(Object.keys(tools)).toEqual([hostToolName('astro', 'apply_search')]);
  });

  it('records the call before the client hears of it, then answers with what the client said', async () => {
    const emit = vi.fn();
    const { order, results, turn } = awaited({
      outcome: 'applied',
      detail: 'Read 2 KB',
      result: { title: 'Docs', text: 'Hello' },
    });
    emit.mockImplementation(() => order.push('emit'));
    const tools = buildHostTools({ app: 'astro', version: 1, tools: [READ_TAB] }, { emit }, turn);
    const tool = tools[hostToolName('astro', 'read_tab')] as unknown as Executable;
    const signal = new AbortController().signal;
    expect(await tool.execute({}, { toolCallId: 'call-9', abortSignal: signal })).toEqual({
      status: 'applied',
      detail: 'Read 2 KB',
      result: { title: 'Docs', text: 'Hello' },
    });
    expect(order).toEqual(['open', 'emit', 'wait']);
    expect(results.open).toHaveBeenCalledWith(KEY);
    expect(results.wait).toHaveBeenCalledWith(KEY, signal);
    expect(emit).toHaveBeenCalledWith('alia.host_action', {
      eventVersion: 1,
      toolCallId: 'call-9',
      app: 'astro',
      name: 'read_tab',
      input: {},
      awaitsResult: true,
      turnId: TURN.id,
    });
  });

  it('tells the model the app did not answer when the wait ends without one', async () => {
    const { turn } = awaited(null);
    const tools = buildHostTools(
      { app: 'astro', version: 1, tools: [READ_TAB] },
      { emit: vi.fn() },
      turn,
    );
    const tool = tools[hostToolName('astro', 'read_tab')] as unknown as Executable;
    expect(await tool.execute({}, { toolCallId: 'call-9' })).toEqual(HOST_RESULT_STALE);
    expect(HOST_RESULT_STALE).toEqual({
      status: 'stale',
      detail: 'The app did not answer in time.',
    });
  });

  it('never dispatches an action it could not record', async () => {
    const emit = vi.fn();
    const { turn, results } = awaited(null);
    results.open.mockRejectedValueOnce(new Error('db down'));
    const tools = buildHostTools({ app: 'astro', version: 1, tools: [READ_TAB] }, { emit }, turn);
    const tool = tools[hostToolName('astro', 'read_tab')] as unknown as Executable;
    expect(await tool.execute({}, { toolCallId: 'call-9' })).toMatchObject({ status: 'failed' });
    expect(emit).not.toHaveBeenCalled();
    expect(results.wait).not.toHaveBeenCalled();
  });

  it('keeps a dispatched tool dispatched beside an awaited one', async () => {
    const emit = vi.fn();
    const { turn, results } = awaited(null);
    const tools = buildHostTools(
      { app: 'astro', version: 1, tools: [APPLY_SEARCH, READ_TAB] },
      { emit },
      turn,
    );
    const tool = tools[hostToolName('astro', 'apply_search')] as unknown as Executable;
    expect(await tool.execute({ location: 'x' }, { toolCallId: 'c' })).toEqual(
      HOST_TOOL_DISPATCHED,
    );
    expect(results.open).not.toHaveBeenCalled();
    expect(emit.mock.calls[0]?.[1]).not.toHaveProperty('awaitsResult');
  });

  it('reads a result in the model’s answer only when there is one', () => {
    expect(hostOutcomeResult({ outcome: 'applied' })).toEqual({ status: 'applied' });
    expect(hostOutcomeResult({ outcome: 'applied', result: 'text' })).toEqual({
      status: 'applied',
      result: 'text',
    });
  });
});

describe('applyHostOutcomes', () => {
  const history: ModelMessage[] = [
    { role: 'user', content: 'muéstrame pisos en Gràcia' },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'host_homiio__apply_search',
          output: { type: 'text', value: JSON.stringify(HOST_TOOL_DISPATCHED) },
        },
      ],
    },
  ];

  it('gives the reported call its real outcome, and leaves everything else alone', () => {
    const applied = applyHostOutcomes(history, [
      { toolCallId: 'call-1', outcome: 'applied' },
      { toolCallId: 'call-unknown', outcome: 'failed' },
    ]);
    expect(applied[0]).toBe(history[0]);
    expect(applied[1]).toEqual({
      role: 'tool',
      content: [
        expect.objectContaining({
          toolCallId: 'call-1',
          output: { type: 'text', value: JSON.stringify({ status: 'applied' }) },
        }),
      ],
    });
    expect(applyHostOutcomes(history, undefined)).toBe(history);
  });
});

describe('an awaited host result that is an image', () => {
  const screenshot = Buffer.from('a jpeg the model should see').toString('base64');

  it('reaches the model as the outcome’s text and the image, never as base64 in JSON', () => {
    const output = hostResultModelOutput(
      hostOutcomeResult({
        outcome: 'applied',
        detail: 'Took a screenshot.',
        result: {
          type: 'image',
          mediaType: 'image/jpeg',
          data: screenshot,
          text: 'The tab, 1024×640.',
        },
      }),
    );
    expect(output).toEqual({
      type: 'content',
      value: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'applied',
            detail: 'Took a screenshot.',
            text: 'The tab, 1024×640.',
          }),
        },
        { type: 'image-data', data: screenshot, mediaType: 'image/jpeg' },
      ],
    });
  });

  it('is reported in text, without its data, when it breaks the rules', () => {
    const marker = Buffer.from('MARKER-BYTES-0123456789').toString('base64');
    for (const result of [
      { type: 'image', mediaType: 'image/tiff', data: marker },
      { type: 'image', mediaType: 'image/png', data: `${marker}!` },
      { type: 'image', mediaType: 'image/png', data: 'A'.repeat(5_000_004) },
      { type: 'image', mediaType: 'image/png' },
    ]) {
      const output = hostResultModelOutput(hostOutcomeResult({ outcome: 'applied', result }));
      expect(output).toEqual({
        type: 'text',
        value: JSON.stringify({ status: 'applied', detail: HOST_IMAGE_INVALID_DETAIL }),
      });
      expect(JSON.stringify(output)).not.toContain(marker);
    }
  });

  it('leaves every other result as the AI SDK sends it', () => {
    expect(hostResultModelOutput(HOST_RESULT_STALE)).toEqual({
      type: 'json',
      value: HOST_RESULT_STALE,
    });
    expect(hostResultModelOutput({ status: 'applied', result: 'the tab text' })).toEqual({
      type: 'json',
      value: { status: 'applied', result: 'the tab text' },
    });
    expect(hostResultModelOutput('plain')).toEqual({ type: 'text', value: 'plain' });
  });

  it('is what the awaited tool hands the model', async () => {
    const turn: AwaitedHostTurn = {
      turn: {
        id: '6f1c2d3e-4b5a-4c6d-8e7f-001122334455',
        authorityKey: 'authority',
        conversationId: null,
      },
      results: {
        open: vi.fn(async () => undefined),
        wait: vi.fn(async () => ({
          outcome: 'applied' as const,
          result: { type: 'image', mediaType: 'image/png', data: screenshot },
        })),
      },
    };
    const tools = buildHostTools(
      { app: 'astro', version: 1, tools: [READ_TAB] },
      { emit: vi.fn() },
      turn,
    );
    const tool = tools[hostToolName('astro', 'read_tab')] as unknown as Executable & {
      toModelOutput: (options: { output: unknown }) => unknown;
    };
    const output = await tool.execute({}, { toolCallId: 'call-1' });
    expect(tool.toModelOutput({ output })).toMatchObject({
      type: 'content',
      value: [{ type: 'text' }, { type: 'image-data', mediaType: 'image/png', data: screenshot }],
    });
  });

  it('checks base64 by counting, exactly at the byte bound', () => {
    expect(base64DecodedLength('AQ==')).toBe(1);
    expect(base64DecodedLength('A'.repeat(5_000_000))).toBe(HOST_IMAGE_MAX_BYTES);
    expect(
      hostImageOf({ type: 'image', mediaType: 'image/png', data: 'A'.repeat(5_000_000) }),
    ).not.toBe('invalid');
    expect(hostImageOf({ type: 'text' })).toBeUndefined();
  });
});
