/**
 * The per-request tool budget and the tool loader (`lib/tool-budget.ts`).
 *
 * The production failure (2026-09-30, Ref
 * `chatcmpl-f9ff8f2a-ace7-4b64-935f-038b56c79540`): a turn assembled 143 tools —
 * `oxy_mention__*` 93, `oxy_noted__*` 12, `oxy_inbox__*` 11, `oxy_mercaria__*` 3,
 * plus built-ins — and the Oxy edge refused the request (`tools` max 128). The
 * fixtures below are that mix, so "fits" is measured against the set that broke.
 *
 * Every property is asserted beside a control that would fail if the property
 * were produced by accident: a small account that is NOT routed, a pick that
 * DOES fit, a history with nothing in it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSchema, tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      agents: child,
      chat: child,
      general: child,
      v1: child,
      providers: child,
      codea: child,
      tools: child,
    },
  };
});
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));

/** What each mocked source hands back, set per test. */
const sources = vi.hoisted(() => ({
  oxy: {} as Record<string, unknown>,
  mcp: {} as Record<string, unknown>,
  mcpAsked: [] as (readonly string[] | undefined)[],
}));

vi.mock('../tools/oxy-services.js', () => ({
  buildOxyServiceTools: vi.fn(async () => sources.oxy),
  getOxyServicePromptFragment: vi.fn(
    () => '\n\n## Oxy apps\n- **Inbox**: oxy_inbox__searchEmails.',
  ),
  getOxyServiceContext: vi.fn(async () => ''),
}));
vi.mock('../tools/mcp.js', () => ({
  buildMcpTools: vi.fn(async (_userId: string, ids?: readonly string[]) => {
    sources.mcpAsked.push(ids);
    // A picked connector narrows the fetch to that server, as the real source does.
    return ids === undefined || ids.includes('srv-github') ? sources.mcp : {};
  }),
}));
vi.mock('../tools/integrations.js', () => ({ buildIntegrationTools: vi.fn(async () => ({})) }));
vi.mock('../tools/ask-agent.js', () => ({ buildAskAgentTool: vi.fn(async () => ({})) }));

const { budgetTools, stickyToolsFrom, appsOf, coversOf, sentToolBytes, LOAD_TOOLS_TOOL } =
  await import('../tool-budget.js');
const { ToolPipeline } = await import('../tool-pipeline.js');
const { ToolLimitExceededError, MAX_TOOLS_PER_INFERENCE_REQUEST } = await import(
  '../inference/tool-limit.js'
);
const { SystemPromptBuilder } = await import('../system-prompt-builder.js');
const { requestInputBudgetBytes, toolDefinitionsBudgetBytes } = await import(
  '../inference/request-budget.js'
);
const { priorToolCallsOf } = await import('../message-converter.js');

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function appTool(label: string, action: string): Tool {
  return tool({
    description: `[${label}] ${action}.`,
    inputSchema: z.object({ text: z.string() }),
    execute: vi.fn(async (args: { text: string }) => ({ ok: true, action, args })),
  });
}

/** `count` tools named `<prefix>__action<N>`, labelled like the real source labels them. */
function family(prefix: string, label: string, count: number): ToolSet {
  const tools: ToolSet = {};
  for (let n = 0; n < count; n += 1)
    tools[`${prefix}__action${String(n).padStart(2, '0')}`] = appTool(label, `action ${n}`);
  return tools;
}

/** Inbox's real catalog tool names (OxyHQServices `inbox.catalog.ts`): 11. */
const INBOX_TOOLS = [
  'searchEmails',
  'getUnreadEmails',
  'readEmail',
  'getEmailThread',
  'sendEmail',
  'listMailboxes',
  'listLabels',
  'moveEmail',
  'updateEmailFlags',
  'getEmailQuota',
  'getEmailContext',
] as const;

function inbox(): ToolSet {
  return Object.fromEntries(
    INBOX_TOOLS.map((name) => [`oxy_inbox__${name}`, appTool('Inbox', name)]),
  );
}

/** The production mix's Oxy services: 93 + 12 + 11 + 3 = 119. */
function productionOxyServices(): ToolSet {
  const mention = family('oxy_mention', 'Mention', 93);
  // One real-looking name, so a test can call something recognisable.
  delete mention.oxy_mention__action00;
  mention.oxy_mention__createPost = appTool('Mention', 'Create a post');
  return {
    ...mention,
    ...family('oxy_noted', 'Noted', 12),
    ...inbox(),
    ...family('oxy_mercaria', 'Mercaria', 3),
  };
}

/** `count` core tools (built-ins, runtime, editor — anything that is not an app). */
function core(count: number): ToolSet {
  const tools: ToolSet = {};
  for (let n = 0; n < count; n += 1)
    tools[`builtin${n}`] = tool({ description: 'core', inputSchema: z.object({}) });
  return tools;
}

/** The production turn: 24 built-ins + 119 Oxy service tools = 143. */
function productionTurn() {
  const oxy = productionOxyServices();
  const tools = { ...core(24), ...oxy };
  return { tools, sources: { oxy_service: oxy, mcp: {}, integration: {} } };
}

