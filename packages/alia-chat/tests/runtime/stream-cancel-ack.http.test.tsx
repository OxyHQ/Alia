import { createServer } from 'node:http';
import { OxyServices } from '@oxy.so/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({ oxy: null as OxyServices | null }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useAppAssertion: () => ({
    getAppAssertionHeaders: async () => ({}),
    getAppAssertion: async () => null,
  }),
  useOxy: () => ({ user: null, oxyServices: world.oxy }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { AliaRuntimeProvider } from '../../src/runtime/config';
import { useConversationStream } from '../../src/runtime/use-conversation-stream';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('preserves partial text as cancelled and drains Stop when the terminal SSE precedes its HTTP acknowledgement', async () => {
  const firstContent = deferred();
  const cancelArrived = deferred();
  const acknowledge = deferred();
  let terminateChat = () => {};
  let chatTurnId: string | undefined;
  let cancelTurnId: string | undefined;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url?.endsWith('/cancel')) {
      cancelTurnId = req.url.split('/').at(-2);
      terminateChat();
      cancelArrived.resolve();
      await acknowledge.promise;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ turnId: cancelTurnId, state: 'cancelled' }));
      return;
    }
    chatTurnId = JSON.parse(body).turnId;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial answer' }, finish_reason: null }] })}\n\n`,
    );
    terminateChat = () => {
      res.end(
        `data: ${JSON.stringify({ error: { code: 'turn_cancelled', message: 'Stopped' } })}\n\n`,
      );
    };
    firstContent.resolve();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const baseURL = `http://127.0.0.1:${address.port}`;
  const oxy = new OxyServices({ baseURL });
  world.oxy = oxy;
  oxy.session.setAccessToken(
    `e30.${Buffer.from(JSON.stringify({ userId: 'A', operatorId: 'operator', sessionId: 'session-A', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`,
  );
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let api!: ReturnType<typeof useConversationStream>;
  let renderer: ReactTestRenderer | undefined;
  let result: Promise<string> | undefined;
  let ended = false;
  function Probe() {
    api = useConversationStream({ conversationId: 'owned-conversation' });
    return null;
  }
  try {
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queries}>
          <AliaRuntimeProvider apiUrl={baseURL} host={{}}>
            <Probe />
          </AliaRuntimeProvider>
        </QueryClientProvider>,
      );
    });
    act(() => {
      result = api.append({ role: 'user', content: 'a bounded fixture' }).then((outcome) => {
        ended = true;
        return outcome;
      });
    });
    await firstContent.promise;
    await act(async () => {
      api.stop();
      await cancelArrived.promise;
    });
    await expect
      .poll(async () => {
        await act(async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
        });
        return api.messages.find((message) => message.role === 'assistant')?.turnOutcome;
      })
      .toBe('cancelled');
    expect(ended).toBe(false);
    expect(api.error).toBeNull();
    expect(api.messages.find((message) => message.role === 'assistant')).toMatchObject({
      content: 'partial answer',
      turnOutcome: 'cancelled',
      isStreaming: false,
    });
    expect(cancelTurnId).toBe(chatTurnId);
    expect(chatTurnId).toMatch(/^[a-f0-9-]{36}$/);
    await act(async () => {
      acknowledge.resolve();
      expect(await result).toBe('aborted');
    });
    expect(api.error).toBeNull();
    expect(api.isLoading).toBe(false);
  } finally {
    acknowledge.resolve();
    await act(async () => {
      renderer?.unmount();
      await result?.catch(() => {});
    });
    queries.clear();
    oxy.dispose();
    world.oxy = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
