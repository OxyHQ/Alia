/**
 * Host tools (ADR 0020 §6, `docs/agent-embedding.md` §2): the embedding app's
 * UI effects, declared per request, dispatched to the client that declared
 * them, and answered by the outcome that client reports next.
 */
import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  applyHostOutcomes,
  buildHostTools,
  HOST_TOOL_DISPATCHED,
  hostToolName,
  parseHostRequest,
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
  execute: (input: Record<string, unknown>, options: { toolCallId: string }) => Promise<unknown>;
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