/** Call `loadTools` the way the AI SDK does. */
async function load(
  budgeted: ReturnType<typeof budgetTools>,
  input: { names?: string[]; query?: string; limit?: number; unload?: string[] },
) {
  const loadTools = budgeted.tools[LOAD_TOOLS_TOOL];
  return (await loadTools.execute?.(
    input as never,
    { toolCallId: 't', messages: [] } as never,
  )) as Record<string, any>;
}

const activeOf = (budgeted: ReturnType<typeof budgetTools>) =>
  budgeted.routing.prepareStep?.().activeTools ?? [];

const mentionNames = (names: readonly string[]) =>
  names.filter((name) => name.startsWith('oxy_mention__'));

/** `count` tools of `bytes` description bytes each, so a set can be too heavy to send whole. */
function heavy(prefix: string, label: string, count: number, bytes: number): ToolSet {
  const tools: ToolSet = {};
  for (let n = 0; n < count; n += 1)
    tools[`${prefix}__action${String(n).padStart(2, '0')}`] = tool({
      description: `[${label}] ${'x'.repeat(bytes)}`,
      inputSchema: z.object({ text: z.string() }),
      execute: vi.fn(async () => ({ ok: true })),
    });
  return tools;
}

/* -------------------------------------------------------------------------- */
/*  The budget                                                                */
/* -------------------------------------------------------------------------- */

describe('the production mix fits the budget without losing a tool', () => {
  it('reproduces the failing turn: 143 tools, more than one request carries', () => {
    const { tools } = productionTurn();
    expect(Object.keys(tools)).toHaveLength(143);
    expect(Object.keys(tools).length).toBeGreaterThan(MAX_TOOLS_PER_INFERENCE_REQUEST);
  });

  it('sends at most 128 on the first step: core tools, the loader, and no app tools', () => {
    const turn = productionTurn();
    const budgeted = budgetTools(turn);
    const first = activeOf(budgeted);

    expect(first.length).toBeLessThanOrEqual(MAX_TOOLS_PER_INFERENCE_REQUEST);
    expect(budgeted.routing.activeTools).toEqual(first);
    for (const name of Object.keys(core(24))) expect(first).toContain(name);
    expect(first).toContain(LOAD_TOOLS_TOOL);
    expect(first.filter((name) => name.startsWith('oxy_'))).toEqual([]);
  });

  it('keeps every original tool registered, as the SAME object the source built', () => {
    const turn = productionTurn();
    const budgeted = budgetTools(turn);
    for (const [name, built] of Object.entries(turn.tools)) {
      // Identity, not equality: the execute the SDK runs is the assembler's own,
      // so authorization, policy and truncation cannot differ from a direct call.
      expect(budgeted.tools[name]).toBe(built);
    }
    expect(Object.keys(budgeted.tools)).toHaveLength(144);
  });

  it('lists every app with its tool count and EVERY tool name, but no definition', () => {
    const budgeted = budgetTools(productionTurn());
    expect(budgeted.appCatalogPrompt).toContain("## Tools from the person's apps");
    expect(budgeted.appCatalogPrompt).toContain('- mention — Mention (93 tools)');
    expect(budgeted.appCatalogPrompt).toContain('- noted — Noted (12 tools)');
    expect(budgeted.appCatalogPrompt).toContain('- inbox — Inbox (11 tools): email, ');
    expect(budgeted.appCatalogPrompt).toContain('- mercaria — Mercaria (3 tools)');
    for (const name of Object.keys(productionOxyServices())) {
      const [, action] = name.split('__');
      expect(budgeted.appCatalogPrompt).toContain(action);
    }
    // The prefix is said once per app, not once per tool.
    expect(budgeted.appCatalogPrompt).toContain('prefix `oxy_mention__`');
    expect(budgeted.appCatalogPrompt).not.toContain('oxy_mention__action01');
    // A definition would carry the tool's description.
    expect(budgeted.appCatalogPrompt).not.toContain('[Mention] action 1.');
  });
});

