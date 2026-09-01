import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getServiceToken } = vi.hoisted(() => ({
  getServiceToken: vi.fn(async () => 'ALIA-SERVICE-TOKEN'),
}));

vi.mock('../oxy-service-client.js', () => ({
  oxyServiceClient: () => ({ getServiceToken }),
}));

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});

import {
  buildOxyServiceTools,
  getOxyServicePromptFragment,
  type OxyToolExecutionContext,
} from '../tools/oxy-services.js';

const CATALOG = {
  schemaVersion: '1',
  appId: 'inbox',
  version: '1.0.0',
  audience: 'oxy-inbox-api',
  accountResourceType: 'email_account',
  tools: [{
    name: 'searchEmails',
    version: '1.0.0',
    description: 'Search emails',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object' },
    capabilityPackage: 'read',
    requiredCapabilities: ['email.read'],
    resourceTypes: ['email_account'],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal', 'mcp'],
    invocation: { method: 'GET', path: '/email/search' },
  }],
  events: [],
};

interface ExecutableTool {
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

function context(userId: string): OxyToolExecutionContext {
  return {
    requesterAccountId: userId,
    ownerAccountId: userId,
    actor: { type: 'alia', ownerAccountId: userId },
    runId: `run-${userId}`,
    autonomy: 'execute_on_request',
  };
}

describe('Oxy capability tools', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/capabilities/catalogs')) {
        return new Response(JSON.stringify({ registrations: [{ catalog: CATALOG }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/capabilities/tickets')) {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ALIA-SERVICE-TOKEN');
        return new Response(JSON.stringify({ decision: { allowed: true, reason: 'allowed' }, ticket: 'SHORT-TICKET' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/email/search')) {
        expect((init?.headers as Record<string, string>).authorization).toBe('Capability SHORT-TICKET');
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('loads the signed registry and uses a short capability ticket, never a user JWT', async () => {
    const tools = await buildOxyServiceTools('user-1', context('user-1'));
    const search = tools.oxy_inbox__searchEmails as unknown as ExecutableTool;
    expect(search).toBeDefined();
    await search.execute({ q: 'hello' });

    const headers = fetchMock.mock.calls
      .map((call) => (call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)
      .filter((value) => value !== undefined);
    expect(headers.some((value) => value.authorization === 'Bearer USER-TOKEN')).toBe(false);
    expect(headers.some((value) => value.authorization === 'Capability SHORT-TICKET')).toBe(true);
  });

  it('renders its prompt from the same registry snapshot', async () => {
    await buildOxyServiceTools('user-2', context('user-2'));
    const fragment = getOxyServicePromptFragment('user-2');
    expect(fragment).toContain('Inbox');
    expect(fragment).toContain('oxy_inbox__searchEmails');
  });
});
