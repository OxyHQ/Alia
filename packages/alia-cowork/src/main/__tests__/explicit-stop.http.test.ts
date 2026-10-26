import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { OxyServices } from '@oxy.so/core';

const world = vi.hoisted(() => ({
  baseURL: '',
  oxy: null as OxyServices | null,
  listeners: new Set<() => void>(),
}));
vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('electron-store', () => ({
  default: class {
    get(key: string) {
      return key === 'apiBaseUrl' ? world.baseURL : undefined;
    }
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug() {}, warn() {}, error() {}, info() {} }),
}));
vi.mock('../auth', () => ({
  currentAccessToken: () => 'fixture-present',
  linkedAliaClient: () => {
    if (!world.oxy) throw new Error('No test transport');
    return world.oxy.createLinkedClient({ baseURL: world.baseURL });
  },
  onSessionContextChange: (listener: () => void) => {
    world.listeners.add(listener);
    return () => world.listeners.delete(listener);
  },
}));
vi.mock('../catalogue', () => ({ resolveModelId: async () => undefined }));
import { ChatProvider } from '../chat';

const servers: Server[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  world.oxy?.dispose();
  world.oxy = null;
  world.listeners.clear();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
function bearer(account: string) {
  return `e30.${Buffer.from(JSON.stringify({ userId: account, sessionId: account, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
}
async function fixture(twoRounds = false) {
  const requests: { path?: string; auth?: string; turnId?: string }[] = [];
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let refused = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const value = body ? JSON.parse(body) : {};
    requests.push({ path: req.url, auth: req.headers.authorization, turnId: value.turnId });
    if (req.url === '/alia/chat') {
      if (twoRounds && requests.filter((r) => r.path === '/alia/chat').length === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture-tool', function: { name: 'read_file', arguments: '{"path":"owned"}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
        );
      } else arrived();
    } else if (req.url?.endsWith('/cancel')) {
      res.writeHead(refused ? 503 : 200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          refused
            ? { error: { code: 'unavailable' } }
            : { turnId: req.url.split('/').at(-2), state: 'cancelled' },
        ),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  world.baseURL = `http://127.0.0.1:${address.port}`;
  const oxy = new OxyServices({ baseURL: world.baseURL });
  world.oxy = oxy;
  const token = bearer('a');
  oxy.session.setAccessToken(token);
  const sent: { channel: string; data: { generationContinues?: boolean } }[] = [];
  const chat = new ChatProvider(
    {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, data: (typeof sent)[number]['data']) =>
          sent.push({ channel, data }),
      },
    } as never,
    { reset() {}, closeBrowser: async () => {}, readFile: async () => 'owned fixture' } as never,
  );
  disposers.push(() => chat.dispose());
  return {
    chat,
    requests,
    started,
    sent,
    token,
    setRefused: (value: boolean) => {
      refused = value;
    },
    switchAccount: () => {
      oxy.session.setAccessToken(bearer('b'));
      for (const listener of world.listeners) listener();
    },
  };
}

it('Cowork Stop before response headers acknowledges one remote cancellation before ending', async () => {
  const f = await fixture();
  const run = f.chat.handleMessage('owned fixture');
  await f.started;
  const id = f.requests[0].turnId;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await Promise.all([f.chat.stop(), f.chat.stop()]);
  await run;
  expect(f.requests.map((r) => r.path)).toEqual(['/alia/chat', `/v1/chat/turns/${id}/cancel`]);
  expect(f.requests.every((r) => r.auth === `Bearer ${f.token}`)).toBe(true);
});

it('a refused Stop keeps the active generation and permits retry, not a duplicate chat', async () => {
  const f = await fixture();
  const run = f.chat.handleMessage('owned fixture');
  await f.started;
  f.setRefused(true);
  await f.chat.stop();
  expect(f.sent).toContainEqual(
    expect.objectContaining({
      channel: 'chat:error',
      data: expect.objectContaining({ generationContinues: true }),
    }),
  );
  expect(f.sent.some((e) => e.channel === 'chat:end')).toBe(false);
  f.setRefused(false);
  await f.chat.stop();
  await run;
  expect(f.requests.filter((r) => r.path === '/alia/chat')).toHaveLength(1);
  expect(f.requests.filter((r) => r.path?.endsWith('/cancel'))).toHaveLength(2);
});

it.each(['switch', 'dispose'] as const)(
  '%s detaches without remote cancellation or replacement-account control',
  async (action) => {
    const f = await fixture();
    const run = f.chat.handleMessage('owned fixture');
    await f.started;
    if (action === 'switch') f.switchAccount();
    else f.chat.dispose();
    await run;
    await f.chat.stop();
    expect(f.requests.filter((r) => r.path?.endsWith('/cancel'))).toEqual([]);
  },
);

it('each tool continuation has its own ID and Stop targets only the active HTTP generation', async () => {
  const f = await fixture(true);
  const run = f.chat.handleMessage('owned fixture');
  await f.started;
  const turns = f.requests.filter((r) => r.path === '/alia/chat');
  expect(turns).toHaveLength(2);
  expect(turns[0].turnId).not.toBe(turns[1].turnId);
  await f.chat.stop();
  await run;
  expect(f.requests.filter((r) => r.path?.endsWith('/cancel')).map((r) => r.path)).toEqual([
    `/v1/chat/turns/${turns[1].turnId}/cancel`,
  ]);
  expect(f.requests.filter((r) => r.path === '/alia/chat')).toHaveLength(2);
});
