/**
 * The production turn that failed, end to end through the REAL Kaana adapter,
 * the real tool loader and the real result truncation — only the Oxy client is
 * replaced, and it records the bytes Alia would POST.
 *
 * Production, 2026-10-11 10:43–10:44: a chat turn carried a history in which
 * the previous turn had called `getEmailContext` and three `readEmail`s; the
 * model loaded Inbox's tools with `loadTools` (26 → 47 tools) and read one more email.
 * Every result was already bounded to 20k characters, but the request — system
 * prompt, history, results and 47 schemas — was over Oxy's 126_976-byte input
 * budget, and the edge refused it (`context_length_exceeded`) before any
 * output.
 *
 * Every request below is measured with an independent copy of Oxy's
 * `controlledInputBudget` formula, not with Alia's own function.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText, jsonSchema, stepCountIs, tool, type ModelMessage, type ToolSet } from 'ai';

import aliaHello from './fixtures/alia-hello-21-tools.json';

const oxy = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  script: [] as Array<{
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    text?: string;
  }>,
  warnings: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../logger.js', () => {
  const child = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn((fields: Record<string, unknown>) => {
      oxy.warnings.push(fields);
    }),
  };
  return {
    log: { agents: child, chat: child, general: child, providers: child, tools: child, v1: child },
  };
});

vi.mock('../oxy-inference.js', () => ({
  getOxyInferenceClient: () => ({
    respond: async (request: Record<string, unknown>) => {
      oxy.requests.push(request);
      const next = oxy.script.shift() ?? { toolCalls: [], text: 'done' };
      return {
        requestId: `req-${oxy.requests.length}`,
        model: 'openai/gpt-oss-120b@observed-2026-09-01',
        output: [
          {
            role: 'assistant',
            content: next.text ? [{ type: 'text', text: next.text }] : [],
            toolCalls: next.toolCalls,
          },
        ],
        finishReason: next.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        usage: [
          { unit: 'input_tokens', quantity: 1 },
          { unit: 'output_tokens', quantity: 1 },
        ],
      };
    },
  }),
}));

const { kaanaLanguageModel } = await import('../kaana-language-model.js');
const { budgetTools, LOAD_TOOLS_TOOL } = await import('../../tool-budget.js');
const { wrapToolsWithTruncation } = await import('../../tools/result-truncation.js');
const {
  SERVER_REQUEST_INPUT_LIMIT_BYTES,
  OMITTED_TOOL_RESULT_NOTE,
  RequestInputBudgetExceededError,
} = await import('../request-budget.js');

/** Oxy's `controlledInputBudget` for a Responses completion, copied, not imported. */
function oxyControlledInputBudget(request: Record<string, unknown>): number {
  const messages = request.input as unknown[];
  const tools = (request.tools as unknown[] | undefined) ?? [];
  const payload = JSON.stringify({
    input: { format: 'messages', messages },
    tools,
    toolChoice: request.toolChoice,
    responseFormat: request.responseFormat,
  });
  return Buffer.byteLength(payload, 'utf8') + 256 + 32 * messages.length + 32 * tools.length;
}

const OXY_CEILING = 126_976;
const TRUNCATION_CHARS = 20_000; // what #682 bounds every result to on every surface

/* -------------------------------------------------------------------------- */
/*  The production tool set                                                   */
/* -------------------------------------------------------------------------- */

type FixtureTool = { name: string; description?: string; parameters: Record<string, unknown> };

/** 25 core tools: the real 21 of Alia's Hello request, and four more. */
function coreTools(): ToolSet {
  const tools: ToolSet = {};
  for (const definition of (aliaHello as { tools: FixtureTool[] }).tools) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.parameters as never),
      execute: async () => ({ ok: true }),
    });
  }
  for (const name of ['searchMemory', 'listAgents', 'askAgent', 'useSkill']) {
    tools[name] = tool({
      description: `${name}: a core tool that is always sent.`,
      inputSchema: jsonSchema({ type: 'object', properties: { query: { type: 'string' } } }),
      execute: async () => ({ ok: true }),
    });
  }
  return tools;
}

/**
 * A realistic `readEmail` result: the message and its thread, as HTML and as
 * text, with accents, quotes and line breaks. Large enough that #682's bound
 * (`wrapToolsWithTruncation`, 20k characters) reduces it to its JSON preview,
 * which is the largest a result reaches the model.
 */