describe('loadTools loads the tools asked for, from the next step', () => {
  it('loads exactly the named tools and nothing else of their app', async () => {
    const budgeted = budgetTools(productionTurn());
    const before = activeOf(budgeted);

    const result = await load(budgeted, {
      names: ['oxy_mention__createPost', 'oxy_inbox__readEmail'],
    });
    const after = activeOf(budgeted);

    expect(result.loaded.map((entry: { name: string }) => entry.name)).toEqual([
      'oxy_mention__createPost',
      'oxy_inbox__readEmail',
    ]);
    expect(after.filter((name) => !before.includes(name)).sort()).toEqual([
      'oxy_inbox__readEmail',
      'oxy_mention__createPost',
    ]);
    expect(before.every((name) => after.includes(name))).toBe(true);
    expect(result.note).toMatch(/next step/);
  });

  it('accepts the bare name the catalogue lists under the app prefix', async () => {
    const budgeted = budgetTools(productionTurn());
    const result = await load(budgeted, { names: ['createPost', 'READEMAIL'] });
    expect(result.loaded.map((entry: { name: string }) => entry.name)).toEqual([
      'oxy_mention__createPost',
      'oxy_inbox__readEmail',
    ]);
  });

  it('says what it already had instead of loading it twice', async () => {
    const budgeted = budgetTools(productionTurn());
    await load(budgeted, { names: ['oxy_inbox__readEmail'] });
    const again = await load(budgeted, { names: ['oxy_inbox__readEmail', 'builtin0'] });
    expect(again.loaded).toEqual([]);
    expect(again.alreadyLoaded).toEqual(['oxy_inbox__readEmail', 'builtin0']);
    expect(activeOf(budgeted).filter((name) => name === 'oxy_inbox__readEmail')).toHaveLength(1);
  });

  it('names an unknown tool with the nearest ones instead of guessing', async () => {
    const budgeted = budgetTools(productionTurn());
    const result = await load(budgeted, { names: ['nope', 'Email'] });
    expect(result.unknown[0]).toEqual({ name: 'nope' });
    expect(result.unknown[1].didYouMean).toContain('oxy_inbox__readEmail');
    expect(result.loaded).toEqual([]);
    expect(activeOf(budgeted).filter((name) => name.startsWith('oxy_'))).toEqual([]);
  });

  it('asks for something when called with nothing', async () => {
    const result = await load(budgetTools(productionTurn()), {});
    expect(String(result.hint)).toMatch(/Nothing was asked/);
  });

  it('never carries more than a request can, however much is asked for', async () => {
    const budgeted = budgetTools(productionTurn());
    await load(budgeted, { names: Object.keys(productionOxyServices()) });
    expect(activeOf(budgeted).length).toBeLessThanOrEqual(MAX_TOOLS_PER_INFERENCE_REQUEST);
  });
});

describe('an app too big to send whole is still fully usable (the useApps loop)', () => {
  /**
   * Production 2026-10: `useApps(["mention"])` answered `didNotFit` forever.
   * Mention has 94 tools, the core already took ~25.8KB of a 61_440-byte
   * definitions budget, and the old design opened WHOLE apps only.
   */
  const mention = heavy('oxy_mention', 'Mention', 94, 700);
  const turn = {
    tools: { ...core(27), ...mention },
    sources: { oxy_service: mention, mcp: {}, integration: {} },
  };

  it('the whole app really exceeds the definitions budget — the premise', () => {
    const bytes = Object.entries(mention).reduce(
      (sum, [name, built]) => sum + sentToolBytes(name, built),
      0,
    );
    expect(bytes).toBeGreaterThan(61_440);
  });

  it('loads the tools the request needs, whatever the size of their app', async () => {
    const budgeted = budgetTools(turn);
    const result = await load(budgeted, {
      names: ['oxy_mention__action03', 'oxy_mention__action41'],
    });
    expect(result.loaded).toHaveLength(2);
    expect(result.notLoaded).toBeUndefined();
    expect(mentionNames(activeOf(budgeted))).toEqual([
      'oxy_mention__action03',
      'oxy_mention__action41',
    ]);
  });

  it('keeps loading until the budget is reached, then says what to close', async () => {
    const budgeted = budgetTools(turn);
    const result = await load(budgeted, { names: Object.keys(mention) });

    expect(result.loaded.length).toBeGreaterThan(10);
    expect(result.loaded.length).toBeLessThan(94);
    expect(result.notLoaded.length).toBe(94 - result.loaded.length);
    expect(result.notLoaded[0]).toMatchObject({ reason: 'size_limit' });
    // Actionable: names what to unload, and how much room is left.
    expect(result.unloadCandidates.length).toBeGreaterThan(0);
    expect(String(result.hint)).toMatch(/Unload tools you are done with/);
    expect(result.capacity.definitionBytes).toBeLessThanOrEqual(result.capacity.maxDefinitionBytes);

    // Unloading makes room for exactly what was refused.
    const refused = result.notLoaded[0].name as string;
    const retry = await load(budgeted, {
      unload: result.unloadCandidates.slice(0, 3),
      names: [refused],
    });
    expect(retry.unloaded).toHaveLength(3);
    expect(retry.loaded.map((entry: { name: string }) => entry.name)).toEqual([refused]);
    const bytes = budgeted
      .activeToolNames()
      .reduce((sum, name) => sum + sentToolBytes(name, budgeted.tools[name]), 0);
    expect(bytes).toBeLessThanOrEqual(61_440);
  });

  it('a tool that can never fit says so instead of asking to close others', async () => {
    const giant = { ...heavy('oxy_giant', 'Giant', 1, 70_000), ...mention };
    const budgeted = budgetTools({
      tools: { ...core(27), ...giant },
      sources: { oxy_service: giant, mcp: {}, integration: {} },
    });
    const result = await load(budgeted, { names: ['oxy_giant__action00'] });
    expect(result.notLoaded).toEqual([
      { name: 'oxy_giant__action00', reason: 'too_large', bytes: expect.any(Number) },
    ]);
    expect(String(result.hint)).toMatch(/cannot be loaded on this model/);
    expect(result.unloadCandidates).toBeUndefined();
  });

  it('refuses by count with its own reason when the 128 limit is what binds', async () => {
    const oxy = family('oxy_app', 'App', 110);
    const budgeted = budgetTools({
      tools: { ...core(20), ...oxy },
      sources: { oxy_service: oxy, mcp: {}, integration: {} },
    });
    const result = await load(budgeted, { names: Object.keys(oxy) });
    expect(result.loaded).toHaveLength(107);
    expect(result.notLoaded.map((entry: { reason: string }) => entry.reason)).toEqual([
      'tool_limit',
      'tool_limit',
      'tool_limit',
    ]);
  });
});

