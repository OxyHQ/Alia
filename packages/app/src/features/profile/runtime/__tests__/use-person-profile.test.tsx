import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What `/@username` names when it is not an agent: a public account that is not a bot. */

const query = vi.hoisted(() => ({
  result: { data: undefined as unknown, isPending: false, isError: false },
  calls: [] as (string | null)[],
}));
vi.mock('@oxy.so/services/ui/client', () => ({
  useUserByUsername: (username: string | null) => {
    query.calls.push(username);
    return query.result;
  },
}));

const { usePersonProfile } = await import('@/features/profile/runtime/use-person-profile');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
function read(username: string) {
  let value!: ReturnType<typeof usePersonProfile>;
  const Probe = () => {
    value = usePersonProfile(username);
    return null;
  };
  act(() => {
    renderer = create(<Probe />);
  });
  return value;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  query.calls.length = 0;
  query.result = { data: undefined, isPending: false, isError: false };
});

describe('usePersonProfile', () => {
  it('is a person for a personal or organization account', () => {
    query.result = {
      data: { username: 'maya', kind: 'personal' },
      isPending: false,
      isError: false,
    };
    expect(read('maya').person).toMatchObject({ username: 'maya' });
    query.result = { data: { username: 'maya' }, isPending: false, isError: false };
    expect(read('maya').person).toMatchObject({ username: 'maya' });
  });

  it('is nobody for a bot: an agent opens its thread', () => {
    query.result = { data: { username: 'pepe', kind: 'bot' }, isPending: false, isError: false };
    expect(read('pepe').person).toBeUndefined();
  });

  it('is nobody and is not waiting for an empty username, and asks Oxy for none', () => {
    query.result = { data: undefined, isPending: true, isError: false };
    const state = read('');
    expect(state.person).toBeUndefined();
    expect(state.isPending).toBe(false);
    expect(query.calls).toEqual([null]);
  });

  it('waits while the account is read, and reports a failed read', () => {
    query.result = { data: undefined, isPending: true, isError: false };
    expect(read('maya').isPending).toBe(true);
    query.result = { data: undefined, isPending: false, isError: true };
    expect(read('maya')).toMatchObject({ isPending: false, isError: true, person: undefined });
  });
});
