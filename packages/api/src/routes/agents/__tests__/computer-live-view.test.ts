/**
 * `/agents/:id/computer/*` — the live view — and the one rule it rests on:
 * the computer is addressed by the CALLER's own Oxy user, so nobody reaches a
 * computer that is not theirs, whatever they put in the request.
 *
 * A real express app with the router mounted; Oxy auth, the agent lookup, the
 * reach rule and the computer host replaced by doubles.
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerHostError, type ComputerClient } from '../../../lib/computer/computer-client.js';
import { clientDouble } from '../../../lib/computer/__tests__/client-double.js';

const state = vi.hoisted(() => ({
  userId: 'oxy-person' as string | undefined,
  agent: {
    _id: 'agent-1',
    capabilityGrants: ['computer'],
    access: 'public',
    status: 'active',
  } as Record<string, unknown> | null,
  reach: 'reachable' as 'reachable' | 'out_of_reach' | 'identity_unavailable',
  client: null as ComputerClient | null,
}));

vi.mock('../../../middleware/auth.js', () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => {
    if (!state.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    (req as Request & { user?: { id: string }; accessToken?: string }).user = { id: state.userId };
    (req as Request & { accessToken?: string }).accessToken = 'token';
    next();
  },
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentRepository.js', () => ({
  findAgentById: async () => state.agent,
}));
vi.mock('../../../lib/agent-account.js', () => ({
  canReachAgent: async () => state.reach,
}));
vi.mock('../../../lib/computer/computer-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/computer/computer-client.js')>();
  return { ...actual, getComputerClient: () => state.client };
});

const { default: router } = await import('../computer.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/agents', router);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/agents`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  state.userId = 'oxy-person';
  state.agent = {
    _id: 'agent-1',
    capabilityGrants: ['computer'],
    access: 'public',
    status: 'active',
  };
  state.reach = 'reachable';
  state.client = clientDouble();
});

const host = () => state.client as ComputerClient;

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('whose computer', () => {
  it("is always the caller's own computer with this agent", async () => {
    const response = await fetch(`${base}/agent-1/computer`);
    expect(response.status).toBe(200);
    expect(host().status).toHaveBeenCalledWith('agent:agent-1:user:oxy-person');
    expect(host().browserStatus).toHaveBeenCalledWith('agent:agent-1:user:oxy-person');
    expect(await response.json()).toMatchObject({ granted: true, browser: { state: 'open' } });
  });

  it('cannot be steered to another person by anything in the request', async () => {
    await fetch(
      `${base}/agent-1/computer/browser/screenshot?user=oxy-creator&actor=agent:agent-1:user:oxy-creator`,
    );
    await post('/agent-1/computer/browser/input', { input: { type: 'click', x: 1, y: 1 } });
    for (const mock of [host().browserScreenshot, host().browserInput]) {
      expect(
        (mock as ReturnType<typeof vi.fn>).mock.calls.every(
          (args) => args[0] === 'agent:agent-1:user:oxy-person',
        ),
      ).toBe(true);
    }
    // A body that tries to name the actor or the role is refused outright.
    const smuggled = await post('/agent-1/computer/browser/input', {
      input: { type: 'click', x: 1, y: 1 },
      actorId: 'agent:agent-1:user:oxy-creator',
    });
    expect(smuggled.status).toBe(400);
  });

  it('is "not found" for an agent the caller cannot reach, and the host is never asked', async () => {
    state.reach = 'out_of_reach';
    for (const response of [
      await fetch(`${base}/agent-1/computer`),
      await fetch(`${base}/agent-1/computer/browser/screenshot`),
      await post('/agent-1/computer/browser/control', { controller: 'owner' }),
    ]) {
      expect(response.status).toBe(404);
    }
    state.agent = null;
    expect((await fetch(`${base}/missing/computer/files`)).status).toBe(404);
    const client = host();
    for (const method of [
      'status',
      'browserStatus',
      'browserScreenshot',
      'browserControl',
      'list',
    ] as const) {
      expect(client[method]).not.toHaveBeenCalled();
    }
  });

  it('says "try again" when Oxy cannot tell whether the caller may reach the agent', async () => {
    state.reach = 'identity_unavailable';
    expect((await fetch(`${base}/agent-1/computer`)).status).toBe(503);
  });

  it('requires a signed-in person', async () => {
    state.userId = undefined;
    expect((await fetch(`${base}/agent-1/computer`)).status).toBe(401);
  });

  it('is absent on a deployment without a computer host', async () => {
    state.client = null;
    const response = await fetch(`${base}/agent-1/computer`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'computer_unavailable' });
  });
});

describe('the live browser', () => {
  it('serves the screenshot as base64 JSON, uncached', async () => {
    const response = await fetch(`${base}/agent-1/computer/browser/screenshot`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      mimeType: 'image/jpeg',
      width: 1280,
      height: 800,
      data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'),
    });
  });

  it('acts as the OWNER: input, navigation, take over and hand back', async () => {
    await post('/agent-1/computer/browser/input', { input: { type: 'type', text: 'secret' } });
    await post('/agent-1/computer/browser/navigate', { url: 'https://example.com/login' });
    await post('/agent-1/computer/browser/control', { controller: 'owner' });
    await post('/agent-1/computer/browser/control', { controller: 'agent' });
    const actor = 'agent:agent-1:user:oxy-person';
    expect(host().browserInput).toHaveBeenCalledWith(
      actor,
      { type: 'type', text: 'secret' },
      'owner',
    );
    expect(host().browserNavigate).toHaveBeenCalledWith(
      actor,
      'https://example.com/login',
      'owner',
    );
    expect(host().browserControl).toHaveBeenNthCalledWith(1, actor, 'owner');
    expect(host().browserControl).toHaveBeenNthCalledWith(2, actor, 'agent');
  });

  it('refuses input outside the vocabulary before the host is asked', async () => {
    for (const input of [
      { type: 'key', key: 'F12' },
      { type: 'evaluate', script: 'document.cookie' },
      { type: 'click', x: 99999, y: 1 },
      { type: 'type', text: '' },
    ]) {
      expect((await post('/agent-1/computer/browser/input', { input })).status).toBe(400);
    }
    expect(
      (await post('/agent-1/computer/browser/navigate', { url: 'javascript:alert(1)' })).status,
    ).toBe(400);
    expect(host().browserInput).not.toHaveBeenCalled();
  });

  it("passes the host's refusals through, but never its 5xx wording", async () => {
    state.client = clientDouble({
      browserScreenshot: vi.fn(async () => {
        throw new ComputerHostError('The browser is not open', 409, 'browser_closed');
      }),
      browserInput: vi.fn(async () => {
        throw new ComputerHostError(
          'docker said /var/lib/docker/... failed',
          502,
          'browser_failed',
        );
      }),
    });
    const closed = await fetch(`${base}/agent-1/computer/browser/screenshot`);
    expect(closed.status).toBe(409);
    expect(await closed.json()).toMatchObject({ error: 'browser_closed' });
    const failed = await post('/agent-1/computer/browser/input', {
      input: { type: 'click', x: 1, y: 1 },
    });
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain('/var/lib/docker');
  });
});

describe('files and receipts (read-only)', () => {
  it('lists and reads only inside /workspace', async () => {
    expect((await fetch(`${base}/agent-1/computer/files?path=/workspace/downloads`)).status).toBe(
      200,
    );
    expect(host().list).toHaveBeenCalledWith(
      'agent:agent-1:user:oxy-person',
      '/workspace/downloads',
    );
    expect((await fetch(`${base}/agent-1/computer/files?path=/etc`)).status).toBe(400);
    expect((await fetch(`${base}/agent-1/computer/files/content?path=/workspace/a`)).status).toBe(
      200,
    );
    expect((await fetch(`${base}/agent-1/computer/files/content`)).status).toBe(400);
  });

  it('lists recent commands without their output, and browser actions', async () => {
    const response = await fetch(`${base}/agent-1/computer/receipts`);
    const body = (await response.json()) as {
      commands: Record<string, unknown>[];
      browser: unknown[];
    };
    expect(body.commands[0]).toMatchObject({ command: 'ls', status: 'succeeded' });
    expect(body.commands[0]).not.toHaveProperty('stdout');
    expect(body.browser).toEqual([]);
  });

  it('offers no route that writes a file or runs a command', async () => {
    expect(
      (await post('/agent-1/computer/files/content', { path: '/workspace/a', text: 'x' })).status,
    ).toBe(404);
    expect((await post('/agent-1/computer/commands', { command: 'ls' })).status).toBe(404);
    expect(host().write).not.toHaveBeenCalled();
    expect(host().run).not.toHaveBeenCalled();
  });
});
