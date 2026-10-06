/**
 * `GET|PUT /agents/:id/oxy-apps` — only the agent's OWNER chooses what of
 * their data it may use. Someone who merely operates the bot is refused before
 * Oxy is asked anything.
 */
import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  userId: 'owner-1',
  agent: { _id: 'agent-1', oxyAccountId: 'bot-1', ownerOxyAccountId: 'owner-1', applicationId: null as string | null },
}));
const lib = vi.hoisted(() => ({
  listAgentOxyApps: vi.fn(async () => [{ appId: 'inbox', name: 'Inbox', level: 'none', levels: ['none', 'read', 'act'] }]),
  setAgentOxyAppLevel: vi.fn(async (_agent: unknown, _token: string, appId: string, level: string) => ({
    appId, name: 'Inbox', level, levels: ['none', 'read', 'act'],
  })),
}));

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: state.userId }, accessToken: 'OWNER-TOKEN' });
    next();
  },
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../lib/agent-account.js', () => ({
  loadAgentForActor: vi.fn(async () => ({ ok: true, agent: state.agent })),
  refusalMessage: () => 'refused',
  refusalStatus: () => 403,
}));
vi.mock('../../../lib/agent-oxy-apps.js', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/agent-oxy-apps.js')>('../../../lib/agent-oxy-apps.js');
  return { ...actual, listAgentOxyApps: lib.listAgentOxyApps, setAgentOxyAppLevel: lib.setAgentOxyAppLevel };
});
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, general: child } };
});

import router from '../oxy-apps.js';

const app = express();
app.use(express.json());
app.use('/agents', router);
let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: 'GET' | 'PUT', path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> & { apps?: unknown; app?: { level?: string }; error?: string } };
}

beforeEach(() => {
  state.userId = 'owner-1';
  state.agent = { _id: 'agent-1', oxyAccountId: 'bot-1', ownerOxyAccountId: 'owner-1', applicationId: null };
  lib.listAgentOxyApps.mockClear();
  lib.setAgentOxyAppLevel.mockClear();
});

describe('agent Oxy app levels', () => {
  it('lists every app for the owner, with the owner\'s bearer', async () => {
    const response = await call('GET', '/agents/agent-1/oxy-apps');
    expect(response.status).toBe(200);
    expect(response.body.apps).toEqual([{ appId: 'inbox', name: 'Inbox', level: 'none', levels: ['none', 'read', 'act'] }]);
    expect(lib.listAgentOxyApps).toHaveBeenCalledWith(state.agent, 'OWNER-TOKEN');
  });

  it('sets one level', async () => {
    const response = await call('PUT', '/agents/agent-1/oxy-apps/inbox', { level: 'act' });
    expect(response.status).toBe(200);
    expect(response.body.app?.level).toBe('act');
    expect(lib.setAgentOxyAppLevel).toHaveBeenCalledWith(state.agent, 'OWNER-TOKEN', 'inbox', 'act');
  });

  it('refuses an operator who is not the owner, before asking Oxy', async () => {
    state.userId = 'operator-2';
    expect((await call('GET', '/agents/agent-1/oxy-apps')).status).toBe(403);
    expect((await call('PUT', '/agents/agent-1/oxy-apps/inbox', { level: 'read' })).body.error).toBe('owner_only');
    expect(lib.listAgentOxyApps).not.toHaveBeenCalled();
    expect(lib.setAgentOxyAppLevel).not.toHaveBeenCalled();
  });

  it('refuses a product agent and a level outside the three', async () => {
    expect((await call('PUT', '/agents/agent-1/oxy-apps/inbox', { level: 'admin' })).status).toBe(400);
    state.agent = { ...state.agent, applicationId: 'homiio' };
    expect((await call('GET', '/agents/agent-1/oxy-apps')).status).toBe(400);
  });

  it('answers Oxy\'s refusal with its status and code', async () => {
    const { AgentOxyAppsError } = await import('../../../lib/agent-oxy-apps.js');
    lib.setAgentOxyAppLevel.mockRejectedValueOnce(new AgentOxyAppsError(502, 'oxy_unavailable', 'later'));
    const response = await call('PUT', '/agents/agent-1/oxy-apps/inbox', { level: 'read' });
    expect(response.status).toBe(502);
    expect(response.body.error).toBe('oxy_unavailable');
  });
});
