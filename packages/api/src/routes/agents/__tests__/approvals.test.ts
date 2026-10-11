/**
 * `POST /agents/approvals/:id/decision` — only the person the action is for,
 * from their own session, with the hash they saw. A service acting for them
 * may list their requests but never answer one.
 */
import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  serviceApp: undefined as undefined | { appId: string },
  decision: { kind: 'decided', status: 'succeeded' } as Record<string, unknown>,
  decide: vi.fn(),
}));

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, {
      user: { id: 'person-1' },
      accessToken: 'PERSON-TOKEN',
      ...(state.serviceApp ? { serviceApp: state.serviceApp } : {}),
    });
    next();
  },
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentRuntimeRepository.js', () => ({
  listPendingApprovals: vi.fn(async () => [
    {
      id: 'ap-1',
      actorType: 'alia',
      agentId: null,
      conversationId: 'conv-1',
      actionHash: 'h-1',
      toolName: 'oxy_social__deletePost',
      summary: 'Deletion · social deletePost {"id":"p1"}',
      details: { kind: 'deletion', display: { id: 'p1' }, args: { id: 'p1' } },
      riskLevel: 'R2',
      threadId: null,
      createdAt: new Date(),
      expiresAt: new Date(),
    },
  ]),
}));
vi.mock('../../../lib/agent/action-review.js', () => ({
  decideReviewedAction: state.decide,
}));

import router from '../approvals.js';

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
  state.serviceApp = undefined;
  state.decide.mockReset();
  state.decide.mockImplementation(async () => state.decision);
});

async function decide(body: unknown) {
  const response = await fetch(`${base}/agents/approvals/ap-1/decision`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('the approvals list', () => {
  it('names the actor, the conversation, the kind and the hash, never the raw arguments', async () => {
    const response = await fetch(`${base}/agents/approvals`);
    const { approvals } = (await response.json()) as { approvals: Array<Record<string, unknown>> };
    expect(approvals[0]).toMatchObject({
      id: 'ap-1',
      actorType: 'alia',
      agentId: null,
      conversationId: 'conv-1',
      kind: 'deletion',
      hash: 'h-1',
      details: { id: 'p1' },
    });
  });
});

describe('a decision', () => {
  it("is the person's own, with their bearer and the hash they saw", async () => {
    expect(await decide({ approved: true, hash: 'h-1' })).toEqual({
      status: 200,
      body: { status: 'succeeded' },
    });
    expect(state.decide).toHaveBeenCalledWith({
      approvalId: 'ap-1',
      deciderAccountId: 'person-1',
      approved: true,
      hash: 'h-1',
      accessToken: 'PERSON-TOKEN',
    });
  });

  it('is refused to a service acting for the person', async () => {
    state.serviceApp = { appId: 'some-app' };
    expect((await decide({ approved: true })).status).toBe(403);
    expect(state.decide).not.toHaveBeenCalled();
  });

  it('maps every refusal to its status', async () => {
    for (const [kind, status] of [
      ['not_found', 404],
      ['changed', 409],
      ['needs_session', 403],
    ] as const) {
      state.decision = { kind };
      expect((await decide({ approved: true })).status).toBe(status);
    }
    expect((await decide({ approved: 'yes' })).status).toBe(400);
    expect((await decide({ approved: true, hash: 7 })).status).toBe(400);
  });
});
