import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared mock state (hoisted above the vi.mock factories below).
const { mockServices, findMock } = vi.hoisted(() => ({
  mockServices: [
    {
      serviceId: 'inbox',
      displayName: 'Inbox',
      description: 'Email service',
      tools: [
        {
          name: 'searchEmails',
          description: 'Search emails',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          endpoint: { method: 'GET', path: '/inbox/search' },
          confirmBeforeExecute: false,
        },
      ],
    },
  ],
  findMock: vi.fn(),
}));

vi.mock('../../models/oxy-service.js', () => ({
  OxyService: { find: findMock },
}));

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});

import { buildOxyServiceTools, getOxyServicePromptFragment } from '../tools/oxy-services.js';

interface ExecutableTool {
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

function lastAuthHeader(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  const call = fetchMock.mock.calls.at(-1);
  const init = call?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.Authorization;
}

describe('oxy-services tool token freshness', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findMock.mockReturnValue({ lean: () => Promise.resolve(mockServices) });
    fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
      json: async () => ({ results: [] }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    findMock.mockClear();
  });

  it('builds each caller its own tools carrying its own token, from one shared DB read', async () => {
    findMock.mockClear();

    // Same user, two different tokens within the cache TTL — the exact
    // stale-token scenario. The service defs are cached globally; only the
    // token-bound tool closures are rebuilt per call.
    const toolsT1 = await buildOxyServiceTools('user1', 'T1');
    const toolsT2 = await buildOxyServiceTools('user1', 'T2');

    const t1 = toolsT1['oxy_inbox__searchEmails'] as unknown as ExecutableTool;
    const t2 = toolsT2['oxy_inbox__searchEmails'] as unknown as ExecutableTool;
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();

    await t1.execute({ query: 'hello' });
    expect(lastAuthHeader(fetchMock)).toBe('Bearer T1');

    await t2.execute({ query: 'hello' });
    expect(lastAuthHeader(fetchMock)).toBe('Bearer T2');

    // Global defs cache: the manifest DB query ran exactly once for both builds.
    expect(findMock).toHaveBeenCalledTimes(1);
  });

  it('renders the prompt fragment from the shared defs once they are warm', async () => {
    await buildOxyServiceTools('user2', 'T3');

    const fragment = getOxyServicePromptFragment('user2');
    expect(fragment).toContain('Inbox');
    expect(fragment).toContain('oxy_inbox__searchEmails');
  });
});
