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
  oxyExecutionAuthorizationKey,
  type OxyToolExecutionContext,
} from '../tools/oxy-services.js';

const CATALOG = {
  schemaVersion: '1',
  appId: 'inbox',
  version: '1.0.0',
  audience: 'oxy-inbox-api',
  internalBaseUrl: 'https://inbox.example.test',
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
    limitKeys: [],
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
    userAccessToken: 'USER-TOKEN',
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
      if (url.endsWith('/capabilities/service-identity')) {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ALIA-SERVICE-TOKEN');
        return new Response(JSON.stringify({
          service: { applicationId: 'alia-app', credentialId: 'alia-credential' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/capabilities/execution-authorizations') && init?.method === 'POST') {
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer USER-TOKEN');
        expect(JSON.parse(String(init.body))).toMatchObject({
          kind: 'direct_request',
          coordinatorApplicationId: 'alia-app',
          coordinatorCredentialId: 'alia-credential',
          tool: 'searchEmails',
          runId: 'run-user-1',
          maximumAutonomy: 'read_only',
        });
        return new Response(JSON.stringify({ authorization: { id: 'AUTHORIZATION-1' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/capabilities/tickets')) {
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ALIA-SERVICE-TOKEN');
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(['AUTHORIZATION-1', 'PREAUTHORIZED-1']).toContain(request.executionAuthorizationId);
        if (request.executionAuthorizationId === 'PREAUTHORIZED-1') {
          expect(request).toEqual({
            executionAuthorizationId: 'PREAUTHORIZED-1',
            runId: 'run-user-3',
            stepId: 'step-user-3',
          });
        }
        return new Response(JSON.stringify({ decision: { allowed: true, reason: 'allowed' }, ticket: 'SHORT-TICKET' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/email/search')) {
        expect(url).toBe('https://inbox.example.test/email/search?q=hello');
        expect((init?.headers as Record<string, string>).authorization).toBe('Capability SHORT-TICKET');
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/capabilities/execution-authorizations/AUTHORIZATION-1') && init?.method === 'DELETE') {
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer USER-TOKEN');
        return new Response(null, { status: 204 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses user authority only on Oxy control-plane calls and sends only a ticket to the app', async () => {
    const tools = await buildOxyServiceTools('user-1', context('user-1'));
    const search = tools.oxy_inbox__searchEmails as unknown as ExecutableTool;
    expect(search).toBeDefined();
    await search.execute({ q: 'hello' });

    const appCall = fetchMock.mock.calls.find(([input]) => String(input).startsWith('https://inbox.example.test/'));
    expect(appCall).toBeDefined();
    expect(((appCall?.[1] as RequestInit).headers as Record<string, string>).authorization)
      .toBe('Capability SHORT-TICKET');
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input).endsWith('/capabilities/execution-authorizations/AUTHORIZATION-1')
      && (init as RequestInit).method === 'DELETE'
    ))).toBe(true);
  });

  it('renders its prompt from the same registry snapshot', async () => {
    await buildOxyServiceTools('user-2', context('user-2'));
    const fragment = getOxyServicePromptFragment('user-2');
    expect(fragment).toContain('Inbox');
    expect(fragment).toContain('oxy_inbox__searchEmails');
  });

  it('uses an exact pre-authorization for a background step without a user bearer', async () => {
    const resource = {
      appId: 'inbox',
      effectiveAccountId: 'user-3',
      resourceType: 'email_account',
      resourceId: 'user-3',
    };
    const onStepStatus = vi.fn(async () => undefined);
    const tools = await buildOxyServiceTools('user-3', {
      requesterAccountId: 'user-3',
      ownerAccountId: 'user-3',
      actor: { type: 'alia', ownerAccountId: 'user-3' },
      runId: 'run-user-3',
      autonomy: 'autonomous',
      executionAuthorizations: {
        [oxyExecutionAuthorizationKey(resource, 'searchEmails')]: {
          id: 'PREAUTHORIZED-1',
          stepId: 'step-user-3',
        },
      },
      onStepStatus,
    });
    const search = tools.oxy_inbox__searchEmails as unknown as ExecutableTool;
    await search.execute({ q: 'hello' });

    const controlPlaneCalls = fetchMock.mock.calls.filter(([input]) => (
      String(input).endsWith('/capabilities/execution-authorizations')
    ));
    expect(controlPlaneCalls).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([input]) => (
      String(input).endsWith('/capabilities/execution-authorizations/PREAUTHORIZED-1')
    ))).toBe(false);
    expect(onStepStatus.mock.calls).toEqual([
      ['step-user-3', 'running'],
      ['step-user-3', 'succeeded'],
    ]);
  });
});
