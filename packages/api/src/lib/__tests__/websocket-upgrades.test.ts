import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * Every WebSocket surface on one HTTP server, with Alia's REAL socket.io
 * (`initSocket`) beside the router — the arrangement production runs.
 *
 * This file runs on Node (vitest) AND on Bun (`test:bun-runtime`, the API's
 * runtime): engine.io's default `destroyUpgrade` ended every non-socket.io
 * socket one second after it opened only under Bun, where an upgraded socket
 * reports `bytesWritten` 0. A suite that only runs on Node cannot see that.
 */

vi.mock('../redis.js', () => ({ getRedisClient: () => null, getRedisSubClient: () => null }));
vi.mock('../logger.js', () => {
  const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: new Proxy({}, { get: () => quiet }) };
});
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: { middleware: { socket: () => (_socket: unknown, next: () => void) => next() } },
}));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/agents/agentRepository.js', () => ({ findAgentOxyAccountId: vi.fn() }));
vi.mock('../agent-account.js', () => ({ verifyAgentAccount: vi.fn() }));
vi.mock('../../db/agents/agentSessionRepository.js', () => ({
  accountHasSessionWithAgent: vi.fn(),
  agentSessionIsOwnedBy: vi.fn(),
}));
vi.mock('../../db/automation/workflowRepository.js', () => ({ findExecutionOwner: vi.fn() }));

const { initSocket } = await import('../../socket.js');
const { routeWebSocketUpgrades } = await import('../websocket-upgrades.js');

const ECHO_PATH = '/ws/echo';
/** Past engine.io's 1 s `destroyUpgradeTimeout`, the window the bug closed sockets in. */
const OUTLIVES_ENGINE_TIMER_MS = 1_500;

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

async function serve(): Promise<string> {
  const server = http.createServer();
  servers.push(server);
  const io = initSocket(server);
  const echo = new WebSocketServer({ noServer: true });
  echo.on('connection', (ws) => ws.on('message', (data) => ws.send(data.toString())));
  routeWebSocketUpgrades(server, {
    socketIoPath: io.path(),
    routes: [
      {
        path: ECHO_PATH,
        handleUpgrade: (request, socket, head) =>
          echo.handleUpgrade(request, socket, head, (ws) => echo.emit('connection', ws, request)),
      },
    ],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('WebSocket upgrades beside socket.io', () => {
  it("keeps a route's socket open past engine.io's destroy timer", async () => {
    const ws = await open(`${await serve()}${ECHO_PATH}`);
    let closedWith: number | null = null;
    ws.on('close', (code) => {
      closedWith = code;
    });
    await new Promise((resolve) => setTimeout(resolve, OUTLIVES_ENGINE_TIMER_MS));
    expect(closedWith).toBeNull();
    const reply = new Promise<string>((resolve) =>
      ws.once('message', (data) => resolve(String(data))),
    );
    ws.send('still here');
    expect(await reply).toBe('still here');
    ws.close();
  });

  it('refuses an upgrade to a path nobody serves with 404', async () => {
    const url = await serve();
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${url}/ws/nobody`);
      ws.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      ws.once('error', () => resolve(-1));
    });
    expect(status).toBe(404);
  });

  it("leaves socket.io's own path to socket.io", async () => {
    const ws = new WebSocket(`${await serve()}/socket.io/?EIO=4&transport=websocket`);
    // Listening before `open`: engine.io writes its open packet with the 101.
    const first = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(String(data)));
      ws.once('error', reject);
    });
    // engine.io's open packet: type 0 and the handshake.
    expect(first.startsWith('0{')).toBe(true);
    ws.close();
  });
});
