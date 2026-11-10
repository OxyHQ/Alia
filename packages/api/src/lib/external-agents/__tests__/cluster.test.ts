/**
 * Two relays sharing one bus behave like two API instances sharing Redis: the daemon is connected to
 * A, the turn starts on B (ADR 0028).
 */
import http from 'node:http';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  links: new Map<string, { agentId: string; ownerOxyUserId: string }>(),
}));

vi.mock('../../socket-session-auth.js', () => ({
  authenticateSocketToken: async (token: string | undefined) =>
    token === 'tok-nate' ? 'user-nate' : null,
}));
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/externalAgentRepository.js', () => ({
  findExternalLink: async (_db: unknown, agentId: string) => state.links.get(agentId),
  markExternalLinkConnected: async () => undefined,
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});

import { createMemoryClusterBus } from '../cluster.js';
import { createExternalAgentRelay, type ExternalAgentRelay } from '../relay.js';
import { routeWebSocketUpgrades } from '../../websocket-upgrades.js';

let a: ExternalAgentRelay;
let b: ExternalAgentRelay;
let server: http.Server;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  state.links.set('agent-1', { agentId: 'agent-1', ownerOxyUserId: 'user-nate' });
  const bus = createMemoryClusterBus();
  a = createExternalAgentRelay({ bus, remoteAckTimeoutMs: 150 });
  b = createExternalAgentRelay({ bus, remoteAckTimeoutMs: 150 });
  server = http.createServer();
  routeWebSocketUpgrades(server, { socketIoPath: '/socket.io/', routes: [a.route] });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  // let both relays finish subscribing
  await new Promise((r) => setTimeout(r, 10));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  a.shutdown();
  b.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function daemonOnA() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/external-agent`);
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  sockets.push(ws);
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  ws.send(JSON.stringify({ type: 'auth', token: 'tok-nate', agentId: 'agent-1' }));
  await waitFor(() => frames.some((f) => f.type === 'auth-ok'));
  return { ws, frames };
}

describe('turns across instances', () => {
  it('reports an agent connected to A as reachable from B, and offline when it leaves', async () => {
    expect(await b.isReachable('agent-1')).toBe(false);
    const { ws } = await daemonOnA();
    expect(a.isLocallyOnline('agent-1')).toBe(true);
    expect(b.isLocallyOnline('agent-1')).toBe(false);
    expect(await b.isReachable('agent-1')).toBe(true);
    ws.close();
    await waitFor(() => !a.isLocallyOnline('agent-1'));
    expect(await b.isReachable('agent-1')).toBe(false);
  });

  it('runs a turn started on B through the daemon connected to A, streaming back', async () => {
    const { ws, frames } = await daemonOnA();
    const deltas: string[] = [];
    const turn = b.runTurn({
      agentId: 'agent-1',
      task: 'say hi',
      history: [{ role: 'user', content: 'earlier' }],
      onDelta: (t) => deltas.push(t),
    });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    const frame = frames.find((f) => f.type === 'turn') as {
      turnId: string;
      task: string;
      history: unknown[];
    };
    expect(frame.task).toBe('say hi');
    expect(frame.history).toHaveLength(1);
    ws.send(JSON.stringify({ type: 'delta', turnId: frame.turnId, text: 'Hel' }));
    ws.send(JSON.stringify({ type: 'delta', turnId: frame.turnId, text: 'lo' }));
    ws.send(JSON.stringify({ type: 'end', turnId: frame.turnId, text: 'Hello' }));
    await expect(turn).resolves.toEqual({ response: 'Hello' });
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('carries a daemon error back to the instance that asked', async () => {
    const { ws, frames } = await daemonOnA();
    const turn = b.runTurn({ agentId: 'agent-1', task: 'x', history: [] });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    const { turnId } = frames.find((f) => f.type === 'turn') as { turnId: string };
    ws.send(JSON.stringify({ type: 'error', turnId, message: 'codex exited 1' }));
    await expect(turn).rejects.toThrow('codex exited 1');
  });

  it('says offline at once when no instance holds the agent', async () => {
    await expect(b.runTurn({ agentId: 'agent-1', task: 'x', history: [] })).rejects.toThrow(
      /not connected/,
    );
  });

  it('says offline when the presence outlived its holder and nobody takes the turn', async () => {
    const bus = createMemoryClusterBus();
    const lonely = createExternalAgentRelay({ bus, remoteAckTimeoutMs: 80 });
    await bus.setPresence('agent-1'); // a crashed instance left its claim behind
    await expect(lonely.runTurn({ agentId: 'agent-1', task: 'x', history: [] })).rejects.toThrow(
      /not connected/,
    );
    lonely.shutdown();
  });

  it('cancels the daemon turn when the asking instance aborts', async () => {
    const { frames } = await daemonOnA();
    const controller = new AbortController();
    const turn = b.runTurn({
      agentId: 'agent-1',
      task: 'x',
      history: [],
      signal: controller.signal,
    });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    controller.abort();
    await expect(turn).rejects.toThrow('Aborted');
    await waitFor(() => frames.some((f) => f.type === 'cancel'));
  });

  it('revoking from B drops the daemon held by A', async () => {
    const { ws, frames } = await daemonOnA();
    b.disconnect('agent-1');
    await waitFor(() => frames.some((f) => f.type === 'revoked'));
    await waitFor(() => ws.readyState === WebSocket.CLOSED);
    expect(a.isLocallyOnline('agent-1')).toBe(false);
  });

  it('serves a local turn without the bus', async () => {
    const { ws, frames } = await daemonOnA();
    const turn = a.runTurn({ agentId: 'agent-1', task: 'x', history: [] });
    await waitFor(() => frames.some((f) => f.type === 'turn'));
    const { turnId } = frames.find((f) => f.type === 'turn') as { turnId: string };
    ws.send(JSON.stringify({ type: 'end', turnId, text: 'ok' }));
    await expect(turn).resolves.toEqual({ response: 'ok' });
  });
});
