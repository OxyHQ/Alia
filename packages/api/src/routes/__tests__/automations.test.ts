import express from 'express';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  token: 'user-token' as string | undefined,
  create: vi.fn(),
  find: vi.fn(),
  setEnabled: vi.fn(),
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
  upsertAutomationActionAuthorizations: state.upsert,
}));
vi.mock('../../lib/automation-authority.js', () => ({
  provisionAutomationAuthorizations: state.provision,
  revokeAutomationAuthorizations: state.revoke,
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

function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const json = body === undefined ? '' : JSON.stringify(body);
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: json ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) } : {},
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
  state.setEnabled.mockImplementation(async (_db, id, _owner, enabled) => ({ id, enabled }));
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
});
