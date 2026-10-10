/**
 * The per-request tool budget and the app router (`lib/tool-budget.ts`).
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tool, type Tool, type ToolSet } from 'ai';
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

const { budgetTools, stickyAppsFrom, appsOf, coversOf, USE_APPS_TOOL } = await import(
  '../tool-budget.js'
);
const { ToolPipeline } = await import('../tool-pipeline.js');
const { ToolLimitExceededError, MAX_TOOLS_PER_INFERENCE_REQUEST } = await import(
  '../inference/tool-limit.js'
);
const { SystemPromptBuilder } = await import('../system-prompt-builder.js');
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

async function openApps(
  budgeted: ReturnType<typeof budgetTools>,
  input: { apps: string[]; close?: string[] },
) {
  const useApps = budgeted.tools[USE_APPS_TOOL];
  return (await useApps.execute?.(
    input as never,
    { toolCallId: 't', messages: [] } as never,
  )) as Record<string, unknown>;
}

const mentionNames = (names: readonly string[]) =>
  names.filter((name) => name.startsWith('oxy_mention__'));

/* -------------------------------------------------------------------------- */
/*  The budget                                                                */
/* -------------------------------------------------------------------------- */

describe('the production mix fits the budget without losing a tool', () => {
  it('reproduces the failing turn: 143 tools, more than one request carries', () => {
    const { tools } = productionTurn();
    expect(Object.keys(tools)).toHaveLength(143);
    expect(Object.keys(tools).length).toBeGreaterThan(MAX_TOOLS_PER_INFERENCE_REQUEST);
  });

  it('sends at most 128 on the first step: core tools, the router, and no app tools', () => {
    const turn = productionTurn();
    const budgeted = budgetTools(turn);
    const first = budgeted.routing.prepareStep?.().activeTools ?? [];

    expect(first.length).toBeLessThanOrEqual(MAX_TOOLS_PER_INFERENCE_REQUEST);
    expect(budgeted.routing.activeTools).toEqual(first);
    for (const name of Object.keys(core(24))) expect(first).toContain(name);
    expect(first).toContain(USE_APPS_TOOL);
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

  it('lists every app in the catalog with its tool count', () => {
    const budgeted = budgetTools(productionTurn());
    expect(budgeted.appCatalogPrompt).toContain('## Apps');
    expect(budgeted.appCatalogPrompt).toContain('- mention — Mention (93 tools)');
    expect(budgeted.appCatalogPrompt).toContain('- noted — Noted (12 tools)');
    expect(budgeted.appCatalogPrompt).toContain('- inbox — Inbox (11 tools): email, ');
    expect(budgeted.appCatalogPrompt).toContain('- mercaria — Mercaria (3 tools)');
    expect(budgeted.tools[USE_APPS_TOOL].description).toContain('mention (Mention');
  });
});

describe('useApps opens an app from the next step', () => {
  it('activates exactly Mention\'s 93 tools after useApps(["mention"])', async () => {
    const budgeted = budgetTools(productionTurn());
    const before = budgeted.routing.prepareStep?.().activeTools ?? [];

    const result = await openApps(budgeted, { apps: ['mention'] });
    const after = budgeted.routing.prepareStep?.().activeTools ?? [];

    expect(result).toMatchObject({ opened: ['mention'], openApps: ['mention'] });
    expect(mentionNames(before)).toEqual([]);
    expect(mentionNames(after)).toHaveLength(93);
    // Exactly Mention's: nothing else joined, and nothing that was there left.
    expect(after.filter((name) => !before.includes(name)).sort()).toEqual(
      mentionNames(Object.keys(productionOxyServices())).sort(),
    );
    expect(before.every((name) => after.includes(name))).toBe(true);
    expect(after.length).toBeLessThanOrEqual(MAX_TOOLS_PER_INFERENCE_REQUEST);
  });

  it('refuses an app that would exceed the budget, says so, and opens what fits', async () => {
    const budgeted = budgetTools(productionTurn());
    await openApps(budgeted, { apps: ['mention'] }); // 24 + 1 + 93 = 118

    const result = await openApps(budgeted, { apps: ['noted', 'mercaria'] });

    // noted would make 130; mercaria makes 121 — the requested order, then what fits.
    expect(result.opened).toEqual(['mercaria']);
    expect(result.didNotFit).toEqual([{ app: 'noted', tools: 12 }]);
    expect(String(result.hint)).toContain('close');
    expect((budgeted.routing.prepareStep?.().activeTools ?? []).length).toBe(121);
  });

  it('closing an app makes room for another in the same call', async () => {
    const budgeted = budgetTools(productionTurn());
    await openApps(budgeted, { apps: ['mention'] });

    const result = await openApps(budgeted, { apps: ['noted'], close: ['mention'] });
    const active = budgeted.routing.prepareStep?.().activeTools ?? [];

    expect(result).toMatchObject({ closed: ['mention'], opened: ['noted'] });
    expect(mentionNames(active)).toEqual([]);
    expect(active.filter((name) => name.startsWith('oxy_noted__'))).toHaveLength(12);
  });

  it('names an unknown app instead of guessing', async () => {
    const budgeted = budgetTools(productionTurn());
    const result = await openApps(budgeted, { apps: ['nope', 'Noted'] });
    expect(result.unknown).toEqual(['nope']);
    // Resolved by label as well as id.
    expect(result.opened).toEqual(['noted']);
  });
});

describe("a turn that fits keeps today's behaviour", () => {
  it('a small account is not routed: every tool, every step, no router tool', () => {
    const oxy = family('oxy_noted', 'Noted', 12);
    const tools = { ...core(24), ...oxy };
    const budgeted = budgetTools({
      tools,
      sources: { oxy_service: oxy, mcp: {}, integration: {} },
    });

    expect(budgeted.tools).toBe(tools);
    expect(budgeted.routing).toEqual({});
    expect(budgeted.appCatalogPrompt).toBe('');
    expect(budgeted.tools[USE_APPS_TOOL]).toBeUndefined();
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

describe('explicit picks are active from the first step and never dropped', () => {
  it('a picked app is open before the model asks, and cannot be closed', async () => {
    const budgeted = budgetTools({ ...productionTurn(), pins: ['mention'] });
    const first = budgeted.routing.activeTools ?? [];
    expect(mentionNames(first)).toHaveLength(93);

    const result = await openApps(budgeted, { apps: [], close: ['mention'] });
    expect(result.keptOpen).toEqual(['mention']);
    expect(mentionNames(budgeted.routing.prepareStep?.().activeTools ?? [])).toHaveLength(93);
  });

  it('a picked single tool activates that tool alone, not its app', () => {
    const budgeted = budgetTools({ ...productionTurn(), pins: ['oxy_mention__createPost'] });
    const first = budgeted.routing.activeTools ?? [];
    expect(mentionNames(first)).toEqual(['oxy_mention__createPost']);
  });

  it('picks that do not fit are refused with a typed error naming them', () => {
    // 24 + 1 + 93 + 12 = 130.
    const refuse = () => budgetTools({ ...productionTurn(), pins: ['mention', 'noted'] });
    expect(refuse).toThrow(ToolLimitExceededError);
    expect(refuse).toThrow(/noted \(12 tools\)/);
    try {
      refuse();
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_request',
        status: 400,
        param: 'tools',
        retryable: false,
      });
    }
  });

  it('picks that fit are all honoured — the control', () => {
    const budgeted = budgetTools({ ...productionTurn(), pins: ['mention', 'mercaria'] });
    const first = budgeted.routing.activeTools ?? [];
    expect(mentionNames(first)).toHaveLength(93);
    expect(first.filter((name) => name.startsWith('oxy_mercaria__'))).toHaveLength(3);
  });
});

describe('apps opened earlier in the conversation stay open', () => {
  it('reopens apps from replayed useApps results and from direct calls', () => {
    const budgeted = budgetTools({
      ...productionTurn(),
      priorToolCalls: [
        {
          toolName: USE_APPS_TOOL,
          args: { apps: ['noted'] },
          result: { opened: ['noted'], alreadyOpen: [] },
        },
        { toolName: 'oxy_inbox__readEmail', args: { text: 'x' } },
      ],
    });
    const first = budgeted.routing.activeTools ?? [];
    expect(first.filter((name) => name.startsWith('oxy_noted__'))).toHaveLength(12);
    expect(first.filter((name) => name.startsWith('oxy_inbox__'))).toHaveLength(11);
    expect(mentionNames(first)).toEqual([]);
    expect(budgeted.appCatalogPrompt).toMatch(/^- noted — Noted \(12 tools\).*\[open\]$/m);
  });

  it('an app closed later in the conversation stays closed', () => {
    const apps = appsOf(productionTurn().tools, productionTurn().sources);
    expect(
      stickyAppsFrom(apps, [
        { toolName: USE_APPS_TOOL, result: { opened: ['noted'] } },
        { toolName: USE_APPS_TOOL, result: { opened: [], closed: ['noted'] } },
      ]),
    ).toEqual([]);
  });

  it('opens nothing for a conversation with no history — the control', () => {
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
            toolName: USE_APPS_TOOL,
            state: 'result',
            args: { apps: ['noted'] },
            result: { opened: ['noted'] },
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
      { toolName: USE_APPS_TOOL, args: { apps: ['noted'] }, result: { opened: ['noted'] } },
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

  it('127 core tools still fit beside the router — the control', () => {
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
    agentMode: true,
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
    expect(first).toContain(USE_APPS_TOOL);
    expect(first.filter((name) => name.startsWith('oxy_'))).toEqual([]);
    for (const name of Object.keys(productionOxyServices()))
      expect(result.tools[name]).toBeDefined();
    expect(result.appCatalogPrompt).toContain('- mention — Mention (93 tools)');
  });

  it("a small account keeps today's set exactly — no router, no routing", async () => {
    sources.oxy = family('oxy_noted', 'Noted', 12);
    const result = await forUser();
    expect(result.routing).toEqual({});
    expect(result.tools[USE_APPS_TOOL]).toBeUndefined();
    expect(Object.keys(result.tools)).toContain('oxy_noted__action00');
  });

  it('pre-activates the connector picked in the composer menu (mcpServerId)', async () => {
    sources.mcp = family('mcp_github', 'GitHub', 20);
    const result = await forUser({ mcpServerId: 'srv-github' });
    const first = result.activeToolNames();

    expect(sources.mcpAsked).toEqual([['srv-github']]);
    expect(first.filter((name) => name.startsWith('mcp_github__'))).toHaveLength(20);
    expect(first.filter((name) => name.startsWith('oxy_'))).toEqual([]);
    expect(first.length).toBeLessThanOrEqual(MAX_TOOLS_PER_INFERENCE_REQUEST);
  });

  it('without a pick the same connector waits to be opened — the control', async () => {
    sources.mcp = family('mcp_github', 'GitHub', 20);
    const result = await forUser();
    expect(result.activeToolNames().filter((name) => name.startsWith('mcp_github__'))).toEqual([]);
    expect(result.appCatalogPrompt).toContain('- mcp_github — GitHub (20 tools)');
  });

  it('pre-activates a single picked tool, and only that tool', async () => {
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

  it('keeps apps the conversation opened, from the replayed history', async () => {
    const result = await forUser({
      priorToolCalls: [
        { toolName: USE_APPS_TOOL, args: { apps: ['mention'] }, result: { opened: ['mention'] } },
      ],
    });
    expect(mentionNames(result.activeToolNames())).toHaveLength(93);
  });
});

/* -------------------------------------------------------------------------- */
/*  The model is told                                                         */
/* -------------------------------------------------------------------------- */

describe('the system prompt carries the app catalog', () => {
  it('appends the Apps section when the turn is routed', async () => {
    const { appCatalogPrompt } = budgetTools(productionTurn());
    const prompt = await SystemPromptBuilder.build({
      isDirectUserSession: false,
      appCatalog: appCatalogPrompt,
    });
    expect(prompt).toContain('## Apps');
    expect(prompt).toContain('useApps');
    expect(prompt).toContain('- mention — Mention (93 tools)');
  });

  it('does not list Oxy tool names as present when the turn is routed', async () => {
    // Those names are not in the tool list until the app is opened; a weak model
    // reading them there concludes they do not exist, and refuses.
    const { appCatalogPrompt } = budgetTools(productionTurn());
    const direct = { isDirectUserSession: true, userId: 'u1', accessToken: 'tok' } as const;
    const routed = await SystemPromptBuilder.build({ ...direct, appCatalog: appCatalogPrompt });
    expect(routed).toContain('## Apps');
    expect(routed).not.toContain('## Oxy apps');

    // The control: a turn that fits keeps the fragment.
    const unrouted = await SystemPromptBuilder.build({ ...direct, appCatalog: '' });
    expect(unrouted).toContain('## Oxy apps');
  });

  it('says nothing about apps when nothing is routed — the control', async () => {
    const prompt = await SystemPromptBuilder.build({ isDirectUserSession: false, appCatalog: '' });
    expect(prompt).not.toContain('## Apps');
  });
});

/* -------------------------------------------------------------------------- */
/*  The catalog says what each app covers                                     */
/* -------------------------------------------------------------------------- */

describe('the catalog says what each app covers', () => {
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

  it('lists what Inbox covers in the catalog and in the useApps description', () => {
    const budgeted = budgetTools(productionTurn());
    const line = budgeted.appCatalogPrompt.split('\n').find((row) => row.startsWith('- inbox'));
    expect(line).toMatch(/^- inbox — Inbox \(11 tools\): email, .*mailbox/);
    expect(budgeted.tools[USE_APPS_TOOL].description).toMatch(/inbox \(Inbox: email, [^)]*\)/);
    const turn = productionTurn();
    expect(appsOf(turn.tools, turn.sources).find((app) => app.id === 'inbox')?.covers[0]).toBe(
      'email',
    );
  });

  it('tells the model its access is real and that useApps comes before any refusal', () => {
    const { appCatalogPrompt } = budgetTools(productionTurn());
    expect(appCatalogPrompt).toContain('you DO have access');
    expect(appCatalogPrompt).toMatch(/in any language, by any name, synonym or brand/);
    expect(appCatalogPrompt).toMatch(
      /Never say you cannot access[^\n]*until you have opened that app/,
    );
    expect(budgetTools(productionTurn()).tools[USE_APPS_TOOL].description).toMatch(
      /BEFORE saying you cannot access/,
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
      /^- skyline — Skyline \(3 tools\): weather, forecast, radar, alert$/m,
    );
  });
});
