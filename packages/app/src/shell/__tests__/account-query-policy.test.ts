import { onlineManager, QueryClient } from '@tanstack/react-query';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ALIA_ACCOUNT_QUERIES, EMAIL_ALERTS_MUTATION_KEY } from '@/shared/api/query-keys';

// Test the exact installed SDK implementation rather than reproducing its filters.
const require = createRequire(import.meta.url);
const sdk = dirname(require.resolve('@oxy.so/services/package.json'));
const { accountQueryOwnership, createAccountQueryPersistence } = require(
  join(sdk, 'lib/commonjs/ui/hooks/accountQueryPersistence.js'),
);

afterEach(() => onlineManager.setOnline(true));

it('persists the lists a returning person sees first, and nothing that holds messages or money', () => {
  const client = new QueryClient();
  const policy = accountQueryOwnership(ALIA_ACCOUNT_QUERIES);
  const persisted = (queryKey: readonly unknown[]) =>
    policy.persistsQuery(client.getQueryCache().build(client, { queryKey: [...queryKey] }));
  for (const queryKey of [
    ['conversations', { agentId: undefined, app: undefined }],
    ['alia-agent-profile', 'a1'],
    ['skills', 'installed'],
  ]) {
    expect(persisted(queryKey), JSON.stringify(queryKey)).toBe(true);
  }
  for (const queryKey of [
    ['conversation', 'c1'],
    ['agents', 'mine'],
    ['billing', 'subscription', 'u1'],
    ['credits'],
    ['alia-shared-conversation', 'token'],
  ]) {
    expect(persisted(queryKey), JSON.stringify(queryKey)).toBe(false);
  }
  client.clear();
});

it('changes ownership only for the declared roots and the email-alert mutation key', () => {
  const client = new QueryClient();
  const before = accountQueryOwnership();
  const after = accountQueryOwnership(ALIA_ACCOUNT_QUERIES);
  for (const queryKey of [['email-alerts'], ['users'], ['unrelated']]) {
    const query = client.getQueryCache().build(client, { queryKey });
    expect(after.ownsQuery(query)).toBe(before.ownsQuery(query));
    expect(after.persistsQuery(query)).toBe(before.persistsQuery(query));
  }
  for (const mutationKey of [undefined, ['unrelated'], EMAIL_ALERTS_MUTATION_KEY]) {
    const mutation = client.getMutationCache().build(client, { mutationKey });
    expect(after.ownsMutation(mutation)).toBe(mutationKey === EMAIL_ALERTS_MUTATION_KEY);
    expect(before.ownsMutation(mutation)).toBe(false);
  }
  client.clear();
});

it('removes only the owned mutation when switching account', async () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { networkMode: 'online', retry: false } },
  });
  const storage = new Map<string, string>();
  const persistence = createAccountQueryPersistence(client, ALIA_ACCOUNT_QUERIES);
  persistence.setStorage({
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
  });
  persistence.attach();
  persistence.activate('A');
  await persistence.whenReady();
  client.setQueryData(['unrelated'], { value: 1 });
  onlineManager.setOnline(false);
  const own = client
    .getMutationCache()
    .build(client, { mutationKey: EMAIL_ALERTS_MUTATION_KEY, mutationFn: async () => {} });
  const other = client
    .getMutationCache()
    .build(client, { mutationKey: ['unrelated'], mutationFn: async () => {} });
  const pendingOwn = own.execute({});
  const pendingOther = other.execute({});
  await vi.waitFor(() => expect(own.state.isPaused && other.state.isPaused).toBe(true));
  persistence.activate('B');
  await persistence.whenReady();
  expect(client.getMutationCache().getAll()).not.toContain(own);
  expect(client.getMutationCache().getAll()).toContain(other);
  expect(client.getQueryData(['unrelated'])).toEqual({ value: 1 });
  onlineManager.setOnline(true);
  await Promise.all([own.continue(), other.continue(), pendingOwn, pendingOther]);
  persistence.detach();
  client.clear();
});
