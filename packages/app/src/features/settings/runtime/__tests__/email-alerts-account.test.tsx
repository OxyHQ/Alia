import {
  dehydrate,
  hydrate,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { createElement, startTransition, Suspense } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  account: 'A' as string | null,
  bearer: 'A' as string | null,
  session: 'session-A' as string | null,
  apiEpoch: 0,
  apiListeners: new Set<() => void>(),
  api: { get: vi.fn(), put: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/shared/api/client', () => ({
  default: world.api,
  getApiSessionSnapshot: () =>
    JSON.stringify(
      world.bearer
        ? { userId: world.bearer, bindingRevision: 1, sessionEpoch: world.apiEpoch }
        : null,
    ),
  isCurrentApiSession: (owner: { userId: string; sessionEpoch: number }) =>
    owner.userId === world.bearer && owner.sessionEpoch === world.apiEpoch,
  onApiSessionContextChange: (listener: () => void) => {
    world.apiListeners.add(listener);
    return () => {
      world.apiListeners.delete(listener);
    };
  },
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: world.toast }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    isAuthenticated: Boolean(world.account),
    user: world.account ? { id: world.account } : null,
    activeSessionId: world.session,
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

import { useEmailAlerts } from '@/features/settings/runtime/use-email-alerts';
import { useAccountLifecycle } from '@/shell/account-lifecycle';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const alerts = (id: string) => ({
  alia: { enabled: false },
  agents: [{ agentId: id, name: id, handle: null, color: null, enabled: false }],
});
let client: QueryClient;
let renderer: ReactTestRenderer;
let state: ReturnType<typeof useEmailAlerts>;
function Probe({ account }: { account: string | null }) {
  useAccountLifecycle(account, world.session);
  state = useEmailAlerts();
  return null;
}
function tree(account: string | null) {
  return createElement(QueryClientProvider, { client }, createElement(Probe, { account }));
}
beforeEach(() => {
  world.account = 'A';
  world.bearer = 'A';
  world.session = 'session-A';
  world.apiEpoch = 0;
  world.apiListeners.clear();
  world.api.get.mockReset();
  world.api.put.mockReset();
  world.toast.error.mockReset();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  client.clear();
});

it('does not restore account A email alerts or show its error after account B is active', async () => {
  world.api.get.mockImplementation(async () => ({ data: alerts(world.account ?? 'signed-out') }));
  let rejectA!: (error: Error) => void;
  world.api.put.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectA = reject;
      }),
  );
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  await act(async () => {
    state.setEnabled('A', true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  world.account = 'B';
  world.bearer = 'B';
  world.session = 'session-B';
  await act(async () => {
    renderer.update(tree('B'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('B'));
  await act(async () => {
    rejectA(new Error('offline'));
  });
  expect(
    client
      .getQueriesData<{ agents: Array<{ agentId: string }> }>({ queryKey: ['email-alerts'] })
      .find(([key]) => key[1] === 'B')?.[1]?.agents[0]?.agentId,
  ).toBe('B');
  expect(world.toast.error).not.toHaveBeenCalled();
});

it('attempts once offline under Services 13.11 defaults and suppresses toast after screen unmount', async () => {
  world.api.get.mockResolvedValue({ data: alerts('A') });
  let reject!: (error: Error) => void;
  world.api.put.mockImplementation(
    () =>
      new Promise((_resolve, rejectFn) => {
        reject = rejectFn;
      }),
  );
  client.setDefaultOptions({
    queries: { retry: false, networkMode: 'always' },
    mutations: { networkMode: 'offlineFirst', retry: false, gcTime: Infinity },
  });
  client.mount();
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  act(() => {
    onlineManager.setOnline(false);
  });
  await act(async () => {
    state.setEnabled('A', true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  expect(client.getMutationCache().getAll()[0].state.isPaused).toBe(false);
  await act(async () => {
    renderer.unmount();
  });
  await act(async () => {
    reject(new Error('offline'));
  });
  expect(world.toast.error).not.toHaveBeenCalled();
  onlineManager.setOnline(true);
  client.unmount();
});

it('rejects a late A rollback after observed A to B to A, even with the original bearer', async () => {
  let version = 'A-old';
  world.api.get.mockImplementation(async () => ({ data: alerts(version) }));
  let reject!: (error: Error) => void;
  world.api.put.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A-old'));
  await act(async () => {
    state.setEnabled('A-old', true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  version = 'B';
  world.account = 'B';
  world.bearer = 'B';
  world.session = 'session-B';
  await act(async () => {
    renderer.update(tree('B'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('B'));
  version = 'A-new';
  world.account = 'A';
  world.bearer = 'A';
  world.session = 'session-A';
  await act(async () => {
    renderer.update(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A-new'));
  await act(async () => {
    reject(new Error('offline'));
  });
  expect(state.alerts?.agents[0]?.agentId).toBe('A-new');
  expect(world.toast.error).not.toHaveBeenCalled();
});

it('aborts a pending request when the committed session changes without changing bearer', async () => {
  world.api.get.mockResolvedValue({ data: alerts('A') });
  let requestSignal!: AbortSignal;
  let reject!: (error: Error) => void;
  world.api.put.mockImplementation((_path, _input, config: { signal: AbortSignal }) => {
    requestSignal = config.signal;
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  });
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  await act(async () => {
    state.setEnabled('A', true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  world.session = 'session-A-2';
  await act(async () => {
    renderer.update(tree('A'));
  });
  expect(requestSignal.aborted).toBe(true);
  await act(async () => {
    reject(new Error('cancelled'));
  });
  expect(world.toast.error).not.toHaveBeenCalled();
});

it('does not dispatch a prepared A mutation after account B commits', async () => {
  world.api.get.mockImplementation(async () => ({ data: alerts(world.account ?? 'signed-out') }));
  let finishCancellation!: () => void;
  vi.spyOn(client, 'cancelQueries').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCancellation = resolve;
      }),
  );
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  act(() => {
    state.setEnabled('A', true);
  });
  await vi.waitFor(() => expect(finishCancellation).toBeTypeOf('function'));
  world.account = 'B';
  world.bearer = 'B';
  world.session = 'session-B';
  await act(async () => {
    renderer.update(tree('B'));
  });
  await act(async () => {
    finishCancellation();
  });
  expect(world.api.put).not.toHaveBeenCalled();
  expect(world.toast.error).not.toHaveBeenCalled();
});

it('preserves a pending same-owner request across screen unmount without a stale toast', async () => {
  world.api.get.mockResolvedValue({ data: alerts('A') });
  let finish!: () => void;
  let requestSignal!: AbortSignal;
  world.api.put.mockImplementation((_path, _input, config: { signal: AbortSignal }) => {
    requestSignal = config.signal;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  function Screen() {
    state = useEmailAlerts();
    return null;
  }
  function Shell({ show }: { show: boolean }) {
    useAccountLifecycle('A', 'session-A');
    return show ? createElement(Screen) : null;
  }
  function screenTree(show: boolean) {
    return createElement(QueryClientProvider, { client }, createElement(Shell, { show }));
  }
  await act(async () => {
    renderer = create(screenTree(true));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  await act(async () => {
    state.setEnabled('A', true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  await act(async () => {
    renderer.update(screenTree(false));
  });
  expect(requestSignal.aborted).toBe(false);
  await act(async () => {
    finish();
  });
  expect(world.toast.error).not.toHaveBeenCalled();
});

it('resumes a paused same-owner mutation after screen unmount without serializing clients or credentials', async () => {
  client.setDefaultOptions({
    queries: { retry: false, networkMode: 'always' },
    mutations: { networkMode: 'online', retry: false, gcTime: Infinity },
  });
  client.mount();
  world.api.get.mockResolvedValue({ data: alerts('A') });
  world.api.put.mockResolvedValue({ data: {} });
  function Screen() {
    state = useEmailAlerts();
    return null;
  }
  function Shell({ show }: { show: boolean }) {
    useAccountLifecycle('A', 'session-A');
    return show ? createElement(Screen) : null;
  }
  function screenTree(show: boolean) {
    return createElement(QueryClientProvider, { client }, createElement(Shell, { show }));
  }
  await act(async () => {
    renderer = create(screenTree(true));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  act(() => {
    onlineManager.setOnline(false);
  });
  await act(async () => {
    state.setEnabled('A', true);
  });
  const queued = client.getMutationCache().getAll()[0];
  expect(queued.state.isPaused).toBe(true);
  const encoded = JSON.stringify(queued.state.variables);
  expect(encoded).not.toMatch(/axios|oxyServices|accessToken|bearer/i);
  await act(async () => {
    renderer.update(screenTree(false));
  });
  await act(async () => {
    onlineManager.setOnline(true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  client.unmount();
});

it('does not undo a later toggle for a different agent when the first fails', async () => {
  const initial = {
    alia: { enabled: false },
    agents: [
      { agentId: 'one', name: 'one', handle: null, color: null, enabled: false },
      { agentId: 'two', name: 'two', handle: null, color: null, enabled: false },
    ],
  };
  let server = initial;
  world.api.get.mockImplementation(async () => ({ data: server }));
  let rejectFirst!: (error: Error) => void;
  world.api.put
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    )
    .mockImplementation(async () => {
      server = {
        ...initial,
        agents: initial.agents.map((agent) =>
          agent.agentId === 'two' ? { ...agent, enabled: true } : agent,
        ),
      };
      return { data: {} };
    });
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents).toHaveLength(2));
  await act(async () => {
    state.setEnabled('one', true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  await act(async () => {
    state.setEnabled('two', true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(state.alerts?.agents[1]?.enabled).toBe(true));
  await act(async () => {
    rejectFirst(new Error('offline'));
  });
  const entry = client
    .getQueriesData<{ agents: Array<{ agentId: string; enabled: boolean }> }>({
      queryKey: ['email-alerts'],
    })
    .find(([key]) => key[1] === 'A')?.[1];
  expect(entry?.agents.map((agent) => agent.enabled)).toEqual([false, true]);
});

it('does not undo a newer toggle of the same agent when an older request fails last', async () => {
  let server = alerts('A');
  world.api.get.mockImplementation(async () => ({ data: server }));
  let failFirst!: (error: Error) => void;
  world.api.put
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failFirst = reject;
        }),
    )
    .mockImplementation(async () => {
      server = { ...server, agents: server.agents.map((agent) => ({ ...agent, enabled: false })) };
      return { data: {} };
    });
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  await act(async () => {
    state.setEnabled('A', true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  await act(async () => {
    state.setEnabled('A', false);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(2));
  await act(async () => {
    failFirst(new Error('offline'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.enabled).toBe(false));
  expect(world.toast.error).not.toHaveBeenCalled();
});

it('does not dispatch an older same-agent toggle that was delayed during preparation', async () => {
  world.api.get.mockResolvedValue({ data: alerts('A') });
  world.api.put.mockResolvedValue({ data: {} });
  let finishFirst!: () => void;
  vi.spyOn(client, 'cancelQueries').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
  );
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  act(() => {
    state.setEnabled('A', true);
  });
  await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
  await act(async () => {
    state.setEnabled('A', false);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  await act(async () => {
    finishFirst();
  });
  expect(world.api.put).toHaveBeenCalledTimes(1);
  expect(world.api.put.mock.calls[0][1]).toEqual({ agentId: 'A', enabled: false });
  expect(world.toast.error).not.toHaveBeenCalled();
});

it('keeps a pending same-owner request when its session id arrives during recovery', async () => {
  world.session = null;
  world.api.get.mockResolvedValue({ data: alerts('A') });
  let finish!: () => void;
  let requestSignal!: AbortSignal;
  world.api.put.mockImplementation((_path, _input, config: { signal: AbortSignal }) => {
    requestSignal = config.signal;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  await act(async () => {
    state.setEnabled('A', true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  world.session = 'session-A';
  await act(async () => {
    renderer.update(tree('A'));
  });
  expect(requestSignal.aborted).toBe(false);
  await act(async () => {
    finish();
  });
  expect(world.toast.error).not.toHaveBeenCalled();
});

it('hides the old query when signed out and drops its late mutation error', async () => {
  world.api.get.mockResolvedValue({ data: alerts('A') });
  let reject!: (error: Error) => void;
  world.api.put.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  await act(async () => {
    state.setEnabled('A', true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  world.account = null;
  world.bearer = null;
  world.session = null;
  await act(async () => {
    renderer.update(tree(null));
  });
  expect(state.alerts).toBeUndefined();
  await act(async () => {
    reject(new Error('offline'));
  });
  expect(state.alerts).toBeUndefined();
  expect(world.toast.error).not.toHaveBeenCalled();
});

it('does not expose A or start B requests while B projection and A bearer disagree', async () => {
  world.api.get.mockResolvedValue({ data: alerts('A') });
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  world.account = 'B';
  world.session = 'session-B';
  await act(async () => {
    renderer.update(tree('B'));
  });
  expect(state.alerts).toBeUndefined();
  expect(world.api.get).toHaveBeenCalledTimes(1);
  await act(async () => {
    state.setEnabled(null, true);
  });
  expect(world.api.put).not.toHaveBeenCalled();
});

it('does not replay a restored paused mutation without a registered mutation function', async () => {
  client.setDefaultOptions({
    queries: { retry: false, networkMode: 'always' },
    mutations: { networkMode: 'online', retry: false, gcTime: Infinity },
  });
  client.mount();
  world.api.get.mockResolvedValue({ data: alerts('A') });
  world.api.put.mockResolvedValue({ data: {} });
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  act(() => {
    onlineManager.setOnline(false);
  });
  await act(async () => {
    state.setEnabled('A', true);
  });
  const original = client.getMutationCache().getAll()[0];
  expect(original.state.isPaused).toBe(true);
  const saved = JSON.parse(
    JSON.stringify(dehydrate(client, { shouldDehydrateMutation: () => true })),
  );
  expect(JSON.stringify(saved)).not.toMatch(/accessToken|bearer|oxyServices|axios/i);
  await act(async () => {
    renderer.unmount();
  });
  client.unmount();
  const restored = new QueryClient();
  hydrate(restored, saved);
  onlineManager.setOnline(true);
  await restored.resumePausedMutations();
  expect(restored.getMutationCache().getAll()[0].state.status).toBe('error');
  expect(world.api.put).not.toHaveBeenCalled();
  await act(async () => {
    await original.continue();
  });
  expect(world.api.put).toHaveBeenCalledTimes(1);
  restored.clear();
});

it('releases a removed paused mutation without blocking a later change', async () => {
  client.setDefaultOptions({
    queries: { retry: false, networkMode: 'always' },
    mutations: { networkMode: 'online', retry: false, gcTime: Infinity },
  });
  client.mount();
  world.api.get.mockResolvedValue({ data: alerts('A') });
  world.api.put.mockResolvedValue({ data: {} });
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  act(() => {
    onlineManager.setOnline(false);
  });
  await act(async () => {
    state.setEnabled('A', true);
  });
  const removed = client.getMutationCache().getAll()[0];
  expect(removed.state.isPaused).toBe(true);
  act(() => {
    client.getMutationCache().remove(removed);
    onlineManager.setOnline(true);
  });
  await act(async () => {
    state.setEnabled('A', false);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  await act(async () => {
    await removed.continue().catch(() => {});
  });
  expect(world.api.put).toHaveBeenCalledTimes(1);
  client.unmount();
});

it('restores a failed single change without forcing an unnecessary refetch', async () => {
  world.api.get.mockResolvedValue({ data: alerts('A') });
  world.api.put.mockRejectedValue(new Error('offline'));
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  await act(async () => {
    state.setEnabled('A', true);
  });
  await vi.waitFor(() => expect(world.toast.error).toHaveBeenCalledTimes(1));
  expect(state.alerts?.agents[0]?.enabled).toBe(false);
  expect(world.api.get).toHaveBeenCalledTimes(1);
});

it('does not invalidate the committed owner when a different projection suspends and is abandoned', async () => {
  world.api.get.mockResolvedValue({ data: alerts('A') });
  world.api.put.mockResolvedValue({ data: {} });
  await act(async () => {
    renderer = create(tree('A'));
  });
  await vi.waitFor(() => expect(state.alerts?.agents[0]?.agentId).toBe('A'));
  let resume!: () => void;
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const attempted = vi.fn();
  function Candidate({ userId, suspended }: { userId: string; suspended: boolean }) {
    useAccountLifecycle(userId, `session-${userId}`);
    if (suspended) {
      attempted();
      throw pending;
    }
    return null;
  }
  let candidate!: ReactTestRenderer;
  await act(async () => {
    candidate = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          Suspense,
          { fallback: null },
          createElement(Candidate, { userId: 'A', suspended: false }),
        ),
      ),
    );
  });
  await act(async () => {
    startTransition(() =>
      candidate.update(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            Suspense,
            { fallback: null },
            createElement(Candidate, { userId: 'B', suspended: true }),
          ),
        ),
      ),
    );
  });
  expect(attempted).toHaveBeenCalled();
  await act(async () => {
    state.setEnabled('A', true);
  });
  await vi.waitFor(() => expect(world.api.put).toHaveBeenCalledTimes(1));
  act(() => candidate.unmount());
  await act(async () => {
    resume();
    await pending;
  });
});
