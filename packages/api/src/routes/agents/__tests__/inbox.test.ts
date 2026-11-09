/**
 * `/agents/:id/subscriptions` and `/agents/:id/inbox` — what an agent hears about. The rule under test
 * is who may subscribe it to whose events: its owner to their own, anybody who operates it to its own
 * mailbox, and nobody to a third account's.
 */
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  userId: 'owner-1',
  loaded: { ok: true } as { ok: boolean; agent?: unknown; refusal?: string },
  count: 0,
  upsert: vi.fn(),
  remove: vi.fn(),
}));

const AGENT = { _id: 'agent-1', oxyAccountId: 'bot-1', ownerOxyAccountId: 'owner-1' };

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: state.userId }, accessToken: 'TOKEN' });
    next();
  },
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../lib/agent-account.js', () => ({
  loadAgentForActor: vi.fn(async () => state.loaded),
  refusalMessage: () => 'refused',
  refusalStatus: () => 403,
}));
vi.mock('../../../db/agents/agentInboxRepository.js', () => ({
  MAX_SUBSCRIPTIONS_PER_AGENT: 25,
  countAgentSubscriptions: vi.fn(async () => state.count),
  upsertAgentSubscription: state.upsert,
  deleteAgentSubscription: state.remove,
  listAgentSubscriptions: vi.fn(async () => []),
  listInboxItems: vi.fn(async () => []),
}));
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, general: child } };
});

const { default: router } = await import('../inbox.js');

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

async function subscribe(body: unknown) {
  const response = await fetch(`${base}/agents/agent-1/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  state.userId = 'owner-1';
  state.loaded = { ok: true, agent: AGENT };
  state.count = 0;
  state.upsert.mockReset();
  state.upsert.mockImplementation(async (_db, input) => ({ id: 's1', enabled: true, ...input }));
  state.remove.mockReset();
});

describe('POST /agents/:id/subscriptions', () => {
  it("subscribes the agent to its owner's events when the owner asks", async () => {
    const { status } = await subscribe({
      appId: 'inbox',
      eventType: 'new_email',
      account: 'owner',
    });
    expect(status).toBe(201);
    expect(state.upsert).toHaveBeenCalledWith(
      {},
      {
        agentId: 'agent-1',
        ownerAccountId: 'owner-1',
        sourceAccountId: 'owner-1',
        appId: 'inbox',
        eventType: 'new_email',
      },
    );
  });

  it('subscribes the agent to its own mailbox for an operator who is not the owner', async () => {
    state.userId = 'operator-9';
    const { status } = await subscribe({ appId: 'inbox', eventType: '*', account: 'agent' });
    expect(status).toBe(201);
    expect(state.upsert).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ sourceAccountId: 'bot-1', ownerAccountId: 'owner-1' }),
    );
  });

  it("never lets an operator who is not the owner read the owner's events", async () => {
    state.userId = 'operator-9';
    const { status } = await subscribe({
      appId: 'inbox',
      eventType: 'new_email',
      account: 'owner',
    });
    expect(status).toBe(403);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it('has no way to name a third account: the source is only ever owner or agent', async () => {
    const { status } = await subscribe({
      appId: 'inbox',
      eventType: 'new_email',
      account: 'owner',
      sourceAccountId: 'victim-7',
    });
    expect(status).toBe(400);
    expect((await subscribe({ appId: 'inbox', eventType: 'x', account: 'victim-7' })).status).toBe(
      400,
    );
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it('refuses malformed app and event names', async () => {
    expect((await subscribe({ appId: 'In Box!', eventType: 'x', account: 'owner' })).status).toBe(
      400,
    );
    expect((await subscribe({ appId: 'inbox', eventType: '', account: 'owner' })).status).toBe(400);
  });

  it('stops at the subscription limit', async () => {
    state.count = 25;
    const { status } = await subscribe({ appId: 'inbox', eventType: 'x', account: 'owner' });
    expect(status).toBe(409);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it('refuses an agent with no owner to wake it for', async () => {
    state.loaded = { ok: true, agent: { ...AGENT, ownerOxyAccountId: null } };
    expect((await subscribe({ appId: 'inbox', eventType: 'x', account: 'agent' })).status).toBe(
      409,
    );
  });

  it('refuses somebody who does not operate the agent, and an agent that does not exist', async () => {
    state.loaded = { ok: false, refusal: 'not_permitted' };
    expect((await subscribe({ appId: 'inbox', eventType: 'x', account: 'owner' })).status).toBe(
      403,
    );
    state.loaded = { ok: false, refusal: 'agent_not_found' };
    expect((await subscribe({ appId: 'inbox', eventType: 'x', account: 'owner' })).status).toBe(
      404,
    );
  });
});

describe('DELETE /agents/:id/subscriptions/:subscriptionId', () => {
  it('removes one of the agent’s own subscriptions, and 404s on one it does not have', async () => {
    state.remove.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const ok = await fetch(`${base}/agents/agent-1/subscriptions/s1`, { method: 'DELETE' });
    expect(ok.status).toBe(204);
    expect(state.remove).toHaveBeenCalledWith({}, 'agent-1', 's1');
    const missing = await fetch(`${base}/agents/agent-1/subscriptions/nope`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });
});