function email(id: string): Record<string, unknown> {
  const paragraph =
    'Hola Nate, te escribo sobre la reunión del "martes" — revisé el presupuesto, ' +
    'las cifras de Q4 y la propuesta de diseño. ¿Podemos cerrarlo antes del viernes?\n';
  const body = paragraph.repeat(60);
  return {
    id,
    from: 'Sarah <sarah@example.com>',
    subject: `Re: Planificación ${id}`,
    body,
    html: `<div class="gmail_quote"><p>${body}</p></div>`,
    thread: Array.from({ length: 6 }, (_, n) => ({ from: `Persona ${n}`, body })),
  };
}

/** Inbox: 21 tools, with the schemas an Oxy service publishes. */
function inboxTools(): ToolSet {
  const actions = [
    'getEmailContext',
    'readEmail',
    'searchEmails',
    'listMailboxes',
    'getEmailThread',
    'sendEmail',
    'replyToEmail',
    'forwardEmail',
    'archiveEmail',
    'deleteEmail',
    'markEmailRead',
    'markEmailUnread',
    'moveEmail',
    'listLabels',
    'addLabel',
    'removeLabel',
    'createDraft',
    'updateDraft',
    'sendDraft',
    'listDrafts',
    'getAttachment',
  ];
  const tools: ToolSet = {};
  for (const action of actions) {
    tools[`oxy_inbox__${action}`] = tool({
      description: `[Inbox] ${action} — acts on the person's Oxy Inbox mailbox, threads and messages.`,
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The email, thread or draft id.' },
          mailbox: { type: 'string', description: 'Mailbox id; the inbox when omitted.' },
          query: { type: 'string', description: 'Search terms, Gmail-style operators allowed.' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      }),
      execute: async (args: { id?: string }) =>
        action === 'getEmailContext'
          ? { emails: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map(email) }
          : email(args.id ?? 'e0'),
    });
  }
  return tools;
}

/** Mention: 93 small tools — what pushes the turn past 128 and routes apps. */
function mentionTools(): ToolSet {
  const tools: ToolSet = {};
  for (let n = 0; n < 93; n += 1) {
    tools[`oxy_mention__action${n}`] = tool({
      description: `[Mention] Action ${n}.`,
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async () => ({ ok: true }),
    });
  }
  return tools;
}

/* -------------------------------------------------------------------------- */
/*  The turn                                                                  */
/* -------------------------------------------------------------------------- */

beforeEach(() => {
  oxy.requests.length = 0;
  oxy.script.length = 0;
  oxy.warnings.length = 0;
});

