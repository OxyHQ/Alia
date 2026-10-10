/**
 * The seam guard (`tool-limit.ts`) and the budget end to end, through the REAL
 * Kaana adapter with only the Oxy client replaced.
 *
 * The production refusal came from the Oxy edge: `tools` max 128, a request with
 * 143. These tests read the bytes the adapter would POST — `request.tools` — so
 * "the request stays within the limit" is measured where the edge measures it,
 * not on an object Alia built on the way.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText, stepCountIs, tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';

const oxy = vi.hoisted(() => ({
  requests: [] as Array<{ tools?: Array<{ name: string }> }>,
  /** One scripted response per `respond` call, in order. */
  script: [] as Array<Record<string, unknown>>,
}));

vi.mock('../oxy-inference.js', () => ({
  getOxyInferenceClient: () => ({
    respond: async (request: { tools?: Array<{ name: string }> }) => {
      oxy.requests.push(request);
      const next = oxy.script.shift() ?? { toolCalls: [], text: 'done' };
      return {
        requestId: `req-${oxy.requests.length}`,
        model: 'openai/gpt-6-luna@2026-09-01',
        output: [
          {
            role: 'assistant',
            content: next.text ? [{ type: 'text', text: next.text }] : [],
            toolCalls: next.toolCalls,
          },
        ],
        finishReason: (next.toolCalls as unknown[]).length > 0 ? 'tool_calls' : 'stop',
        usage: [
          { unit: 'input_tokens', quantity: 1 },
          { unit: 'output_tokens', quantity: 1 },
        ],
      };
    },
    stream: (request: { tools?: Array<{ name: string }> }) => {
      oxy.requests.push(request);
      return (async function* () {
        yield { type: 'done', finishReason: 'stop' };
      })();
    },
  }),
}));

const { kaanaLanguageModel } = await import('../kaana-language-model.js');
const { ToolLimitExceededError, MAX_TOOLS_PER_INFERENCE_REQUEST, toolFamilyCounts } = await import(
  '../tool-limit.js'
);
const { budgetTools, USE_APPS_TOOL } = await import('../../tool-budget.js');
const { toAliaError } = await import('../../errors/failover-error.js');

const model = () =>
  kaanaLanguageModel({
    target: { kind: 'model', model: 'openai/gpt-6-luna' },
    modelId: 'openai/gpt-6-luna',
    surface: 'chat',
  });

function functionTools(count: number, prefix = 'oxy_mention__t') {
  return Array.from({ length: count }, (_, n) => ({
    type: 'function' as const,
    name: `${prefix}${n}`,
    inputSchema: { type: 'object', properties: {} },
  }));
}

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hola' }] }];

beforeEach(() => {
  oxy.requests.length = 0;
  oxy.script.length = 0;
});

