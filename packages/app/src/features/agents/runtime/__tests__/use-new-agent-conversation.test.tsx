import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * "New agent" opens a conversation with Alia and sends a short first message in the person's
 * language; signed out it asks to sign in and starts nothing.
 */

const mocks = vi.hoisted(() => ({
  startConversation: vi.fn(async () => true),
  signIn: vi.fn(async () => undefined),
  auth: { isAuthenticated: true, canUsePrivateApi: true, isAccountCacheReady: true },
}));

vi.mock('@alia.onl/sdk/runtime', () => ({ useStartConversation: () => mocks.startConversation }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ isAuthenticated: mocks.auth.isAuthenticated, signIn: mocks.signIn }),
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => `t(${key})` }),
}));

import { useNewAgentConversation } from '../use-new-agent-conversation';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function mount(): () => void {
  let start!: () => void;
  function Probe() {
    start = useNewAgentConversation();
    return null;
  }
  act(() => {
    create(<Probe />);
  });
  return start;
}

describe('useNewAgentConversation', () => {
  it('starts a conversation with Alia and the localised first message', () => {
    mocks.auth.isAuthenticated = true;
    mocks.startConversation.mockClear();
    mount()();
    expect(mocks.startConversation).toHaveBeenCalledExactlyOnceWith('t(agents.createViaChat)');
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it('asks to sign in, and starts nothing, when signed out', () => {
    mocks.auth.isAuthenticated = false;
    mocks.startConversation.mockClear();
    mount()();
    expect(mocks.signIn).toHaveBeenCalledOnce();
    expect(mocks.startConversation).not.toHaveBeenCalled();
  });
});