describe('the production turn (getEmailContext + 4 readEmail, 47 tools) now fits', () => {
  it('every step is under Oxy’s ceiling, the newest email reaches the model whole', async () => {
    const inbox = wrapToolsWithTruncation(inboxTools(), TRUNCATION_CHARS);
    const mention = wrapToolsWithTruncation(mentionTools(), TRUNCATION_CHARS);
    const core = wrapToolsWithTruncation(coreTools(), TRUNCATION_CHARS);
    const budgeted = budgetTools({
      tools: { ...core, ...inbox, ...mention },
      sources: { oxy_service: { ...inbox, ...mention }, mcp: {}, integration: {} },
    });
    expect(budgeted.activeToolNames()).toHaveLength(26); // 25 core + loadTools

    // The previous turn's results, as the truncation wrapper bounded them.
    const run = async (name: string, args: Record<string, unknown>) =>
      (inbox[name].execute as (a: unknown, o: unknown) => Promise<unknown>)(args, {
        toolCallId: 'x',
        messages: [],
      });
    const context = await run('oxy_inbox__getEmailContext', {});
    const reads = await Promise.all(
      ['e1', 'e2', 'e3'].map((id) => run('oxy_inbox__readEmail', { id })),
    );
    expect(JSON.stringify(reads[0]).length).toBeLessThanOrEqual(TRUNCATION_CHARS + 200);

    const history: ModelMessage[] = [
      { role: 'user', content: '¿Qué tengo en el correo?' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'h0',
            toolName: 'oxy_inbox__getEmailContext',
            input: {},
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'h0',
            toolName: 'oxy_inbox__getEmailContext',
            output: { type: 'json', value: context as never },
          },
        ],
      },
      {
        role: 'assistant',
        content: ['e1', 'e2', 'e3'].map((id) => ({
          type: 'tool-call' as const,
          toolCallId: `h-${id}`,
          toolName: 'oxy_inbox__readEmail',
          input: { id },
        })),
      },
      {
        role: 'tool',
        content: ['e1', 'e2', 'e3'].map((id, index) => ({
          type: 'tool-result' as const,
          toolCallId: `h-${id}`,
          toolName: 'oxy_inbox__readEmail',
          output: { type: 'json' as const, value: reads[index] as never },
        })),
      },
      { role: 'assistant', content: 'Tienes tres correos de Sarah sobre la planificación.' },
      { role: 'user', content: 'Lee también el cuarto y dime qué pide.' },
    ];

    oxy.script.push(
      {
        toolCalls: [
          {
            id: 'c-apps',
            name: LOAD_TOOLS_TOOL,
            arguments: JSON.stringify({ names: Object.keys(inbox) }),
          },
        ],
      },
      {
        toolCalls: [{ id: 'c-e4', name: 'oxy_inbox__readEmail', arguments: '{"id":"e4"}' }],
      },
      { toolCalls: [], text: 'Sarah pide cerrar el presupuesto antes del viernes.' },
    );

    const result = await generateText({
      model: kaanaLanguageModel({
        target: { kind: 'routingProfile', routingProfile: 'auto' },
        modelId: 'auto',
        surface: 'chat',
      }),
      system:
        (aliaHello as { input: Array<{ content: Array<{ text: string }> }> }).input[0].content[0]
          .text + budgeted.appCatalogPrompt,
      messages: history,
      tools: budgeted.tools,
      ...budgeted.routing,
      stopWhen: stepCountIs(5),
    });

    expect(result.text).toBe('Sarah pide cerrar el presupuesto antes del viernes.');
    expect(oxy.requests).toHaveLength(3);
    for (const request of oxy.requests) {
      expect(oxyControlledInputBudget(request)).toBeLessThanOrEqual(
        SERVER_REQUEST_INPUT_LIMIT_BYTES,
      );
      expect(oxyControlledInputBudget(request)).toBeLessThan(OXY_CEILING);
    }

    // The last step is the one that failed in production: 47 tools, 5 reads.
    const last = oxy.requests[2] as {
      tools: unknown[];
      input: Array<{ role: string; toolCallId?: string; content: Array<{ text: string }> }>;
    };
    expect(last.tools).toHaveLength(47);
    const newest = last.input.at(-1);
    expect(newest?.toolCallId).toBe('c-e4');
    expect(newest?.content[0].text).toContain('Planificación e4');
    expect(last.input.some((m) => m.content[0]?.text === OMITTED_TOOL_RESULT_NOTE)).toBe(true);
    // The question and the system prompt are both still there.
    expect(last.input[0].role).toBe('system');
    expect(
      last.input.some((m) => m.content[0]?.text === 'Lee también el cuarto y dime qué pide.'),
    ).toBe(true);

    // As built, that request was over Oxy's ceiling: this is the production failure.
    const shrunk = oxy.warnings.filter(
      (w) => w.surface === 'chat' && typeof w.measuredBytes === 'number',
    );
    // Both steps after Inbox opened (47 tools) were over it; the oldest results
    // went first and no history turn had to be dropped.
    expect(shrunk).toHaveLength(2);
    for (const step of shrunk) {
      expect(step.measuredBytes as number).toBeGreaterThan(OXY_CEILING);
      expect(step).toMatchObject({ tools: 47, droppedMessages: 0 });
    }
    expect(shrunk.map((step) => step.omittedToolResults)).toEqual([1, 2]);
  });
});

describe('a request that cannot fit is never sent', () => {
  const model = () =>
    kaanaLanguageModel({
      target: { kind: 'model', model: 'openai/gpt-oss-120b' },
      modelId: 'openai/gpt-oss-120b',
      surface: 'chat',
    });
  const pasted = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: `Resume esto: ${'ñ'.repeat(70_000)}` }],
    },
  ];

  it('generate: a typed context_length_exceeded, and no request reaches Oxy', async () => {
    const call = model().doGenerate({ prompt: pasted } as never);
    await expect(call).rejects.toBeInstanceOf(RequestInputBudgetExceededError);
    await expect(call).rejects.toMatchObject({ code: 'context_length_exceeded', retryable: false });
    expect(oxy.requests).toHaveLength(0);
  });

  it('stream: refused the same way', async () => {
    await expect(model().doStream({ prompt: pasted } as never)).rejects.toBeInstanceOf(
      RequestInputBudgetExceededError,
    );
    expect(oxy.requests).toHaveLength(0);
  });
});
