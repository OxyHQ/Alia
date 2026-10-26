import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { OxyServices } from '@oxy.so/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  baseUrl: '',
  oxy: undefined as OxyServices | undefined,
  model: () => Promise.resolve('fixture/model'),
  disposeCount: 0,
}));
vi.mock('../config.js', () => ({ config: { get: () => world.baseUrl } }));
vi.mock('../catalogue.js', () => ({ resolveModelId: () => world.model() }));
vi.mock('../oxy-session.js', () => ({
  restoreSession: async () => true,
  linkedAliaClient: () => {
    const linked = world.oxy!.createLinkedClient({ baseURL: world.baseUrl });
    return {
      fetch: linked.fetch,
      dispose() {
        world.disposeCount++;
        linked.dispose();
      },
    };
  },
  onSessionContextChange: (listener: () => void) => {
    const http = world.oxy!.http;
    const epoch = http.getSessionEpoch();
    return http.addTokenChangeListener(() => {
      if (http.getSessionEpoch() !== epoch) listener();
    });
  },
}));
const executeTool = vi.hoisted(() =>
  vi.fn(async () => ({ result: 'fixture file', success: true })),
);
vi.mock('../../tools/executor.js', () => ({ executeTool }));
vi.mock('../context.js', () => ({
  buildSystemMessage: () => '',
  getCodebaseContext: async () => '',
  loadProjectInstructions: async () => '',
}));
import { runPrompt } from '../../commands/run.js';
import { streamChat } from '../api.js';
import { createConversationControl } from '../turn-control.js';
import { processConversation, type Message } from '../conversation.js';

