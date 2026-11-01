import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Exercise the actual HTTP router with controlled authentication and repository
 * fixtures. Token verification and SQL execution are covered separately; these
 * fixtures model their results and do not establish either guarantee.
 */
const fixture = vi.hoisted(() => ({
  agents: [
    { _id: 'agent-a', ownerOxyAccountId: 'account-a', name: 'A' },
    { _id: 'agent-b', ownerOxyAccountId: 'account-b', name: 'B' },
  ],
  preferences: new Map<string, Map<string | null, boolean>>(),
  writes: vi.fn(),
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => {
    const id =
      req.get('authorization') === 'Bearer a'
        ? 'account-a'
        : req.get('authorization') === 'Bearer b'
          ? 'account-b'
          : undefined;
    if (!id) return res.status(401).json({ error: 'Unauthorized' });
    Object.assign(req, { user: { id } });
    next();
  },
}));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/notifications/notificationRepository.js', () => ({}));
vi.mock('../../db/schema/notifications.js', () => ({
  NOTIFICATION_STATUSES: [],
  NOTIFICATION_TYPES: [],
  PUSH_TOKEN_PLATFORMS: [],
}));
vi.mock('../../lib/notification-service.js', () => ({}));
vi.mock('../../db/agents/agentRepository.js', () => ({
  findAgentById: async (_db: unknown, id: string) =>
    fixture.agents.find((agent) => agent._id === id) ?? null,
  listAgentsOwnedBy: async (_db: unknown, id: string) =>
    fixture.agents.filter((agent) => agent.ownerOxyAccountId === id),
}));
vi.mock('../../db/proactive/emailOutreachRepository.js', () => ({
  EMAIL_ALERTS_DEFAULT: true,
  listEmailAlertPreferences: async (_db: unknown, id: string) =>
    fixture.preferences.get(id) ?? new Map(),
  setEmailAlertPreference: async (
    _db: unknown,
    input: { oxyUserId: string; agentId: string | null; enabled: boolean },
  ) => {
    fixture.writes(input);
    const values = fixture.preferences.get(input.oxyUserId) ?? new Map();
    values.set(input.agentId, input.enabled);
    fixture.preferences.set(input.oxyUserId, values);
  },
}));
vi.mock('../../lib/agent-identity.js', () => ({
  attachAgentIdentities: async (agents: unknown) => agents,
}));
vi.mock('../../lib/logger.js', () => ({ log: { general: { error: vi.fn(), info: vi.fn() } } }));
vi.mock('../../lib/web-push.js', () => ({ VAPID_PUBLIC_KEY: null }));

const { default: router } = await import('../notifications.js');
let server: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/notifications', router);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  url = `http://127.0.0.1:${address.port}/notifications/email-alerts`;
});
afterAll(
  async () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
);
beforeEach(() => {
  fixture.preferences.clear();
  fixture.writes.mockClear();
});

async function put(token: string | null, body: unknown) {
  return fetch(url, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('email alert ownership over HTTP', () => {
  it('allows the owner to change their agent and personal switch', async () => {
    expect((await put('a', { agentId: 'agent-a', enabled: false })).status).toBe(200);
    expect((await put('a', { agentId: null, enabled: false })).status).toBe(200);
    expect(fixture.writes.mock.calls.map(([value]) => value)).toEqual([
      { oxyUserId: 'account-a', agentId: 'agent-a', enabled: false },
      { oxyUserId: 'account-a', agentId: null, enabled: false },
    ]);
  });

  it('returns the same 404 for an agent belonging to another account and an unknown agent without writing', async () => {
    const foreign = await put('a', { agentId: 'agent-b', enabled: false });
    const missing = await put('a', { agentId: 'unknown', enabled: false });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(fixture.writes).not.toHaveBeenCalled();
  });

  it('returns only the authenticated account’s own agents and preferences', async () => {
    await put('a', { agentId: 'agent-a', enabled: false });
    await put('b', { agentId: null, enabled: false });
    const response = await fetch(url, { headers: { authorization: 'Bearer b' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      alia: { enabled: false },
      agents: [{ agentId: 'agent-b', name: 'B', enabled: true }],
    });
  });

  it('refuses unauthenticated requests and malformed writes before reaching storage', async () => {
    expect((await put(null, { agentId: null, enabled: false })).status).toBe(401);
    expect((await put('a', { agentId: 'agent-a', enabled: 'false' })).status).toBe(400);
    expect(fixture.writes).not.toHaveBeenCalled();
  });
});
