import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { OxyServices } from '@oxy.so/core';
import * as vscode from 'vscode';
import { CodeaChatViewProvider } from '../chatProvider';
import { AliaChatParticipant } from '../chatParticipant';

vi.mock('../logger', () => ({ log: { debug() {}, info() {}, warn() {}, error() {} } }));
vi.mock('../catalogue', () => ({
  resolveModelId: async () => undefined,
  fetchPickerCatalogue: async () => ({ groups: [], defaultLabel: '' }),
}));
const tools = vi.hoisted(() => ({
  execute: async () => ({ success: true, result: 'owned fixture' }),
}));
vi.mock('../tools', () => ({
  fileTools: [],
  ToolExecutor: class {
    async getContext() {
      return {};
    }
    execute() {
      return tools.execute();
    }
  },
}));
const disposers: (() => void)[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
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
async function fixture(lateAck = false, toolRound = false) {
  tools.execute = async () => ({ success: true, result: 'owned fixture' });
  const requests: { path?: string; auth?: string; turnId?: string }[] = [];
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let refused = false;
  let chatResponse: ServerResponse | undefined;
  let cancelled!: () => void;
  const cancelArrived = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  let acknowledge!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const value = body ? JSON.parse(body) : {};
    requests.push({ path: req.url, auth: req.headers.authorization, turnId: value.turnId });
    if (req.url === '/alia/chat') {
      chatResponse = res;
      if (lateAck) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial answer' }, finish_reason: null }] })}\n\n`,
        );
      }
      if (toolRound) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'old-tool', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
        );
      }
      // No metadata or response headers yet: Stop must already know this UUID.
      arrived();
    } else if (req.url?.endsWith('/cancel')) {
      if (lateAck) {
        chatResponse?.end(
          `data: ${JSON.stringify({ error: { code: 'turn_cancelled', message: 'Stopped' } })}\n\n`,
        );
        cancelled();
        await acknowledgement;
      }
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
  const baseURL = `http://127.0.0.1:${address.port}`;
  vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: (key: string, fallback: unknown) => (key === 'apiBaseUrl' ? baseURL : fallback),
  } as never);
  const oxy = new OxyServices({ baseURL });
  oxy.session.setAccessToken(bearer('a'));
  disposers.push(() => oxy.dispose());
  const listeners = new Set<() => void>();
  const auth = {
    onDidChangeSessions: () => ({ dispose() {} }),
    getAccessToken: vi.fn(async () => bearer('a')),
    createLinkedClient: () => oxy.createLinkedClient({ baseURL }),
    onSessionContextChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getOxyServices: () => ({
      session: { userId: 'a' },
      users: { me: async () => ({ username: 'qa' }) },
    }),
  };
  const subscriptions: { dispose(): void }[] = [];
  const provider = new CodeaChatViewProvider(
    {} as never,
    {
      subscriptions,
      globalState: { get: (_k: string, f: unknown) => f, update: async () => {} },
    } as never,
    auth as never,
  );
  const posted: { type: string; generationContinues?: boolean }[] = [];
  const control = provider as unknown as {
    _view: unknown;
    _messages: unknown[];
    _currentConversationId: string | null;
    loadConversation(conversation: unknown): void;
    handleUserMessage(content: string): Promise<void>;
    stopGeneration(): Promise<void>;
  };
  control._view = {
    webview: { postMessage: (message: (typeof posted)[number]) => posted.push(message) },
  };
  disposers.push(() => {
    for (const entry of subscriptions) entry.dispose();
  });
  return {
    control,
    baseURL,
    auth,
    posted,
    requests,
    started,
    cancelArrived,
    acknowledge,
    setRefused: (value: boolean) => {
      refused = value;
    },
    switchAccount: () => {
      oxy.session.setAccessToken(bearer('b'));
      for (const listener of listeners) listener();
    },
  };
}

it('webview Stop before headers sends one shared authenticated cancel and no next round', async () => {
  const f = await fixture();
  const run = f.control.handleUserMessage('owned fixture');
  await f.started;
  const id = f.requests[0].turnId;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await Promise.all([f.control.stopGeneration(), f.control.stopGeneration()]);
  await run;
  expect(f.requests.map((r) => r.path)).toEqual(['/alia/chat', `/v1/chat/turns/${id}/cancel`]);
  expect(f.requests[1].auth).toBe(f.requests[0].auth);
  expect(f.requests[0].auth).toMatch(/^Bearer /);
});