const tokenExpiry = Math.floor(Date.now() / 1000) + 3600;
function token(account: string, revision = 1) {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'HS256' })}.${enc({ userId: account, sessionId: `session-${account}`, revision, exp: tokenExpiry })}.fixture`;
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const data = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const done = 'data: [DONE]\n\n';
function ack(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ turnId: req.url?.split('/').at(-2), state: 'cancelled' }));
}
let server: Server;
const controls: ReturnType<typeof createConversationControl>[] = [];
async function start(
  handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void,
) {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    handler(req, res, JSON.parse(body || '{}'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  world.baseUrl = `http://127.0.0.1:${address.port}`;
  world.oxy = new OxyServices({ baseURL: world.baseUrl });
  world.oxy.session.setAccessToken(token('alice'));
}
function control() {
  const value = createConversationControl();
  controls.push(value);
  return value;
}
const callbacks = () => ({ onContent: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
beforeEach(() => {
  world.disposeCount = 0;
  world.model = () => Promise.resolve('fixture/model');
  executeTool.mockClear();
});
afterEach(async () => {
  for (const value of controls.splice(0)) value.dispose();
  world.oxy?.dispose();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('CLI shared Stop over real HTTP and Oxy linked transport', () => {
  it('waits for a late ACK even when cancellation SSE already ended; duplicate Stop never repeats generation', async () => {
    let chat!: ServerResponse;
    let acknowledge!: () => void;
    let generations = 0,
      stops = 0;
    let turnId: unknown;
    await start((req, res, body) => {
      if (req.url === '/alia/chat') {
        generations++;
        turnId = body.turnId;
        chat = res;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(data({ content: 'partial' }));
      } else {
        stops++;
        expect(req.url).toBe(`/v1/chat/turns/${turnId}/cancel`);
        chat.end('data: {"error":{"code":"turn_cancelled","message":"Stopped"}}\n\n' + done);
        acknowledge = () => ack(req, res);
      }
    });
    const runControl = control(),
      handlers = callbacks();
    let finished = false;
    const running = streamChat([], '', '', handlers, undefined, runControl).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(handlers.onContent).toHaveBeenCalledWith('partial'));
    const first = runControl.stop(),
      second = runControl.stop();
    await vi.waitFor(() => expect(stops).toBe(1));
    expect(finished).toBe(false);
    expect(world.disposeCount).toBe(0);
    acknowledge();
    await Promise.all([first, second, running]);
    expect(generations).toBe(1);
    expect(stops).toBe(1);
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(world.disposeCount).toBe(1);
  });

  it('early Stop uses a UUID tombstone and never dispatches generation after async preparation', async () => {
    const model = deferred<string>();
    world.model = () => model.promise;
    const paths: string[] = [];
    await start((req, res) => {
      paths.push(req.url!);
      ack(req, res);
    });
    const runControl = control();
    const running = streamChat([], '', '', callbacks(), undefined, runControl);
    await vi.waitFor(() => expect(world.disposeCount).toBe(0));
    // Let restore complete and attach the shared control before the blocked catalogue lookup.
    await new Promise((resolve) => setImmediate(resolve));
    await runControl.stop();
    model.resolve('fixture/model');
    await running;
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^\/v1\/chat\/turns\/[0-9a-f-]{36}\/cancel$/);
  });

  it('refreshes one JSON request with the SAME turn ID, and uses refreshed credentials for Stop', async () => {
    const bodies: unknown[] = [],
      auth: string[] = [];
    let chat!: ServerResponse;
    await start((req, res, body) => {
      auth.push(req.headers.authorization!);
      if (req.url === '/alia/chat') {
        bodies.push(body);
        if (bodies.length === 1) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        chat = res;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(data({ content: 'ready' }));
      } else {
        ack(req, res);
        chat.end(done);
      }
    });
    const refreshed = token('alice', 2);
    world.oxy!.http.setAuthRefreshHandler(async () => refreshed);
    const runControl = control(),
      handlers = callbacks();
    const running = streamChat(
      [{ role: 'user', content: 'fixture' }],
      '',
      '',
      handlers,
      undefined,
      runControl,
    );
    await vi.waitFor(() => expect(handlers.onContent).toHaveBeenCalled());
    await runControl.stop();
    await running;
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(auth).toEqual([
      `Bearer ${token('alice')}`,
      `Bearer ${refreshed}`,
      `Bearer ${refreshed}`,
    ]);
  });

  it('account switch fences a pending Stop; it never sends the old turn under the new account', async () => {
    const auth: string[] = [];
    let chat!: ServerResponse;
    await start((req, res) => {
      auth.push(req.headers.authorization!);
      if (req.url === '/alia/chat') {
        chat = res;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(data({ content: 'ready' }));
      }
    });
    const runControl = control(),
      handlers = callbacks();
    const running = streamChat([], '', '', handlers, undefined, runControl);
    await vi.waitFor(() => expect(handlers.onContent).toHaveBeenCalled());
    const stopping = runControl.stop();
    const rejected = expect(stopping).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(auth).toHaveLength(2));
    world.oxy!.session.setAccessToken(token('bob'));
    await rejected;
    await running;
    await runControl.stop();
    expect(runControl.lifetimeSignal.aborted).toBe(true);
    expect(auth.every((value) => value === `Bearer ${token('alice')}`)).toBe(true);
    chat.end();
  });

  it('incidental detach sends no cancellation and an HTTP failure is not a generation retry', async () => {
    const paths: string[] = [];
    await start((req, res) => {
      paths.push(req.url!);
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"PROVIDER_UNAVAILABLE"}}');
    });
    const runControl = control(),
      handlers = callbacks();
    await streamChat([], '', '', handlers, undefined, runControl);
    runControl.dispose();
    expect(paths).toEqual(['/alia/chat']);
    expect(handlers.onError).toHaveBeenCalledTimes(1);
  });

  it('gives each HTTP tool continuation a fresh UUID and retains tool results', async () => {
    const ids: unknown[] = [];
    await start((req, res, body) => {
      expect(req.url).toBe('/alia/chat');
      ids.push(body.turnId);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        ids.length === 1
          ? data({
              tool_calls: [
                { index: 0, id: 'read-a', function: { name: 'read_file', arguments: '{}' } },
              ],
            }) + done
          : data({ content: 'Finished' }) + done,
      );
    });
    const messages: Message[] = [{ role: 'user', content: 'fixture' }];
    await processConversation({
      messages,
      systemMessage: '',
      model: '',
      approvalMode: 'full-auto',
      isActive: () => true,
      control: control(),
      requestApproval: async () => true,
      onEvent: () => {},
    });
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.tool_call_id === 'read-a' && m.content === 'fixture file')).toBe(
      true,
    );
  });

  it('Stop while approval is pending blocks even a late positive answer and no new tool round starts', async () => {
    let requests = 0;
    await start((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        data({
          tool_calls: [
            { index: 0, id: 'write-a', function: { name: 'write_file', arguments: '{}' } },
          ],
        }) + done,
      );
    });
    const runControl = control(),
      approving = deferred(),
      approval = deferred<boolean>();
    const running = processConversation({
      messages: [{ role: 'user', content: 'fixture' }],
      systemMessage: '',
      model: '',
      approvalMode: 'suggest',
      isActive: () => true,
      control: runControl,
      onEvent: () => {},
      requestApproval: () => {
        approving.resolve();
        return approval.promise;
      },
    });
    await approving.promise;
    await runControl.stop();
    approval.resolve(true);
    await running;
    expect(executeTool).not.toHaveBeenCalled();
    expect(requests).toBe(1);
  });
});

