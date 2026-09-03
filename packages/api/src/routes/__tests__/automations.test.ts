import express from 'express';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  token: 'user-token' as string | undefined,
  create: vi.fn(),
  dispatch: vi.fn(),
  find: vi.fn(),
  setEnabled: vi.fn(),
  update: vi.fn(),
  listActive: vi.fn(),
  markRevoked: vi.fn(),
  upsert: vi.fn(),
  provision: vi.fn(),
  revoke: vi.fn(),
  reload: vi.fn(),
  scheduleError: vi.fn(),
  oxyMap: vi.fn(),
}));

const database = { transaction: vi.fn(async (callback) => callback(database)) };

vi.mock('../../db/index.js', () => ({ getDb: () => database }));
vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (request: express.Request, _response: express.Response, next: express.NextFunction) => {
    request.user = { id: 'owner-1' };
    request.accessToken = state.token;
    next();
  },
}));
vi.mock('../../db/agents/agentRepository.js', () => ({
  findAgentById: vi.fn(async (_db, id: string) => ({
    id,
    _id: id,
    author: 'owner-1',
    oxyAccountId: `bot-${id}`,
    status: 'active',
  })),
}));
vi.mock('../../db/automation/automationDefinitionRepository.js', () => ({
  createAutomationDefinition: state.create,
  findAutomationDefinition: state.find,
  listActiveAutomationAuthorizations: state.listActive,
  listAutomationDefinitions: vi.fn(async () => []),
  listAutomationRuns: vi.fn(async () => []),
  listAutomationRunSteps: vi.fn(async () => []),
  markAutomationAuthorizationsRevoked: state.markRevoked,
  setAutomationEnabled: state.setEnabled,
  updateAutomationDefinition: state.update,
  upsertAutomationActionAuthorizations: state.upsert,
}));
vi.mock('../../lib/automation-authority.js', () => ({
  provisionAutomationAuthorizations: state.provision,
  revokeAutomationAuthorizations: state.revoke,
}));
vi.mock('../../lib/automation-dispatcher.js', () => ({
  dispatchStructuredAutomation: state.dispatch,
}));
vi.mock('../../lib/tools/oxy-services.js', () => ({
  getOxyAgentCapabilityMap: state.oxyMap,
}));
vi.mock('../../lib/trigger-engine.js', () => ({
  automationScheduleError: state.scheduleError,
  reloadAutomationSchedule: state.reload,
}));
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { triggers: child } };
});

const { default: router } = await import('../automations.js');

let server: Server;
let port: number;

function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const json = body === undefined ? '' : JSON.stringify(body);
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(json ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(json)) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
      }));
    });
    request.on('error', reject);
    request.end(json);
  });
}

const resource = {
  appId: 'inbox',
  effectiveAccountId: 'owner-1',
  resourceType: 'mailbox',
  resourceId: 'mailbox-1',
};
const payload = {
  objective: 'Reply to important email',
  trigger: { type: 'event', appId: 'inbox', eventType: 'email_needs_response', resource },
  actorSelection: { mode: 'fixed', agentId: 'agent-1' },
  actions: [{ resource, tool: 'replyToEmail', input: {}, limits: [] }],
  resources: [resource],
  dataFlow: { sources: [resource], destinations: [resource] },
  maximumAutonomy: 'autonomous',
};

function storedAutomation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'automation-1',
    ownerAccountId: 'owner-1',
    objective: payload.objective,
    trigger: payload.trigger,
    actorSelection: payload.actorSelection,
    executionMode: 'execute',
    actions: [{ id: 'action-1', position: 0, ...payload.actions[0] }],
    inputs: {},
    resources: payload.resources,
    dataFlow: payload.dataFlow,
    maximumAutonomy: payload.maximumAutonomy,
    limits: [],
    enabled: true,
    legacyTriggerId: null,
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    updatedAt: new Date('2026-09-01T10:00:00.000Z'),
    ...overrides,
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/automations', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no TCP port');
  port = address.port;
});

afterAll(async () => new Promise<void>((resolve, reject) => (
  server.close((error) => error ? reject(error) : resolve())
)));

