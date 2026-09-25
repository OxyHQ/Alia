import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Chat" on an agent's page opens the thread with that agent; it does not
 * begin one. It used to POST a new thread on every press and navigate only
 * after the answer — on a Pixel 8a the press showed nothing while the request
 * was out, so it was pressed again (#608, `docs/native-validation.mdx`).
 */

const fx = vi.hoisted(() => ({
  push: vi.fn(),
  post: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: fx.push }) }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: fx.toastError, success: vi.fn() } }));
vi.mock('@/shared/i18n/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/api/client', () => ({ default: { post: fx.post, get: vi.fn(), patch: vi.fn() } }));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock('react-native', () => ({ Share: { share: vi.fn() } }));

import { useAgentDetailActions } from '../use-agent-detail-actions';
import type { Agent } from '@/shared/contracts/agents';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function actionsFor(agent: Partial<Agent>) {
  let actions!: ReturnType<typeof useAgentDetailActions>;
  function Harness() {
    actions = useAgentDetailActions({ _id: 'agent-1', name: 'Lumen', status: 'active', ...agent } as Agent);
    return null;
  }
  act(() => {
    create(<Harness />);
  });
  return actions;
}

describe("the agent page's Chat", () => {
  beforeEach(() => {
    fx.push.mockClear();
    fx.post.mockClear();
    fx.toastError.mockClear();
  });

  it('opens the thread by handle at once, and creates nothing', () => {
    const actions = actionsFor({ handle: 'lumenbot' });
    act(() => {
      void actions.handleChat();
    });
    expect(fx.push).toHaveBeenCalledWith({ pathname: '/(app)/[username]', params: { username: '@lumenbot' } });
    expect(fx.post).not.toHaveBeenCalled();
  });

  it('says the thread is unreachable when the agent has no handle, instead of opening /@', () => {
    const actions = actionsFor({ handle: null });
    act(() => {
      void actions.handleChat();
    });
    expect(fx.push).not.toHaveBeenCalled();
    expect(fx.toastError).toHaveBeenCalledWith('agents.chatUnavailable');
  });
});