it('run/exec SIGINT waits for acknowledgement and removes its signal/output handlers afterward', async () => {
  const baseline = process.listenerCount('SIGINT');
  const outputBaseline = process.stdout.listenerCount('error');
  let chat!: ServerResponse, acknowledge!: () => void;
  let count = 0;
  await start((req, res) => {
    count++;
    if (req.url === '/alia/chat') {
      chat = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    } else
      acknowledge = () => {
        ack(req, res);
        chat.end(done);
      };
  });
  let finished = false;
  const running = runPrompt('fixture', { model: '', yes: true, context: false, quiet: true }).then(
    () => {
      finished = true;
    },
  );
  await vi.waitFor(() => expect(count).toBe(1));
  process.emit('SIGINT');
  await vi.waitFor(() => expect(count).toBe(2));
  expect(finished).toBe(false);
  process.emit('SIGINT');
  expect(count).toBe(2);
  acknowledge();
  await running;
  expect(process.listenerCount('SIGINT')).toBe(baseline);
  expect(process.stdout.listenerCount('error')).toBe(outputBaseline);
});

it('a broken output pipe detaches run without issuing remote Stop', async () => {
  const paths: string[] = [];
  await start((req, res) => {
    paths.push(req.url!);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  });
  const running = runPrompt('fixture', { model: '', yes: true, context: false, quiet: true });
  await vi.waitFor(() => expect(paths).toEqual(['/alia/chat']));
  process.stdout.emit('error', Object.assign(new Error('fixture closed pipe'), { code: 'EPIPE' }));
  await running;
  expect(paths).toEqual(['/alia/chat']);
});

it('a normal declined approval remains a tool result, allowing the next round to explain it', async () => {
  const bodies: Record<string, unknown>[] = [];
  await start((_req, res, body) => {
    bodies.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      bodies.length === 1
        ? data({
            tool_calls: [
              { index: 0, id: 'write-declined', function: { name: 'write_file', arguments: '{}' } },
            ],
          }) + done
        : data({ content: 'No change made' }) + done,
    );
  });
  const messages: Message[] = [{ role: 'user', content: 'fixture' }];
  await processConversation({
    messages,
    systemMessage: '',
    model: '',
    approvalMode: 'suggest',
    control: control(),
    isActive: () => true,
    requestApproval: async () => false,
    onEvent: () => {},
  });
  expect(executeTool).not.toHaveBeenCalled();
  expect(bodies).toHaveLength(2);
  expect(messages).toContainEqual({
    role: 'tool',
    tool_call_id: 'write-declined',
    content: 'User declined this action.',
  });
});

it('switching accounts during local approval ends the submission before any tool or next round', async () => {
  let requests = 0;
  await start((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      data({
        tool_calls: [
          { index: 0, id: 'write-a', function: { name: 'write_file', arguments: '{}' } },
        ],
      }) + done,
    );
  });
  const approving = deferred(),
    approval = deferred<boolean>(),
    runControl = control();
  const running = processConversation({
    messages: [{ role: 'user', content: 'fixture' }],
    systemMessage: '',
    model: '',
    approvalMode: 'suggest',
    isActive: () => true,
    control: runControl,
    onEvent: () => {},
    requestApproval: () => {
      approving.resolve();
      return approval.promise;
    },
  });
  await approving.promise;
  if (!world.oxy) throw new Error('Missing test session');
  world.oxy.session.setAccessToken(token('bob'));
  expect(runControl.activitySignal.aborted).toBe(true);
  approval.resolve(true);
  await running;
  expect(executeTool).not.toHaveBeenCalled();
  expect(requests).toBe(1);
});