beforeEach(() => {
  vi.clearAllMocks();
  state.token = 'user-token';
  state.create.mockImplementation(async (_db, input) => ({
    id: input.id,
    ownerAccountId: input.ownerAccountId,
    objective: input.objective,
    trigger: input.triggerKind === 'event'
      ? { type: 'event', appId: input.eventAppId, eventType: input.eventType, resource: input.eventResource }
      : { type: input.triggerKind },
    actorSelection: { mode: input.actorMode, agentId: input.fixedAgentId },
    executionMode: input.executionMode,
    actions: input.actions.map((action: Record<string, unknown>, position: number) => ({ ...action, position })),
    inputs: input.inputs,
    resources: input.resources,
    dataFlow: input.dataFlow,
    maximumAutonomy: input.maximumAutonomy,
    limits: input.limits,
    enabled: input.enabled,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  state.provision.mockResolvedValue([]);
  state.dispatch.mockResolvedValue({ status: 'queued', sessionId: 'session-1' });
  state.listActive.mockResolvedValue([]);
  state.revoke.mockResolvedValue({ revoked: [], failed: [] });
  state.markRevoked.mockResolvedValue(undefined);
  state.reload.mockResolvedValue(undefined);
  state.scheduleError.mockReturnValue(null);
  state.oxyMap.mockResolvedValue([{
    resource,
    maximumAutonomy: 'autonomous',
    limits: [],
    toolNames: ['replyToEmail'],
  }]);
  state.setEnabled.mockImplementation(async (_db, id, _owner, enabled) => ({
    ...storedAutomation({ id, enabled }),
    updatedAt: new Date('2026-09-01T10:01:00.000Z'),
  }));
  state.update.mockImplementation(async (_db, input) => storedAutomation({
    id: input.id,
    objective: input.objective,
    trigger: input.triggerKind === 'schedule'
      ? { type: 'schedule', cron: input.scheduleCron, timezone: input.scheduleTimezone }
      : input.triggerKind === 'event'
        ? { type: 'event', appId: input.eventAppId, eventType: input.eventType, resource: input.eventResource }
        : { type: 'manual' },
    actorSelection: input.actorMode === 'fixed'
      ? { mode: 'fixed', agentId: input.fixedAgentId }
      : { mode: 'automatic', eligibleAgentIds: input.eligibleAgentIds },
    resources: input.resources,
    dataFlow: input.dataFlow,
    maximumAutonomy: input.maximumAutonomy,
    limits: input.limits,
    enabled: input.enabled,
    updatedAt: new Date('2026-09-01T10:02:00.000Z'),
  }));
});

describe('structured automation control plane', () => {
  it('defaults to observation without creating Oxy execution authority', async () => {
    const response = await send('POST', '/automations', payload);
    expect(response.status).toBe(201);
    expect(state.provision).not.toHaveBeenCalled();
    expect(state.create).toHaveBeenCalledWith(database, expect.objectContaining({
      executionMode: 'observe',
      actions: [expect.objectContaining({ tool: 'replyToEmail' })],
    }));
    expect(response.body.receipt).toEqual(expect.objectContaining({
      executionMode: 'observe',
      actions: [expect.objectContaining({ tool: 'replyToEmail' })],
    }));
  });

  it('requires a live user session before execution authority is created', async () => {
    state.token = undefined;
    const response = await send('POST', '/automations', { ...payload, executionMode: 'execute' });
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('user_session_required_for_execution_authority');
    expect(state.provision).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid schedule before persisting the definition', async () => {
    state.scheduleError.mockReturnValueOnce('invalid_timezone');
    const response = await send('POST', '/automations', {
      ...payload,
      trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'Mars/Olympus' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_timezone');
    expect(state.create).not.toHaveBeenCalled();
  });

  it('persists only opaque authorization references for execute mode', async () => {
    state.provision.mockImplementationOnce(async (input) => [{
      automationActionId: input.pairs[0].action.id,
      agentId: 'agent-1',
      actorAccountId: 'bot-agent-1',
      oxyAuthorizationId: 'authorization-1',
      expiresAt: new Date(Date.now() + 60_000),
    }]);
    const response = await send('POST', '/automations', { ...payload, executionMode: 'execute' });
    expect(response.status).toBe(201);
    expect(state.provision).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'user-token',
      ownerAccountId: 'owner-1',
      maximumAutonomy: 'autonomous',
    }));
    const persisted = state.create.mock.calls[0]?.[1];
    expect(persisted.enabled).toBe(false);
    expect(state.upsert).toHaveBeenCalledWith(database, [expect.objectContaining({
      oxyAuthorizationId: 'authorization-1',
    })]);
    expect(state.setEnabled).toHaveBeenCalledWith(database, persisted.id, 'owner-1', true);
    expect(state.reload).toHaveBeenCalledWith(persisted.id);
    expect(JSON.stringify(persisted)).not.toContain('user-token');
  });

  it('resolves manual authority at execute-on-request rather than autonomous level', async () => {
    const response = await send('POST', '/automations', {
      ...payload,
      trigger: { type: 'manual' },
      executionMode: 'execute',
      maximumAutonomy: 'execute_on_request',
    });

    expect(response.status).toBe(201);
    expect(state.oxyMap).toHaveBeenCalledWith(expect.objectContaining({
      ownerAccountId: 'owner-1',
      autonomy: 'execute_on_request',
    }));
  });

  it('rejects active background execution below autonomous policy', async () => {
    const response = await send('POST', '/automations', {
      ...payload,
      executionMode: 'execute',
      maximumAutonomy: 'execute_on_request',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('background_execution_requires_autonomous_policy');
    expect(state.create).not.toHaveBeenCalled();
    expect(state.provision).not.toHaveBeenCalled();
  });

  it('rejects manual execution under a draft policy', async () => {
    const response = await send('POST', '/automations', {
      ...payload,
      trigger: { type: 'manual' },
      executionMode: 'execute',
      maximumAutonomy: 'draft',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('manual_execution_requires_request_autonomy');
    expect(state.create).not.toHaveBeenCalled();
    expect(state.provision).not.toHaveBeenCalled();
  });

  it('does not reactivate an execute definition with an incompatible policy', async () => {
    state.find.mockResolvedValue(storedAutomation({
      trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'Europe/Madrid' },
      maximumAutonomy: 'draft',
      enabled: false,
    }));

    const response = await send('PATCH', '/automations/automation-1', { enabled: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('background_execution_requires_autonomous_policy');
    expect(state.provision).not.toHaveBeenCalled();
    expect(state.setEnabled).not.toHaveBeenCalled();
  });

  it('edits every mutable field and returns a refreshed receipt', async () => {
    state.find.mockResolvedValue(storedAutomation({ executionMode: 'observe' }));
    const noted = { ...resource, appId: 'noted', resourceType: 'workspace', resourceId: 'notes-1' };
    const update = {
      objective: 'Prepare a weekly note digest',
      trigger: { type: 'schedule', cron: '0 9 * * 1', timezone: 'Europe/Madrid' },
      actorSelection: { mode: 'automatic', eligibleAgentIds: ['agent-2', 'agent-1'] },
      resources: [resource, noted],
      dataFlow: { sources: [resource], destinations: [noted] },
      maximumAutonomy: 'autonomous',
      limits: [{ key: 'weekly', value: 1 }],
      enabled: true,
    };

    const response = await send('PATCH', '/automations/automation-1', update);

    expect(response.status).toBe(200);
    expect(state.update).toHaveBeenCalledWith(database, expect.objectContaining({
      objective: update.objective,
      triggerKind: 'schedule',
      actorMode: 'automatic',
      eligibleAgentIds: ['agent-2', 'agent-1'],
      resources: [resource, noted],
      dataFlow: update.dataFlow,
      maximumAutonomy: 'autonomous',
      limits: update.limits,
      enabled: true,
      authorizations: [],
    }));
    expect(response.body.receipt).toEqual(expect.objectContaining({
      objective: update.objective,
      trigger: update.trigger,
      actors: update.actorSelection,
      resources: update.resources,
      dataFlow: update.dataFlow,
      limits: update.limits,
      enabled: true,
    }));
  });

  it('rotates exact Oxy authority before re-enabling an edited execute definition', async () => {
    state.find.mockResolvedValue(storedAutomation());
    state.listActive.mockResolvedValue([{ oxyAuthorizationId: 'authorization-old' }]);
    state.provision.mockResolvedValue([{
      automationActionId: 'action-1',
      agentId: 'agent-1',
      actorAccountId: 'bot-agent-1',
      oxyAuthorizationId: 'authorization-new',
      expiresAt: new Date('2027-09-01T10:00:00.000Z'),
    }]);
    state.revoke.mockResolvedValue({ revoked: ['authorization-old'], failed: [] });

    const response = await send('PATCH', '/automations/automation-1', {
      objective: 'Reply to urgent email only',
    });

    expect(response.status).toBe(200);
    expect(state.provision).toHaveBeenCalledWith(expect.objectContaining({
      automationId: 'automation-1',
      accessToken: 'user-token',
    }));
    expect(state.setEnabled).toHaveBeenCalledWith(
      database,
      'automation-1',
      'owner-1',
      false,
      new Date('2026-09-01T10:00:00.000Z'),
    );
    expect(state.revoke).toHaveBeenCalledWith('user-token', ['authorization-old']);
    expect(state.markRevoked).toHaveBeenCalledWith(database, ['authorization-old']);
    expect(state.update).toHaveBeenCalledWith(database, expect.objectContaining({
      authorizations: [expect.objectContaining({ oxyAuthorizationId: 'authorization-new' })],
      enabled: true,
    }));
    expect(response.body.revocation).toEqual({ revoked: 1, failed: 0 });
  });

  it('revalidates authority against the newly assigned actor capability map', async () => {
    state.find.mockResolvedValue(storedAutomation());
    state.listActive.mockResolvedValue([{ oxyAuthorizationId: 'authorization-old' }]);
    state.revoke.mockResolvedValue({ revoked: ['authorization-old'], failed: [] });
    state.provision.mockImplementationOnce(async (input) => [{
      automationActionId: input.pairs[0].action.id,
      agentId: input.pairs[0].agent.agentId,
      actorAccountId: input.pairs[0].agent.actorAccountId,
      oxyAuthorizationId: 'authorization-agent-2',
      expiresAt: new Date('2027-09-01T10:00:00.000Z'),
    }]);

    const response = await send('PATCH', '/automations/automation-1', {
      actorSelection: { mode: 'fixed', agentId: 'agent-2' },
    });

    expect(response.status).toBe(200);
    expect(state.oxyMap).toHaveBeenCalledWith(expect.objectContaining({
      actor: { type: 'agent', accountId: 'bot-agent-2' },
    }));
    expect(state.provision).toHaveBeenCalledWith(expect.objectContaining({
      pairs: [expect.objectContaining({
        agent: expect.objectContaining({ agentId: 'agent-2', actorAccountId: 'bot-agent-2' }),
      })],
    }));
    expect(state.update).toHaveBeenCalledWith(database, expect.objectContaining({
      fixedAgentId: 'agent-2',
      authorizations: [expect.objectContaining({
        agentId: 'agent-2',
        oxyAuthorizationId: 'authorization-agent-2',
      })],
    }));
  });

  it('refuses to edit a legacy projection through the structured control plane', async () => {
    state.find.mockResolvedValue(storedAutomation({ legacyTriggerId: 'trigger-1' }));

    const response = await send('PATCH', '/automations/automation-1', {
      objective: 'Changed legacy automation',
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('legacy_automation_not_editable');
    expect(state.update).not.toHaveBeenCalled();
  });

  it('rejects duplicate global limits before rotating authority', async () => {
    state.find.mockResolvedValue(storedAutomation());

    const response = await send('PATCH', '/automations/automation-1', {
      limits: [
        { key: 'daily', value: 5 },
        { key: 'daily', value: 10 },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_automation_patch');
    expect(state.provision).not.toHaveBeenCalled();
    expect(state.setEnabled).not.toHaveBeenCalled();
  });

  it('stops locally first and reports Oxy revocation results', async () => {
    state.find.mockResolvedValue({
      id: 'automation-1',
      ownerAccountId: 'owner-1',
      executionMode: 'execute',
      enabled: true,
    });
    state.listActive.mockResolvedValue([{ oxyAuthorizationId: 'authorization-1' }]);
    state.revoke.mockResolvedValue({ revoked: ['authorization-1'], failed: [] });
    const response = await send('DELETE', '/automations/automation-1');
    expect(response.status).toBe(200);
    expect(state.setEnabled).toHaveBeenCalledWith(database, 'automation-1', 'owner-1', false);
    expect(state.revoke).toHaveBeenCalledWith('user-token', ['authorization-1']);
    expect(state.markRevoked).toHaveBeenCalledWith(database, ['authorization-1']);
    expect(response.body.revocation).toEqual({ revoked: 1, failed: 0 });
  });

  it('dispatches a manual definition with the caller and an explicit idempotency key', async () => {
    state.find.mockResolvedValue({
      id: 'automation-1',
      ownerAccountId: 'owner-1',
      trigger: { type: 'manual' },
    });

    const response = await send(
      'POST',
      '/automations/automation-1/run',
      undefined,
      { 'idempotency-key': 'request-0001' },
    );

    expect(response.status).toBe(202);
    expect(response.body.run).toEqual({ status: 'queued', sessionId: 'session-1' });
    expect(state.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'automation-1' }),
      expect.objectContaining({
        kind: 'manual',
        id: 'manual:automation-1:request-0001',
        requesterAccountId: 'owner-1',
      }),
    );
  });

  it('requires an idempotency key before reading or dispatching a manual definition', async () => {
    const response = await send('POST', '/automations/automation-1/run');

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('valid_idempotency_key_required');
    expect(state.find).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
  });
});
