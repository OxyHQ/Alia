/**
 * `GET /agents/:id/primary-tool-options` — the app tools the agent editor may
 * make an agent's primary tools, for whoever operates it: the agent's list,
 * the limit, and the tools of every app it reaches.
 */
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  loaded: { ok: true, agent: { _id: 'sindi', primaryTools: ['homiio:searchListings'] } } as {
    ok: boolean;
    agent?: unknown;
    refusal?: string;
  },
  options: vi.fn(),
}));

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { user: { id: 'operator-1' }, accessToken: 'OPERATOR-TOKEN' });
    next();
  },
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../lib/agent-account.js', () => ({
  loadAgentForActor: vi.fn(async () => state.loaded),
  refusalMessage: () => 'refused',
  refusalStatus: () => 403,
}));
vi.mock('../../../lib/agent-primary-tools.js', () => ({ listPrimaryToolOptions: state.options }));
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, general: child } };
});

const { AgentOxyAppsError } = await import('../../../lib/agent-oxy-apps.js');
const { default: router } = await import('../primary-tools.js');

const app = express();
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

async function options() {
  const response = await fetch(`${base}/agents/sindi/primary-tool-options`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const HOMIIO = {
  appId: 'homiio',
  name: 'Homiio',
  tools: [{ key: 'homiio:searchListings', name: 'searchListings', description: 'Search' }],
};

beforeEach(() => {
  state.loaded = { ok: true, agent: { _id: 'sindi', primaryTools: ['homiio:searchListings'] } };
  state.options.mockReset();
  state.options.mockResolvedValue([HOMIIO]);
});

describe('GET /agents/:id/primary-tool-options', () => {
  it("answers the agent's primary tools, the limit, and what it reaches, asked with the operator's bearer", async () => {
    const { status, body } = await options();
    expect(status).toBe(200);
    expect(body).toEqual({ primaryTools: ['homiio:searchListings'], max: 12, apps: [HOMIIO] });
    expect(state.options).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'sindi' }),
      'OPERATOR-TOKEN',
    );
  });

  it('refuses somebody who does not operate the agent, and an agent that does not exist', async () => {
    state.loaded = { ok: false, refusal: 'not_permitted' };
    expect((await options()).status).toBe(403);
    state.loaded = { ok: false, refusal: 'agent_not_found' };
    expect((await options()).status).toBe(404);
    expect(state.options).not.toHaveBeenCalled();
  });

  it('passes on an Oxy refusal of the operator, and says when the apps could not be read', async () => {
    state.options.mockRejectedValueOnce(
      new AgentOxyAppsError(403, 'agent_operator_required', 'no'),
    );
    expect((await options()).status).toBe(403);
    state.options.mockRejectedValueOnce(new Error('Oxy is unreachable'));
    expect((await options()).status).toBe(503);
  });
});