it('a refused Stop remains retryable without aborting or redispatching generation', async () => {
  let stops = 0,
    generations = 0;
  let chat!: ServerResponse;
  await start((req, res) => {
    if (req.url === '/alia/chat') {
      generations++;
      chat = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(data({ content: 'ready' }));
    } else if (++stops === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{}');
    } else {
      ack(req, res);
      chat.end(done);
    }
  });
  const runControl = control(),
    handlers = callbacks();
  let finished = false;
  const running = streamChat([], '', '', handlers, undefined, runControl).then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(handlers.onContent).toHaveBeenCalled());
  await expect(runControl.stop()).rejects.toMatchObject({ status: 503 });
  expect(finished).toBe(false);
  expect(world.disposeCount).toBe(0);
  await runControl.stop();
  await running;
  expect(stops).toBe(2);
  expect(generations).toBe(1);
});

it('acknowledged Stop preserves only visible partial text, never unfinished tool calls', async () => {
  let chat!: ServerResponse, acknowledge!: () => void;
  await start((req, res) => {
    if (req.url === '/alia/chat') {
      chat = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        data({ content: 'Visible partial' }) +
          data({
            tool_calls: [
              { index: 0, id: 'write-pending', function: { name: 'write_file', arguments: '{' } },
            ],
          }),
      );
    } else {
      chat.end('data: {"error":{"code":"turn_cancelled","message":"Stopped"}}\n\n' + done);
      acknowledge = () => ack(req, res);
    }
  });
  const messages: Message[] = [{ role: 'user', content: 'fixture' }],
    events: string[] = [];
  const runControl = control();
  const running = processConversation({
    messages,
    systemMessage: '',
    model: '',
    approvalMode: 'full-auto',
    control: runControl,
    isActive: () => true,
    requestApproval: async () => true,
    onEvent: (event) => {
      if (event.type === 'content') events.push(event.text);
    },
  });
  await vi.waitFor(() => expect(events).toEqual(['Visible partial']));
  const stopping = runControl.stop();
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
  expect(messages).toHaveLength(1);
  acknowledge();
  await stopping;
  await running;
  expect(messages).toEqual([
    { role: 'user', content: 'fixture' },
    { role: 'assistant', content: 'Visible partial' },
  ]);
  expect(executeTool).not.toHaveBeenCalled();
});

it('account detach never stores a partially streamed response in conversation history', async () => {
  await start((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(data({ content: 'Alice partial' }));
  });
  const messages: Message[] = [{ role: 'user', content: 'fixture' }],
    events: string[] = [];
  const running = processConversation({
    messages,
    systemMessage: '',
    model: '',
    approvalMode: 'full-auto',
    control: control(),
    isActive: () => true,
    requestApproval: async () => true,
    onEvent: (event) => {
      if (event.type === 'content') events.push(event.text);
    },
  });
  await vi.waitFor(() => expect(events).toEqual(['Alice partial']));
  if (!world.oxy) throw new Error('Missing test session');
  world.oxy.session.setAccessToken(token('bob'));
  await running;
  expect(messages).toEqual([{ role: 'user', content: 'fixture' }]);
});

it.each(['account-switch', 'explicit-stop'] as const)(
  'fences a running local tool result on %s',
  async (action) => {
    let generations = 0;
    await start((_req, res) => {
      generations++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        data({
          tool_calls: [
            { index: 0, id: 'read-inflight', function: { name: 'read_file', arguments: '{}' } },
          ],
        }) + done,
      );
    });
    const result = deferred<{ result: string; success: boolean }>(),
      entered = deferred();
    executeTool.mockImplementationOnce(() => {
      entered.resolve();
      return result.promise;
    });
    const messages: Message[] = [{ role: 'user', content: 'fixture' }],
      events: string[] = [],
      runControl = control();
    const running = processConversation({
      messages,
      systemMessage: '',
      model: '',
      approvalMode: 'full-auto',
      control: runControl,
      isActive: () => true,
      requestApproval: async () => true,
      onEvent: (event) => events.push(event.type),
    });
    await entered.promise;
    if (action === 'account-switch') {
      if (!world.oxy) throw new Error('Missing test session');
      world.oxy.session.setAccessToken(token('bob'));
    } else await runControl.stop();
    result.resolve({ result: 'old-account-tool-result', success: true });
    await running;
    expect(generations).toBe(1);
    expect(executeTool).toHaveBeenCalledTimes(1);
    if (action === 'account-switch') {
      expect(events).not.toContain('tool_done');
      expect(messages).toEqual([{ role: 'user', content: 'fixture' }]);
    } else {
      expect(events).toContain('tool_done');
      expect(messages).toContainEqual({
        role: 'tool',
        tool_call_id: 'read-inflight',
        content: 'old-account-tool-result',
      });
    }
  },
);
