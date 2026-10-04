import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getServiceToken } = vi.hoisted(() => ({
  getServiceToken: vi.fn(async () => 'ALIA-SERVICE-TOKEN'),
}));

vi.mock('../oxy-service-client.js', () => ({
  oxyServiceClient: () => ({ getServiceToken }),
  oxyServiceToken: getServiceToken,
}));

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});

import {
  buildOxyServiceTools,
  getOxyServicePromptFragment,
  idempotencyKey,
  listOxyAccountReadTools,
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
        expect(['AUTHORIZATION-1', 'PREAUTHORIZED-1', 'STANDING-1', 'STANDING-2']).toContain(request.executionAuthorizationId);
        if (String(request.executionAuthorizationId).startsWith('STANDING-')) {
          // Automation kind: Oxy requires the run, and a standing read has no step.
          expect(request).toEqual({ executionAuthorizationId: request.executionAuthorizationId, runId: 'run-user-5' });
        }
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
          headers: {
            'content-type': 'application/json',
            'x-oxy-audit-event-id': 'audit-event-1',
          },
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
    await expect(search.execute({ q: 'second' })).resolves.toEqual({
      error: 'searchEmails is authorized once for this automation stage',
    });

    const controlPlaneCalls = fetchMock.mock.calls.filter(([input]) => (
      String(input).endsWith('/capabilities/execution-authorizations')
    ));
    expect(controlPlaneCalls).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([input]) => (
      String(input).endsWith('/capabilities/execution-authorizations/PREAUTHORIZED-1')
    ))).toBe(false);
    expect(onStepStatus.mock.calls).toEqual([
      ['step-user-3', 'running'],
      ['step-user-3', 'succeeded', 'audit-event-1'],
    ]);
    expect(fetchMock.mock.calls.filter(([input]) => (
      String(input).startsWith('https://inbox.example.test/')
    ))).toHaveLength(1);
  });

  describe('what the model is told when a call fails', () => {
    function refuse(match: (url: string, init?: RequestInit) => boolean, response: () => Response): void {
      const original = fetchMock.getMockImplementation() as
        | ((input: string | URL, init?: RequestInit) => Promise<Response>)
        | undefined;
      fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => (
        match(String(input), init) ? response() : original?.(input, init)
      ));
    }

    it('hides raw authority errors while preserving consent and refusing bypass', async () => {
      refuse(
        (url, init) => url.endsWith('/capabilities/execution-authorizations') && init?.method === 'POST',
        () => new Response(JSON.stringify({ error: 'coordinator_not_active_or_authorized' }), { status: 400 }),
      );
      const tools = await buildOxyServiceTools('user-1', context('user-1'));
      const result = await (tools.oxy_inbox__searchEmails as unknown as ExecutableTool).execute({ q: 'hello' });
      expect(result).toMatchObject({ error: 'oxy_app_unavailable' });
      const text = JSON.stringify(result);
      expect(text).not.toContain('coordinator_not_active_or_authorized');
      expect(text).toContain('Request any required consent through the supported account flow');
      expect(text).toContain('Do not claim it succeeded or use another route to bypass the check');
    });

    it('treats a missing user authority the same way', async () => {
      const tools = await buildOxyServiceTools('user-1', { ...context('user-1'), userAccessToken: undefined });
      const result = await (tools.oxy_inbox__searchEmails as unknown as ExecutableTool).execute({ q: 'hello' });
      expect(result).toMatchObject({ error: 'oxy_app_unavailable' });
      expect(JSON.stringify(result)).not.toContain('No direct or automation authority');
    });

    it('treats the app refusing its ticket as an authority failure', async () => {
      refuse((url) => url.includes('/email/search'), () => new Response('ticket rejected', { status: 403 }));
      const tools = await buildOxyServiceTools('user-1', context('user-1'));
      const result = await (tools.oxy_inbox__searchEmails as unknown as ExecutableTool).execute({ q: 'hello' });
      expect(result).toMatchObject({ error: 'oxy_app_unavailable' });
    });

    it('keeps the app\'s own answer to the request, which the model can act on', async () => {
      refuse((url) => url.includes('/email/search'), () => new Response('query too long', { status: 422 }));
      const tools = await buildOxyServiceTools('user-1', context('user-1'));
      const result = await (tools.oxy_inbox__searchEmails as unknown as ExecutableTool).execute({ q: 'hello' });
      expect(result).toEqual({ error: expect.stringContaining('query too long') });
    });
  });

  it('lets Alia read the owner\'s apps any number of times under her standing authority', async () => {
    const root = { appId: 'inbox', effectiveAccountId: 'user-5', resourceType: 'email_account', resourceId: 'user-5' };
    const tools = await buildOxyServiceTools('user-5', {
      requesterAccountId: 'user-5',
      ownerAccountId: 'user-5',
      actor: { type: 'alia', ownerAccountId: 'user-5' },
      runId: 'run-user-5',
      autonomy: 'autonomous',
      executionAuthorizations: {
        [oxyExecutionAuthorizationKey(root, 'searchEmails')]: { id: 'STANDING-1', repeatable: true },
      },
    });
    const search = tools.oxy_inbox__searchEmails as unknown as ExecutableTool;
    await expect(search.execute({ q: 'hello' })).resolves.toEqual({ data: [] });
    await expect(search.execute({ q: 'hello' })).resolves.toEqual({ data: [] });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/capabilities/tickets'))).toHaveLength(2);
    // No user bearer, so nothing is created or revoked at Oxy during the run.
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/capabilities/execution-authorizations'))).toBe(false);
  });

  it('binds Alia to exactly the resources her authority names, account root or not', async () => {
    const root = { appId: 'inbox', effectiveAccountId: 'user-5', resourceType: 'email_account', resourceId: 'user-5' };
    const other = { ...root, resourceId: 'shared-box' };
    const tools = await buildOxyServiceTools('user-5', {
      requesterAccountId: 'user-5',
      ownerAccountId: 'user-5',
      actor: { type: 'alia', ownerAccountId: 'user-5' },
      runId: 'run-user-5',
      executionAuthorizations: {
        [oxyExecutionAuthorizationKey(root, 'searchEmails')]: { id: 'STANDING-1', repeatable: true },
        [oxyExecutionAuthorizationKey(other, 'searchEmails')]: { id: 'STANDING-2', repeatable: true },
        [oxyExecutionAuthorizationKey(root, 'notInTheCatalog')]: { id: 'STANDING-3', repeatable: true },
      },
    });
    const names = Object.keys(tools).sort();
    expect(names).toHaveLength(2);
    expect(names.every((name) => name.startsWith('oxy_inbox__searchEmails__'))).toBe(true);
  });

  it('lists every read tool at the owner\'s account roots for standing authority', async () => {
    await expect(listOxyAccountReadTools('user-6')).resolves.toEqual([{
      resource: { appId: 'inbox', effectiveAccountId: 'user-6', resourceType: 'email_account', resourceId: 'user-6' },
      tool: 'searchEmails',
    }]);
  });

  it('does not expose undeclared Oxy tools to a pre-authorized background stage', async () => {
    const tools = await buildOxyServiceTools('user-4', {
      requesterAccountId: 'user-4',
      ownerAccountId: 'user-4',
      actor: { type: 'alia', ownerAccountId: 'user-4' },
      runId: 'run-user-4',
      autonomy: 'autonomous',
      executionAuthorizations: {},
    });
    expect(tools).toEqual({});
  });

  describe('the idempotency key of an effect', () => {
    const args = { emailId: 'email-1', starred: true };

    it('is one per tool call, so a deliberate identical repeat is not a duplicate', () => {
      expect(idempotencyKey('run-1', 'updateEmailFlags', args, 'call-a'))
        .not.toBe(idempotencyKey('run-1', 'updateEmailFlags', args, 'call-b'));
    });

    it('is stable for a retry of the same call', () => {
      expect(idempotencyKey('run-1', 'updateEmailFlags', args, 'call-a'))
        .toBe(idempotencyKey('run-1', 'updateEmailFlags', { starred: true, emailId: 'email-1' }, 'call-a'));
    });

    it('falls back to the arguments when there is no call id', () => {
      expect(idempotencyKey('run-1', 'updateEmailFlags', args, undefined))
        .toBe(idempotencyKey('run-1', 'updateEmailFlags', { ...args }, undefined));
    });
  });
});