describe('the definitions budget is derived from the model', () => {
  const mention = heavy('oxy_mention', 'Mention', 94, 700);
  const turn = {
    tools: { ...core(27), ...mention },
    sources: { oxy_service: mention, mcp: {}, integration: {} },
  };
  const loadedFor = async (inputBudgetBytes: number) => {
    const budgeted = budgetTools({ ...turn, inputBudgetBytes });
    await load(budgeted, { names: Object.keys(mention) });
    return mentionNames(activeOf(budgeted)).length;
  };

  it('a larger request budget lets more definitions in, a smaller one fewer', async () => {
    const small = await loadedFor(
      requestInputBudgetBytes({ contextWindow: 32_768, maxOutput: 4_096 }),
    );
    const server = await loadedFor(requestInputBudgetBytes({ contextWindow: 1_000_000 }));
    expect(small).toBeLessThan(server);
    expect(server).toBeGreaterThan(0);
  });

  it('the tools take their share of the model-derived budget, not a fixed byte count', () => {
    const budget = requestInputBudgetBytes({ contextWindow: 1_000_000 });
    expect(budget).toBe(122_880);
    const budgeted = budgetTools({ ...turn, inputBudgetBytes: budget });
    const bytes = budgeted
      .activeToolNames()
      .reduce((sum, name) => sum + sentToolBytes(name, budgeted.tools[name]), 0);
    expect(bytes).toBeLessThanOrEqual(toolDefinitionsBudgetBytes(budget));
  });
});

describe('loadTools finds tools by intent', () => {
  it('loads the best matches for a query, by tool name first', async () => {
    const budgeted = budgetTools(productionTurn());
    const result = await load(budgeted, { query: 'read an email' });
    const names = result.loaded.map((entry: { name: string }) => entry.name);
    expect(names[0]).toBe('oxy_inbox__readEmail');
    expect(names.every((name: string) => name.startsWith('oxy_inbox__'))).toBe(true);
    expect(result.searched).toMatchObject({ query: 'read an email' });
    expect(activeOf(budgeted)).toContain('oxy_inbox__readEmail');
  });

  it('a query for an app loads its tools up to `limit`, never the whole app', async () => {
    const budgeted = budgetTools(productionTurn());
    const result = await load(budgeted, { query: 'noted', limit: 4 });
    expect(result.loaded).toHaveLength(4);
    expect(result.loaded.every((e: { name: string }) => e.name.startsWith('oxy_noted__'))).toBe(
      true,
    );
  });

  it('says so when nothing matches, and loads nothing', async () => {
    const budgeted = budgetTools(productionTurn());
    const result = await load(budgeted, { query: 'zzzqqq' });
    expect(result.loaded).toEqual([]);
    expect(result.searched.matches).toEqual([]);
    expect(String(result.hint)).toMatch(/No tool matches/);
  });

  it('matches plurals and the app name', async () => {
    const budgeted = budgetTools(productionTurn());
    const result = await load(budgeted, { query: 'mailboxes inbox', limit: 2 });
    expect(result.loaded[0].name).toBe('oxy_inbox__listMailboxes');
  });
});

describe("a turn that fits keeps today's behaviour", () => {
  it('a small account is not routed: every tool, every step, no loader tool', () => {
    const oxy = family('oxy_noted', 'Noted', 12);
    const tools = { ...core(24), ...oxy };
    const budgeted = budgetTools({
      tools,
      sources: { oxy_service: oxy, mcp: {}, integration: {} },
    });

    expect(budgeted.tools).toBe(tools);
    expect(budgeted.routing).toEqual({});
    expect(budgeted.appCatalogPrompt).toBe('');
    expect(budgeted.tools[LOAD_TOOLS_TOOL]).toBeUndefined();
  });

  it("routes at 129 and not at 128 — the threshold is the edge's own", () => {
    const at = (total: number) => {
      const oxy = family('oxy_app', 'App', total - 20);
      return budgetTools({
        tools: { ...core(20), ...oxy },
        sources: { oxy_service: oxy, mcp: {}, integration: {} },
      });
    };
    expect(at(128).routing).toEqual({});
    expect(at(129).routing.activeTools).toBeDefined();
  });
});

