/**
 * `/agents/external/*` — pairing a person's coding-agent CLI with Alia (ADR 0030). The rules under
 * test: a code is minted for the caller and only the caller can redeem it, redeeming creates ONE
 * private unlisted agent plus its link, an unusable code creates nothing, and revoking cuts the
 * daemon off.
 */
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  userId: 'owner-1',
  redeemOk: true,
  online: new Set<string>(),
  createPairing: vi.fn(),
  redeemPairing: vi.fn(),
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
  createBot: vi.fn(),
  createLink: vi.fn(),
  revoke: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: state.userId }, accessToken: 'TOKEN' });
    next();
  },
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentRepository.js', () => ({
  createAgent: state.createAgent,
  deleteAgent: state.deleteAgent,
}));
vi.mock('../../../db/agents/externalAgentRepository.js', () => ({
  createPairing: state.createPairing,
  redeemPairing: state.redeemPairing,
  createExternalLink: state.createLink,
  revokeExternalLink: state.revoke,
  listExternalLinks: vi.fn(async () => [
    { agentId: 'a1', cli: 'codex', hostName: 'laptop', createdAt: 'x', lastConnectedAt: null },
    { agentId: 'a2', cli: 'claude', hostName: 'desk', createdAt: 'y', lastConnectedAt: null },
  ]),
}));
vi.mock('../../../lib/agent-account.js', () => ({ createAgentBotAccount: state.createBot }));
vi.mock('../../../lib/agent-identity.js', () => ({
  suggestAgentUsername: () => 'codex',
  fallbackAgentUsername: () => 'agent',
}));
vi.mock('../../../lib/external-agents/relay.js', () => ({
  isExternalAgentReachable: async (id: string) => state.online.has(id),
  disconnectExternalAgent: state.disconnect,
}));
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, general: child } };
});

const { default: router } = await import('../external-agents.js');

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

beforeEach(() => {
  vi.clearAllMocks();
  state.userId = 'owner-1';
  state.online.clear();
  state.redeemPairing.mockResolvedValue(true);
  state.createBot.mockResolvedValue({ oxyAccountId: 'bot-1', username: 'codexbot' });
  state.createAgent.mockResolvedValue({ _id: 'agent-1' });
  state.revoke.mockResolvedValue(true);
  state.deleteAgent.mockResolvedValue(1);
});

const post = (path: string, body: unknown) =>
  fetch(`${base}/agents/external${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /agents/external/pair', () => {
  it('mints a code for the caller, stores only its hash and returns the prompt', async () => {
    state.userId = 'pair-user-a';
    const response = await post('/pair', { locale: 'es' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { code: string; prompt: string; expiresAt: string };
    expect(body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(body.prompt).toContain(`--code ${body.code}`);
    expect(body.prompt).toContain('Quiero conectarte');
    const stored = state.createPairing.mock.calls[0][1] as {
      codeHash: string;
      ownerOxyUserId: string;
    };
    expect(stored.ownerOxyUserId).toBe('pair-user-a');
    expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(body.code);
  });

  it('rate limits a burst of codes', async () => {
    state.userId = 'pair-user-burst';
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await post('/pair', {})).status);
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe('POST /agents/external/redeem', () => {
  const valid = { code: 'ABCD-EFGH-JKMN', cli: 'codex', hostName: 'laptop' };

  it('creates a private, unlisted agent and its link for the redeeming account', async () => {
    const response = await post('/redeem', valid);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ agentId: 'agent-1', cli: 'codex' });
    const redeem = state.redeemPairing.mock.calls[0][1] as { ownerOxyUserId: string };
    expect(redeem.ownerOxyUserId).toBe('owner-1');
    const agent = state.createAgent.mock.calls[0][1] as Record<string, unknown>;
    expect(agent).toMatchObject({
      isPublished: false,
      access: 'private',
      ownerOxyAccountId: 'owner-1',
    });
    expect(state.createLink).toHaveBeenCalledWith(
      {},
      { agentId: 'agent-1', ownerOxyUserId: 'owner-1', cli: 'codex', hostName: 'laptop' },
    );
  });

  it('creates nothing when the code is unknown, expired, used, or not the caller’s', async () => {
    state.redeemPairing.mockResolvedValue(false);
    const response = await post('/redeem', valid);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_or_expired_code' });
    expect(state.createBot).not.toHaveBeenCalled();
    expect(state.createAgent).not.toHaveBeenCalled();
    expect(state.createLink).not.toHaveBeenCalled();
  });

  it('rejects malformed requests before touching the database', async () => {
    for (const body of [
      { ...valid, cli: 'gemini' },
      { ...valid, code: 'short' },
      { ...valid, hostName: '' },
      { ...valid, extra: true },
    ]) {
      expect((await post('/redeem', body)).status).toBe(400);
    }
    expect(state.redeemPairing).not.toHaveBeenCalled();
  });

  it('reports a pairing failure after the code was consumed', async () => {
    state.createBot.mockRejectedValue(new Error('oxy down'));
    const response = await post('/redeem', valid);
    expect(response.status).toBe(502);
    expect(state.createLink).not.toHaveBeenCalled();
  });
});

describe('GET and DELETE /agents/external', () => {
  it('lists the agents with live presence', async () => {
    state.online.add('a2');
    const body = (await (await fetch(`${base}/agents/external`)).json()) as {
      agents: { agentId: string; online: boolean }[];
    };
    expect(body.agents.map((a) => [a.agentId, a.online])).toEqual([
      ['a1', false],
      ['a2', true],
    ]);
  });

  it('revokes and disconnects, and 404s when it is not the caller’s', async () => {
    const ok = await fetch(`${base}/agents/external/agent-1`, { method: 'DELETE' });
    expect(ok.status).toBe(204);
    expect(state.revoke).toHaveBeenCalledWith({}, 'owner-1', 'agent-1');
    expect(state.disconnect).toHaveBeenCalledWith('agent-1');
    expect(state.deleteAgent).toHaveBeenCalledWith({}, 'agent-1');

    state.revoke.mockResolvedValue(false);
    state.disconnect.mockClear();
    state.deleteAgent.mockClear();
    const missing = await fetch(`${base}/agents/external/agent-9`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(state.disconnect).not.toHaveBeenCalled();
    expect(state.deleteAgent).not.toHaveBeenCalled();
  });
});
