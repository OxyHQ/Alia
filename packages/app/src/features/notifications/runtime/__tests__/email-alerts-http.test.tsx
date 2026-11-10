import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { OxyServices } from '@oxy.so/core';

const world = vi.hoisted(() => ({
  origin: '',
  userId: 'A',
  sessionId: 'session-A',
  toastError: vi.fn(),
}));
vi.mock('@/shared/platform/config', () => ({
  default: {
    get apiUrl() {
      return world.origin;
    },
  },
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: world.toastError, success: vi.fn() } }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    isAuthenticated: true,
    user: { id: world.userId },
    activeSessionId: world.sessionId,
  }),
  queryKeys: { accounts: { all: ['accounts'] }, sessions: { all: ['sessions'] } },
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each(['projection', 'shell-unmount'] as const)(
  'aborts a real linked HTTP mutation during preflight on %s',
  async (change) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ alia: { enabled: false }, agents: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    world.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    world.userId = 'A';
    world.sessionId = 'session-A';
    const api = await import('@/shared/api/client');
    api.default.defaults.baseURL = world.origin;
    const { useEmailAlerts } = await import('@/features/notifications/runtime/use-email-alerts');
    const { useAccountLifecycle } = await import('@/shell/account-lifecycle');
    const oxy = new OxyServices({ baseURL: world.origin });
    const token = `h.${Buffer.from(JSON.stringify({ userId: 'A', sessionId: 'session-A', exp: 4102444800 })).toString('base64url')}.s`;
    oxy.session.setAccessToken(token);
    api.bindApiClient(oxy);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    let state!: ReturnType<typeof useEmailAlerts>;
    function Screen({ userId }: { userId: string }) {
      useAccountLifecycle(userId, world.sessionId);
      state = useEmailAlerts();
      return null;
    }
    const tree = (userId: string) =>
      createElement(QueryClientProvider, { client }, createElement(Screen, { userId }));
    let renderer!: ReactTestRenderer;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const prototype = Object.getPrototypeOf(oxy.http) as {
      getAuthHeader: () => Promise<string | null>;
    };
    const original = prototype.getAuthHeader;
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    const reactErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => {
        renderer = create(tree('A'));
      });
      await vi.waitFor(() => expect(state.alerts?.alia.enabled).toBe(false));
      spy = vi.spyOn(prototype, 'getAuthHeader').mockImplementation(function (
        this: typeof prototype,
      ) {
        enter();
        return gate.then(async () => {
          try {
            return await original.call(this);
          } finally {
            complete();
          }
        });
      });
      await act(async () => {
        state.setEnabled(null, true);
      });
      await entered;
      if (change === 'projection') {
        world.userId = 'B';
        world.sessionId = 'session-B';
        await act(async () => {
          renderer.update(tree('B'));
        });
      } else {
        await act(async () => {
          renderer.unmount();
        });
      }
      expect(oxy.session.userId).toBe('A');
      release();
      await completed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(requests.filter((request) => request.startsWith('PUT '))).toEqual([]);
      expect(reactErrors.mock.calls.flat().join(' ')).not.toContain(
        'useInsertionEffect must not schedule updates',
      );
    } finally {
      release();
      spy?.mockRestore();
      reactErrors.mockRestore();
      act(() => renderer?.unmount());
      client.clear();
      api.releaseApiClient(oxy);
      oxy.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it('drops an old response after an already dispatched request changes owner', async () => {
  let arrived!: () => void;
  const requestArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let finishResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    finishResponse = resolve;
  });
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === 'PUT') {
      arrived();
      await responseGate;
    }
    response.setHeader('content-type', 'application/json');
    const token = request.headers.authorization?.split(' ')[1];
    const subject = token
      ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).userId
      : null;
    response.end(
      JSON.stringify({
        alia: { enabled: false },
        agents: [{ agentId: subject, name: null, handle: null, color: null, enabled: false }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  world.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  world.userId = 'A';
  world.sessionId = 'session-A';
  world.toastError.mockClear();
  const api = await import('@/shared/api/client');
  api.default.defaults.baseURL = world.origin;
  const { useEmailAlerts } = await import('@/features/notifications/runtime/use-email-alerts');
  const { useAccountLifecycle } = await import('@/shell/account-lifecycle');
  const oxy = new OxyServices({ baseURL: world.origin });
  const token = (userId: string) =>
    `h.${Buffer.from(JSON.stringify({ userId, sessionId: `session-${userId}`, exp: 4102444800 })).toString('base64url')}.s`;
  oxy.session.setAccessToken(token('A'));
  api.bindApiClient(oxy);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let state!: ReturnType<typeof useEmailAlerts>;
  function Screen({ userId }: { userId: string }) {
    useAccountLifecycle(userId, world.sessionId);
    state = useEmailAlerts();
    return null;
  }
  const tree = (userId: string) =>
    createElement(QueryClientProvider, { client }, createElement(Screen, { userId }));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(tree('A'));
    });
    await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
    await act(async () => {
      state.setEnabled(null, true);
    });
    await requestArrived;
    world.userId = 'B';
    world.sessionId = 'session-B';
    await act(async () => {
      oxy.session.setAccessToken(token('B'));
      renderer.update(tree('B'));
    });
    finishResponse();
    await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('B'));
    expect(world.toastError).not.toHaveBeenCalled();
    expect(requests.filter((request) => request.startsWith('PUT '))).toHaveLength(1);
  } finally {
    finishResponse();
    act(() => renderer?.unmount());
    client.clear();
    api.releaseApiClient(oxy);
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