describe('explicit picks are loaded from the first step and never unloaded', () => {
  it('a picked app is loaded before the model asks, and cannot be unloaded', async () => {
    const budgeted = budgetTools({ ...productionTurn(), pins: ['mention'] });
    const first = budgeted.routing.activeTools ?? [];
    expect(mentionNames(first)).toHaveLength(93);

    const result = await load(budgeted, { unload: ['oxy_mention__createPost'] });
    expect(result.keptLoaded).toEqual(['oxy_mention__createPost']);
    expect(mentionNames(activeOf(budgeted))).toHaveLength(93);
  });

  it('a picked single tool loads that tool alone, not its app', () => {
    const budgeted = budgetTools({ ...productionTurn(), pins: ['oxy_mention__createPost'] });
    expect(mentionNames(budgeted.routing.activeTools ?? [])).toEqual(['oxy_mention__createPost']);
  });

  it('picks that do not all fit never fail the turn: what fits loads, the rest stays loadable', async () => {
    // 24 + 1 + 93 + 12 = 130: the old design refused this with a typed 400.
    const budgeted = budgetTools({ ...productionTurn(), pins: ['mention', 'noted'] });
    const first = budgeted.routing.activeTools ?? [];
    expect(first.length).toBeLessThanOrEqual(MAX_TOOLS_PER_INFERENCE_REQUEST);
    expect(mentionNames(first)).toHaveLength(93);
    const missing = Object.keys(productionOxyServices()).filter(
      (name) => name.startsWith('oxy_noted__') && !first.includes(name),
    );
    expect(missing.length).toBeGreaterThan(0);
    // ...and a missing one is still named in the catalogue and loadable.
    expect(budgeted.appCatalogPrompt).toContain('- noted — Noted (12 tools)');
    const result = await load(budgeted, { names: [missing[0]] });
    expect(result.notLoaded?.[0]).toMatchObject({ name: missing[0], reason: 'picks_fill_request' });
    expect(result.unloadCandidates ?? []).toEqual([]);
  });

  it('picks that all fit are all loaded — the control', () => {
    const budgeted = budgetTools({ ...productionTurn(), pins: ['mention', 'mercaria'] });
    const first = budgeted.routing.activeTools ?? [];
    expect(mentionNames(first)).toHaveLength(93);
    expect(first.filter((name) => name.startsWith('oxy_mercaria__'))).toHaveLength(3);
  });
});

describe('tools used earlier in the conversation stay loaded', () => {
  it('reloads the tools the history called, and only those', () => {
    const budgeted = budgetTools({
      ...productionTurn(),
      priorToolCalls: [
        { toolName: 'oxy_noted__action01', args: {} },
        { toolName: 'oxy_inbox__readEmail', args: { text: 'x' } },
      ],
    });
    const first = budgeted.routing.activeTools ?? [];
    expect(first).toEqual(expect.arrayContaining(['oxy_noted__action01', 'oxy_inbox__readEmail']));
    // Only what was used: the rest of their apps is not dragged in.
    expect(first.filter((name) => name.startsWith('oxy_noted__'))).toHaveLength(1);
    expect(first.filter((name) => name.startsWith('oxy_inbox__'))).toHaveLength(1);
    expect(mentionNames(first)).toEqual([]);
  });

  it('a tool loaded but never called is not sticky', () => {
    const budgeted = budgetTools({
      ...productionTurn(),
      priorToolCalls: [
        {
          toolName: LOAD_TOOLS_TOOL,
          args: { names: ['oxy_noted__action01'] },
          result: { loaded: [{ name: 'oxy_noted__action01' }] },
        },
      ],
    });
    expect(budgeted.routing.activeTools).not.toContain('oxy_noted__action01');
  });

  it('a tool unloaded later in the conversation stays unloaded', () => {
    const deferred = new Set(['oxy_noted__a', 'oxy_inbox__b']);
    expect(
      stickyToolsFrom(deferred, [
        { toolName: 'oxy_noted__a' },
        { toolName: 'oxy_inbox__b' },
        { toolName: LOAD_TOOLS_TOOL, result: { unloaded: ['oxy_noted__a'] } },
      ]),
    ).toEqual(['oxy_inbox__b']);
  });

  it('loads nothing for a conversation with no history — the control', () => {
    const first = budgetTools(productionTurn()).routing.activeTools ?? [];
    expect(first.filter((name) => name.startsWith('oxy_'))).toEqual([]);
  });

  it('reads both replay shapes a client sends', () => {
    const calls = priorToolCallsOf([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        toolInvocations: [
          {
            toolCallId: 'a',
            toolName: LOAD_TOOLS_TOOL,
            state: 'result',
            args: { names: ['oxy_noted__action01'] },
            result: { loaded: [{ name: 'oxy_noted__action01' }] },
          },
        ],
      },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'b',
            type: 'function',
            function: { name: 'oxy_inbox__searchEmails', arguments: '{"text":"x"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'b', content: '{"ok":true}' },
    ]);
    expect(calls).toEqual([
      {
        toolName: LOAD_TOOLS_TOOL,
        args: { names: ['oxy_noted__action01'] },
        result: { loaded: [{ name: 'oxy_noted__action01' }] },
      },
      { toolName: 'oxy_inbox__searchEmails', args: { text: 'x' }, result: { ok: true } },
    ]);
  });
});