it('failed Stop reports continuing generation and can retry without another generation', async () => {
  const f = await fixture();
  const run = f.control.handleUserMessage('owned fixture');
  await f.started;
  f.setRefused(true);
  await f.control.stopGeneration();
  expect(f.posted).toContainEqual(
    expect.objectContaining({ type: 'error', generationContinues: true }),
  );
  expect(f.posted.some((p) => p.type === 'endAssistantMessage')).toBe(false);
  f.setRefused(false);
  await f.control.stopGeneration();
  await run;
  expect(f.requests.filter((r) => r.path === '/alia/chat')).toHaveLength(1);
  expect(f.requests.filter((r) => r.path?.endsWith('/cancel'))).toHaveLength(2);
});

it('account switch detaches without sending control under the replacement account', async () => {
  const f = await fixture();
  const run = f.control.handleUserMessage('owned fixture');
  await f.started;
  f.switchAccount();
  await run;
  await f.control.stopGeneration();
  expect(f.requests.filter((r) => r.path?.endsWith('/cancel'))).toEqual([]);
});

it('Stop during pending auth prevents any generation or control dispatch', async () => {
  const f = await fixture();
  let release!: (token: string) => void;
  f.auth.getAccessToken.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const run = f.control.handleUserMessage('owned fixture');
  await f.control.stopGeneration();
  release(bearer('a'));
  await run;
  expect(f.requests).toEqual([]);
});

it('native chat panel Stop uses the same acknowledged control rather than just aborting the reader', async () => {
  const f = await fixture();
  const participant = Object.assign(Object.create(AliaChatParticipant.prototype), {
    authProvider: f.auth,
    apiBaseUrl: f.baseURL,
    model: '',
  }) as { streamResponse(messages: unknown[], stream: unknown, token: unknown): Promise<void> };
  let cancel!: () => void;
  let cancelled = false;
  let disposed = false;
  const token = {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(callback: () => void) {
      cancel = callback;
      return {
        dispose() {
          disposed = true;
        },
      };
    },
  };
  const run = participant.streamResponse(
    [{ role: 'user', content: 'owned fixture' }],
    { markdown() {}, progress() {} },
    token,
  );
  await f.started;
  cancelled = true;
  cancel();
  await run;
  expect(f.requests.filter((r) => r.path?.endsWith('/cancel'))).toHaveLength(1);
  expect(f.requests[1].path).toBe(`/v1/chat/turns/${f.requests[0].turnId}/cancel`);
  expect(disposed).toBe(true);
});

it('webview drains a held Stop acknowledgement after terminal cancellation SSE without an error card', async () => {
  const f = await fixture(true);
  let runEnded = false;
  let stopEnded = false;
  const run = f.control.handleUserMessage('owned fixture').then(() => {
    runEnded = true;
  });
  await f.started;
  const stopped = f.control.stopGeneration().then(() => {
    stopEnded = true;
  });
  await f.cancelArrived;
  await expect.poll(() => f.posted.some((message) => message.type === 'streamContent')).toBe(true);
  expect(runEnded).toBe(false);
  expect(stopEnded).toBe(false);
  expect(f.posted.some((message) => message.type === 'error')).toBe(false);
  f.acknowledge();
  await stopped;
  await run;
  expect(f.posted.some((message) => message.type === 'error')).toBe(false);
  expect(f.posted.some((message) => message.type === 'endAssistantMessage')).toBe(true);
  expect(f.control._messages).toContainEqual({ role: 'assistant', content: 'partial answer' });
  expect(f.requests.filter((request) => request.path?.endsWith('/cancel'))).toHaveLength(1);
});

it.each(['stream', 'tool'] as const)(
  'opening another saved conversation detaches an old %s without remote Stop or late history writes',
  async (phase) => {
    const f = await fixture(phase === 'stream', phase === 'tool');
    let toolStarted!: () => void;
    const runningTool = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    let finishTool!: () => void;
    const toolResult = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    tools.execute = async () => {
      toolStarted();
      await toolResult;
      return { success: true, result: 'old conversation result' };
    };
    const run = f.control.handleUserMessage('old conversation');
    await f.started;
    if (phase === 'tool') await runningTool;
    else
      await expect
        .poll(() => f.posted.some((message) => message.type === 'streamContent'))
        .toBe(true);
    const messages = [{ role: 'user', content: 'selected saved conversation' }];
    f.control.loadConversation({
      id: 'selected',
      title: 'Selected',
      createdAt: 1,
      updatedAt: 1,
      messages,
    });
    const postSelection = f.posted.length;
    finishTool();
    await run;
    await f.control.stopGeneration();
    expect(f.control._currentConversationId).toBe('selected');
    expect(f.control._messages).toEqual(messages);
    expect(
      f.posted
        .slice(postSelection)
        .some((message) => ['streamContent', 'toolResult', 'error'].includes(message.type)),
    ).toBe(false);
    expect(f.requests.map((request) => request.path)).toEqual(['/alia/chat']);
  },
);