describe('the seam refuses what the edge would refuse, before sending', () => {
  it('129 tools: a typed invalid_request, and no request reaches Oxy', async () => {
    const call = model().doGenerate({ prompt, tools: functionTools(129) } as never);
    await expect(call).rejects.toBeInstanceOf(ToolLimitExceededError);
    await expect(call).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      param: 'tools',
      retryable: false,
    });
    expect(oxy.requests).toHaveLength(0);
  });

  it('the streaming path refuses the same way', async () => {
    await expect(
      model().doStream({ prompt, tools: functionTools(143) } as never),
    ).rejects.toBeInstanceOf(ToolLimitExceededError);
    expect(oxy.requests).toHaveLength(0);
  });

  it('128 tools are sent — the control, at the exact limit', async () => {
    await model().doGenerate({
      prompt,
      tools: functionTools(MAX_TOOLS_PER_INFERENCE_REQUEST),
    } as never);
    expect(oxy.requests).toHaveLength(1);
    expect(oxy.requests[0].tools).toHaveLength(128);
  });

  it("reads to the product as the edge's own invalid_request would: not retryable", () => {
    const productError = toAliaError(new ToolLimitExceededError({ toolCount: 143 }));
    expect(productError.retryable).toBe(false);
  });

  it('logs the families, largest first, so the grown catalogue is named', () => {
    expect(
      toolFamilyCounts([
        ...functionTools(93, 'oxy_mention__').map((t) => t.name),
        ...functionTools(12, 'oxy_noted__').map((t) => t.name),
        'getCurrentDate',
      ]),
    ).toEqual({ oxy_mention: 93, oxy_noted: 12, other: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/*  End to end: the production mix through generateText and the adapter      */
/* -------------------------------------------------------------------------- */

function appTool(
  label: string,
  run: (args: { text: string }) => unknown = (args) => ({ ok: true, args }),
): Tool {
  return tool({
    description: `[${label}] does something.`,
    inputSchema: z.object({ text: z.string() }),
    execute: vi.fn(async (args: { text: string }) => run(args)),
  });
}

function productionMix() {
  const oxyServices: ToolSet = {};
  const add = (prefix: string, label: string, count: number) => {
    for (let n = 0; n < count; n += 1) oxyServices[`${prefix}__a${n}`] = appTool(label);
  };
  add('oxy_mention', 'Mention', 92);
  oxyServices.oxy_mention__createPost = appTool('Mention');
  add('oxy_noted', 'Noted', 12);
  add('oxy_inbox', 'Inbox', 11);
  add('oxy_mercaria', 'Mercaria', 3);
  const core: ToolSet = {};
  for (const name of ['getCurrentDate', 'generateFile', 'canvas', 'webSearch']) {
    core[name] = tool({ description: name, inputSchema: z.object({}), execute: async () => name });
  }
  for (let n = 0; n < 20; n += 1)
    core[`builtin${n}`] = tool({ description: 'core', inputSchema: z.object({}) });
  return { tools: { ...core, ...oxyServices }, oxyServices };
}

describe('the production turn, end to end', () => {
  it('opens Mention on request and runs its tool directly, never sending more than 128', async () => {
    const { tools, oxyServices } = productionMix();
    expect(Object.keys(tools)).toHaveLength(143);
    const budgeted = budgetTools({
      tools,
      sources: { oxy_service: oxyServices, mcp: {}, integration: {} },
    });

    oxy.script.push(
      {
        toolCalls: [
          { id: 'c1', name: USE_APPS_TOOL, arguments: JSON.stringify({ apps: ['mention'] }) },
        ],
      },
      {
        toolCalls: [
          {
            id: 'c2',
            name: 'oxy_mention__createPost',
            arguments: JSON.stringify({ text: 'hola' }),
          },
        ],
      },
      { toolCalls: [], text: 'Posted.' },
    );

    const result = await generateText({
      model: model(),
      prompt: 'Post "hola" on Mention',
      tools: budgeted.tools,
      ...budgeted.routing,
      stopWhen: stepCountIs(5),
    });

    const sent = oxy.requests.map((request) => (request.tools ?? []).map((t) => t.name));
    expect(sent).toHaveLength(3);
    for (const names of sent)
      expect(names.length).toBeLessThanOrEqual(MAX_TOOLS_PER_INFERENCE_REQUEST);

    // Step 1: the router and the core, no Mention.
    expect(sent[0]).toContain(USE_APPS_TOOL);
    expect(sent[0].filter((name) => name.startsWith('oxy_mention__'))).toEqual([]);
    // Step 2: exactly Mention's 93 joined.
    expect(sent[1].filter((name) => name.startsWith('oxy_mention__'))).toHaveLength(93);
    expect(sent[1].filter((name) => !sent[0].includes(name))).toHaveLength(93);

    // The model called the REAL tool, and its own execute ran with its input.
    expect(oxyServices.oxy_mention__createPost.execute).toHaveBeenCalledTimes(1);
    expect(oxyServices.oxy_mention__createPost.execute).toHaveBeenCalledWith(
      { text: 'hola' },
      expect.anything(),
    );
    expect(result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName))).toEqual([
      USE_APPS_TOOL,
      'oxy_mention__createPost',
    ]);
    expect(result.text).toBe('Posted.');
  });

  it('the same turn without the budget is what production sent — the control', async () => {
    const { tools } = productionMix();
    await expect(generateText({ model: model(), prompt: 'hola', tools })).rejects.toThrow(
      /at most 128/,
    );
    expect(oxy.requests).toHaveLength(0);
  });
});