describe('what can never be deferred', () => {
  it('core tools alone over the budget are a typed refusal, not a provider 400', () => {
    const tools = { ...core(128), ...family('oxy_noted', 'Noted', 12) };
    expect(() =>
      budgetTools({
        tools,
        sources: { oxy_service: family('oxy_noted', 'Noted', 12), mcp: {}, integration: {} },
      }),
    ).toThrow(ToolLimitExceededError);
  });

  it('127 core tools still fit beside the loader — the control', () => {
    const oxy = family('oxy_noted', 'Noted', 12);
    const budgeted = budgetTools({
      tools: { ...core(127), ...oxy },
      sources: { oxy_service: oxy, mcp: {}, integration: {} },
    });
    expect(budgeted.routing.activeTools).toHaveLength(128);
  });
});

/* -------------------------------------------------------------------------- */
/*  Through the real assembler                                                */
/* -------------------------------------------------------------------------- */

type ForUserOptions = Parameters<typeof ToolPipeline.forUser>[0];

function forUser(over: Partial<ForUserOptions> = {}) {
  return ToolPipeline.forUser({
    userId: 'user-1',
    accessToken: 'token-1',
    isDirectSession: true,
    actsForPerson: true,
    toolsEnabled: true,
    webSearch: true,
    isLocalRuntime: false,
    sseEmitter: { emit: vi.fn() } as unknown as ForUserOptions['sseEmitter'],
    ...over,
  });
}

function editorTools(count: number): NonNullable<ForUserOptions['editorToolDefinitions']> {
  return Array.from({ length: count }, (_, n) => ({
    type: 'function' as const,
    function: {
      name: `editor_tool_${n}`,
      description: 'client tool',
      parameters: { type: 'object', properties: {} },
    },
  }));
}

describe('ToolPipeline.forUser applies the budget on every path it serves', () => {
  beforeEach(() => {
    sources.oxy = productionOxyServices();
    sources.mcp = {};
    sources.mcpAsked = [];
  });

  it('routes the production mix: first step within budget, every tool registered', async () => {
    const result = await forUser();
    const first = result.activeToolNames();

    expect(Object.keys(result.tools).length).toBeGreaterThan(MAX_TOOLS_PER_INFERENCE_REQUEST);
    expect(first.length).toBeLessThanOrEqual(MAX_TOOLS_PER_INFERENCE_REQUEST);
    expect(first).toContain('getCurrentDate');
    expect(first).toContain(LOAD_TOOLS_TOOL);
    expect(first.filter((name) => name.startsWith('oxy_'))).toEqual([]);
    for (const name of Object.keys(productionOxyServices()))
      expect(result.tools[name]).toBeDefined();
    expect(result.appCatalogPrompt).toContain('- mention — Mention (93 tools)');
  });

  it("a small account keeps today's set exactly — no loader, no routing", async () => {
    sources.oxy = family('oxy_noted', 'Noted', 12);
    const result = await forUser();
    expect(result.routing).toEqual({});
    expect(result.tools[LOAD_TOOLS_TOOL]).toBeUndefined();
    expect(Object.keys(result.tools)).toContain('oxy_noted__action00');
  });

  it('loads the connector picked in the composer menu (mcpServerId)', async () => {
    sources.mcp = family('mcp_github', 'GitHub', 20);
    const result = await forUser({ mcpServerId: 'srv-github' });
    const first = result.activeToolNames();

    expect(sources.mcpAsked).toEqual([['srv-github']]);
    expect(first.filter((name) => name.startsWith('mcp_github__'))).toHaveLength(20);
    expect(first.filter((name) => name.startsWith('oxy_'))).toEqual([]);
    expect(first.length).toBeLessThanOrEqual(MAX_TOOLS_PER_INFERENCE_REQUEST);
  });

  it('without a pick the same connector waits to be loaded — the control', async () => {
    sources.mcp = family('mcp_github', 'GitHub', 20);
    const result = await forUser();
    expect(result.activeToolNames().filter((name) => name.startsWith('mcp_github__'))).toEqual([]);
    expect(result.appCatalogPrompt).toContain('- mcp_github — GitHub (20 tools)');
  });

  it('loads a single picked tool, and only that tool', async () => {
    const result = await forUser({ pickedApps: ['oxy_mention__createPost'] });
    expect(mentionNames(result.activeToolNames())).toEqual(['oxy_mention__createPost']);
  });

  it("never defers the client's own tools", async () => {
    const result = await forUser({ editorToolDefinitions: editorTools(40) });
    const first = result.activeToolNames();
    for (let n = 0; n < 40; n += 1) expect(first).toContain(`editor_tool_${n}`);
    expect(first.length).toBeLessThanOrEqual(MAX_TOOLS_PER_INFERENCE_REQUEST);
  });

  it("refuses, typed, when the client's tools alone leave no room", async () => {
    await expect(forUser({ editorToolDefinitions: editorTools(128) })).rejects.toBeInstanceOf(
      ToolLimitExceededError,
    );
  });

  it('keeps the tools the conversation used, from the replayed history', async () => {
    const result = await forUser({
      priorToolCalls: [{ toolName: 'oxy_mention__createPost', args: {}, result: { ok: true } }],
    });
    expect(mentionNames(result.activeToolNames())).toEqual(['oxy_mention__createPost']);
  });

  describe('WhatsApp tools need a WhatsApp gateway', () => {
    const WHATSAPP = ['getWhatsAppChats', 'getWhatsAppMessages', 'sendWhatsAppMessage'];

    afterEach(() => vi.unstubAllEnvs());

    it('does not offer them where no gateway is configured (production: "WhatsApp gateway not configured")', async () => {
      sources.oxy = family('oxy_noted', 'Noted', 3);
      vi.stubEnv('WHATSAPP_GATEWAY_URL', '');
      vi.stubEnv('WHATSAPP_GATEWAY_SECRET', '');
      const result = await forUser();
      for (const name of WHATSAPP) expect(result.tools[name]).toBeUndefined();
      // The neighbouring messaging tool is unaffected.
      expect(result.tools.sendTelegramMessage).toBeDefined();
    });

    it('needs both the URL and the secret', async () => {
      sources.oxy = family('oxy_noted', 'Noted', 3);
      vi.stubEnv('WHATSAPP_GATEWAY_URL', 'https://wa.example.test');
      vi.stubEnv('WHATSAPP_GATEWAY_SECRET', '');
      expect((await forUser()).tools.getWhatsAppChats).toBeUndefined();
    });

    it('offers all three where the gateway exists — the control', async () => {
      sources.oxy = family('oxy_noted', 'Noted', 3);
      vi.stubEnv('WHATSAPP_GATEWAY_URL', 'https://wa.example.test');
      vi.stubEnv('WHATSAPP_GATEWAY_SECRET', 'secret');
      const result = await forUser();
      for (const name of WHATSAPP) expect(result.tools[name]).toBeDefined();
    });
  });

  it('derives the definitions budget from the model the turn runs on', async () => {
    sources.oxy = heavy('oxy_mention', 'Mention', 94, 700);
    const roomy = await forUser({ inputLimits: { contextWindow: 1_000_000 } });
    const tight = await forUser({ inputLimits: { contextWindow: 40_000, maxOutput: 8_000 } });
    const bytes = (turn: typeof roomy) =>
      turn.activeToolNames().reduce((sum, name) => sum + sentToolBytes(name, turn.tools[name]), 0);
    expect(bytes(tight)).toBeLessThanOrEqual(bytes(roomy));
  });
});

