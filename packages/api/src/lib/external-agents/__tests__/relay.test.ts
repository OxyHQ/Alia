import http from 'node:http';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  tokens: new Map<string, string>(),
  links: new Map<string, { agentId: string; ownerOxyUserId: string }>(),
}));

vi.mock('../../socket-session-auth.js', () => ({
  authenticateSocketToken: async (token: string | undefined) =>
    (token && state.tokens.get(token)) || null,
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/externalAgentRepository.js', () => ({
  findExternalLink: async (_db: unknown, agentId: string) => state.links.get(agentId),
  markExternalLinkConnected: async () => undefined,
}));

import {
  disconnectExternalAgent,
  externalAgentRelayRoute,
  isExternalAgentOnline,
  runExternalTurn,
  shutdownExternalAgentRelay,
} from '../relay.js';
import { routeWebSocketUpgrades } from '../../websocket-upgrades.js';

let server: http.Server;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  state.tokens.clear();
  state.links.clear();
  state.tokens.set('tok-nate', 'user-nate');
  state.tokens.set('tok-eve', 'user-eve');
  state.links.set('agent-1', { agentId: 'agent-1', ownerOxyUserId: 'user-nate' });
  server = http.createServer();
  routeWebSocketUpgrades(server, {
    socketIoPath: '/socket.io/',
    routes: [externalAgentRelayRoute(undefined, { authTimeoutMs: 300 })],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  shutdownExternalAgentRelay();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function open(): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/external-agent`);
    const frames: Record<string, unknown>[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', reject);
    sockets.push(ws);
  });
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function connect(token = 'tok-nate', agentId = 'agent-1') {
  const client = await open();
  client.ws.send(JSON.stringify({ type: 'auth', token, agentId }));
  return client;
}

describe('external agent relay', () => {
  it('authenticates the owner of a live link and reports presence', async () => {
    const { frames } = await connect();
    await waitFor(() => frames.length > 0);
    expect(frames[0]).toEqual({ type: 'auth-ok', agentId: 'agent-1' });
    expect(isExternalAgentOnline('agent-1')).toBe(true);
  });

  it('refuses a valid session that does not own the agent', async () => {
    const { frames, ws } = await connect('tok-eve');
    await waitFor(() => frames.length > 0);
    expect(frames[0]).toEqual({ type: 'auth-error', reason: 'unknown_agent' });
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
    expect(isExternalAgentOnline('agent-1')).toBe(false);
  });

  it('refuses a bad token and an unknown agent', async () => {
    const bad = await connect('nope');
    await waitFor(() => bad.frames.length > 0);
    expect(bad.frames[0]).toEqual({ type: 'auth-error', reason: 'invalid_token' });
    const unknown = await connect('tok-nate', 'agent-404');
    await waitFor(() => unknown.frames.length > 0);
    expect(unknown.frames[0]).toEqual({ type: 'auth-error', reason: 'unknown_agent' });
  });

  it('closes a socket that never authenticates', async () => {
    const { ws } = await open();
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
  });

  it('streams a turn: deltas are surfaced and end resolves with the full text', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    const deltas: string[] = [];
    const turn = runExternalTurn({
      agentId: 'agent-1',
      task: 'say hi',
      history: [{ role: 'user', content: 'earlier' }],
      onDelta: (t) => deltas.push(t),
    });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    const frame = frames.find((f) => f.type === 'turn') as { turnId: string; task: string };
    expect(frame.task).toBe('say hi');
    ws.send(JSON.stringify({ type: 'delta', turnId: frame.turnId, text: 'Hel' }));
    ws.send(JSON.stringify({ type: 'delta', turnId: frame.turnId, text: 'lo' }));
    ws.send(JSON.stringify({ type: 'end', turnId: frame.turnId }));
    await expect(turn).resolves.toEqual({ response: 'Hello' });
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('fails a turn when the daemon reports an error', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    const turn = runExternalTurn({ agentId: 'agent-1', task: 'x', history: [] });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    const { turnId } = frames.find((f) => f.type === 'turn') as { turnId: string };
    ws.send(JSON.stringify({ type: 'error', turnId, message: 'codex exited 1' }));
    await expect(turn).rejects.toThrow('codex exited 1');
  });

  it('answers offline without hanging when nobody is connected', async () => {
    await expect(runExternalTurn({ agentId: 'agent-1', task: 'x', history: [] })).rejects.toThrow(
      /not connected/,
    );
  });

  it('fails an in-flight turn when the daemon drops', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    const turn = runExternalTurn({ agentId: 'agent-1', task: 'x', history: [] });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    ws.terminate();
    await expect(turn).rejects.toThrow(/disconnected/);
    expect(isExternalAgentOnline('agent-1')).toBe(false);
  });

  it('times a turn out and tells the daemon to cancel', async () => {
    const { frames } = await connect();
    await waitFor(() => frames.length > 0);
    const turn = runExternalTurn({ agentId: 'agent-1', task: 'x', history: [], timeoutMs: 50 });
    await expect(turn).rejects.toThrow(/did not answer/);
    await waitFor(() => frames.some((f) => f.type === 'cancel'));
  });

  it('cuts the daemon off on revocation', async () => {
    const { ws, frames } = await connect();
    await waitFor(() => frames.length > 0);
    disconnectExternalAgent('agent-1');
    await waitFor(() => frames.some((f) => f.type === 'revoked'));
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
    expect(isExternalAgentOnline('agent-1')).toBe(false);
  });

  it('ignores answers for a turn that belongs to another agent', async () => {
    state.links.set('agent-2', { agentId: 'agent-2', ownerOxyUserId: 'user-nate' });
    const one = await connect('tok-nate', 'agent-1');
    const two = await connect('tok-nate', 'agent-2');
    await waitFor(() => one.frames.length > 0 && two.frames.length > 0);
    const turn = runExternalTurn({ agentId: 'agent-1', task: 'x', history: [], timeoutMs: 200 });
    await waitFor(() => one.frames.some((f) => f.type === 'turn'));
    const { turnId } = one.frames.find((f) => f.type === 'turn') as { turnId: string };
    two.ws.send(JSON.stringify({ type: 'end', turnId, text: 'forged' }));
    await expect(turn).rejects.toThrow(/did not answer/);
  });
});