/* -------------------------------------------------------------------------- */
/*  The model is told                                                         */
/* -------------------------------------------------------------------------- */

describe('the system prompt carries the tool catalogue', () => {
  it('appends the catalogue section when the turn is routed', async () => {
    const { appCatalogPrompt } = budgetTools(productionTurn());
    const prompt = await SystemPromptBuilder.build({
      isDirectUserSession: false,
      appCatalog: appCatalogPrompt,
    });
    expect(prompt).toContain("## Tools from the person's apps");
    expect(prompt).toContain('loadTools');
    expect(prompt).toContain('- mention — Mention (93 tools)');
    expect(prompt).not.toContain('useApps');
  });

  it('does not list Oxy tool names as present when the turn is routed', async () => {
    // Those names are not in the tool list until loaded; a weak model reading
    // them there concludes they exist and calls them, or refuses.
    const { appCatalogPrompt } = budgetTools(productionTurn());
    const direct = { isDirectUserSession: true, userId: 'u1', accessToken: 'tok' } as const;
    const routed = await SystemPromptBuilder.build({ ...direct, appCatalog: appCatalogPrompt });
    expect(routed).toContain("## Tools from the person's apps");
    expect(routed).not.toContain('## Oxy apps');

    // The control: a turn that fits keeps the fragment.
    const unrouted = await SystemPromptBuilder.build({ ...direct, appCatalog: '' });
    expect(unrouted).toContain('## Oxy apps');
  });

  it('says nothing about apps when nothing is routed — the control', async () => {
    const prompt = await SystemPromptBuilder.build({ isDirectUserSession: false, appCatalog: '' });
    expect(prompt).not.toContain("## Tools from the person's apps");
  });
});

/* -------------------------------------------------------------------------- */
/*  The catalogue says what each app covers                                   */
/* -------------------------------------------------------------------------- */

describe('the catalogue says what each app covers', () => {
  it("derives an app's subjects from its own tool names, verbs dropped", () => {
    const covers = coversOf(
      INBOX_TOOLS.map((name) => `oxy_inbox__${name}`),
      ['inbox', 'Inbox'],
    );
    // "email" names 8 of Inbox's 11 tools, so it leads.
    expect(covers[0]).toBe('email');
    expect(covers).toEqual(expect.arrayContaining(['mailbox', 'thread', 'label', 'unread']));
    for (const verb of ['search', 'get', 'read', 'send', 'list', 'move', 'update'])
      expect(covers).not.toContain(verb);
    // The app's own name adds nothing to its entry.
    expect(covers).not.toContain('inbox');
  });

  it('reads snake_case MCP tools, a resource suffix, and plain integration names alike', () => {
    expect(
      coversOf([
        'mcp_github__create_issue',
        'mcp_github__list_pull_requests',
        'mcp_github__get_issue',
      ]),
    ).toEqual(['issue', 'pull', 'request']);
    expect(coversOf(['oxy_noted__createNote__res1', 'oxy_noted__searchNotes'])).toEqual(['note']);
    expect(coversOf(['listCalendarEvents', 'createCalendarEvent'])).toEqual(['calendar', 'event']);
    expect(coversOf(['searchDriveFiles', 'getDriveFileContent'])).toEqual([
      'drive',
      'file',
      'content',
    ]);
  });

  it('bounds what one app says, however many tools it has', () => {
    const many = Array.from(
      { length: 40 },
      (_, n) => `oxy_big__get${String.fromCharCode(65 + (n % 26))}thing${n}`,
    );
    expect(coversOf(many).length).toBeLessThanOrEqual(8);
  });

  it('lists what Inbox covers in the catalogue', () => {
    const budgeted = budgetTools(productionTurn());
    const line = budgeted.appCatalogPrompt.split('\n').find((row) => row.startsWith('- inbox'));
    expect(line).toMatch(/^- inbox — Inbox \(11 tools\): email, .*mailbox/);
    const turn = productionTurn();
    expect(appsOf(turn.tools, turn.sources).find((app) => app.id === 'inbox')?.covers[0]).toBe(
      'email',
    );
  });

  it('tells the model its access is real and that loading comes before any refusal', () => {
    const { appCatalogPrompt } = budgetTools(productionTurn());
    expect(appCatalogPrompt).toContain('you DO have access');
    expect(appCatalogPrompt).toMatch(/in any language, by any name, synonym or brand/);
    expect(appCatalogPrompt).toMatch(
      /Never say you cannot access[^\n]*until you have loaded its tools/,
    );
    expect(budgetTools(productionTurn()).tools[LOAD_TOOLS_TOOL].description).toMatch(
      /BEFORE saying you cannot do something/,
    );
  });

  it('holds no app knowledge of its own: an unknown app is described by its tools', () => {
    const weather: ToolSet = {
      oxy_skyline__getForecast: appTool('Skyline', 'forecast'),
      oxy_skyline__listWeatherAlerts: appTool('Skyline', 'alerts'),
      oxy_skyline__getWeatherRadar: appTool('Skyline', 'radar'),
    };
    const oxy = { ...family('oxy_mention', 'Mention', 93), ...weather };
    // 40 + 96 = 136: routed.
    const budgeted = budgetTools({
      tools: { ...core(40), ...oxy },
      sources: { oxy_service: oxy, mcp: {}, integration: {} },
    });
    expect(budgeted.appCatalogPrompt).toMatch(
      /^- skyline — Skyline \(3 tools\): weather, forecast, radar, alert\n {2}tools \(prefix `oxy_skyline__`\): getForecast, getWeatherRadar, listWeatherAlerts$/m,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  The definition-bytes budget                                               */
/* -------------------------------------------------------------------------- */

describe('tool definitions are budgeted in bytes as well as in count', () => {
  const turn = (apps: ToolSet) => ({
    tools: { ...core(10), ...apps },
    sources: { oxy_service: apps, mcp: {}, integration: {} },
  });

  it('measures a tool as the adapter sends it', () => {
    const built = tool({ description: 'd', inputSchema: z.object({ text: z.string() }) });
    const sent = {
      type: 'function',
      name: 'echo',
      description: 'd',
      parameters: asSchema(built.inputSchema).jsonSchema,
    };
    expect(sentToolBytes('echo', built)).toBe(Buffer.byteLength(JSON.stringify(sent)) + 1 + 32);
  });

  it('a small set under both limits is not routed — the control', () => {
    const budgeted = budgetTools(turn(heavy('oxy_docs', 'Docs', 10, 100)));
    expect(budgeted.routing).toEqual({});
    expect(budgeted.tools[LOAD_TOOLS_TOOL]).toBeUndefined();
  });

  it('fewer than 128 tools whose schemas are over the bytes budget are routed', () => {
    // 40 tools × ~2.1KB ≈ 85KB: well under 128 tools, over the 61_440-byte half.
    const budgeted = budgetTools(turn(heavy('oxy_docs', 'Docs', 40, 2_000)));
    const first = activeOf(budgeted);
    expect(first).toContain(LOAD_TOOLS_TOOL);
    expect(first.filter((name) => name.startsWith('oxy_docs__'))).toEqual([]);
    expect(budgeted.appCatalogPrompt).toContain('- docs — Docs (40 tools)');
  });

  it('honours an explicit request budget', () => {
    const apps = heavy('oxy_docs', 'Docs', 10, 100);
    expect(budgetTools(turn(apps)).routing).toEqual({});
    expect(
      budgetTools({ ...turn(apps), inputBudgetBytes: 2_000 }).tools[LOAD_TOOLS_TOOL],
    ).toBeDefined();
  });
});
