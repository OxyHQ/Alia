/**
 * What an agent's Oxy account is born as.
 *
 * The screen's half of this lives here rather than beside `create.tsx` because
 * expo-router's `require.context` over `app/` excludes only `+html`, `+api`,
 * `+middleware` and `+native-intent`: a `__tests__` file under `app/` would be
 * registered as a ROUTE and would pull vitest into the app bundle. So the test
 * for the one call site sits with the module it calls.
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountNode, CreateAccountInput } from '@oxyhq/core';

import { createBotAccount } from '../bot-account';

const mocks = vi.hoisted(() => ({
  createAccount: vi.fn(),
  createAgent: vi.fn(),
  post: vi.fn(),
  replace: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);

  return {
    ActivityIndicator: host('ActivityIndicator'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    View: host('View'),
  };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const icon = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props);

  return {
    BarChart3: icon('BarChart3'),
    GitBranch: icon('GitBranch'),
    MessageCircleQuestion: icon('MessageCircleQuestion'),
    Sparkles: icon('Sparkles'),
  };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@/components/ui/prompt-input/prompt-input', async () => {
  const ReactModule = await import('react');
  return {
    PromptInput: (props: Record<string, unknown>) =>
      ReactModule.createElement('PromptInput', props),
  };
});

vi.mock('@oxyhq/bloom/content-panel', async () => {
  const ReactModule = await import('react');
  return {
    ContentPanel: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('ContentPanel', props, children),
  };
});

vi.mock('@oxyhq/bloom/toast', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock('@oxyhq/services', () => ({
  useOxy: () => ({ createAccount: mocks.createAccount }),
}));

vi.mock('@/lib/stores/agents-store', () => ({
  useAgentsStore: (selector: (state: { createAgent: unknown }) => unknown) =>
    selector({ createAgent: mocks.createAgent }),
}));

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api/client', () => ({
  default: { post: mocks.post },
}));

import { PromptInput } from '@/components/ui/prompt-input/prompt-input';
import CreateAgentScreen from '@/app/(app)/agents/create';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** What `POST /accounts` answers with. Only `accountId` is read downstream. */
const account: AccountNode = {
  accountId: 'acct_agent',
  kind: 'bot',
  parentAccountId: 'acct_owner',
  account: {
    id: 'acct_agent',
    publicKey: 'pk_agent',
    username: 'helper',
    name: { displayName: 'Helper' },
  },
  relationship: 'owner',
  callerMembership: null,
};

/** A 409 as Oxy raises it — recognised by STATUS, so that is what it carries. */
function conflict(): { status: number } {
  return { status: 409 };
}

describe('createBotAccount', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mints the account undiscoverable when the caller asked for private', async () => {
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockResolvedValue(account);

    await createBotAccount({
      createAccount,
      username: 'helper',
      displayName: 'Helper',
      private: true,
    });

    expect(createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ isPrivateAccount: true }),
    );
  });

  it('omits the field entirely when the caller said nothing, which is not `false`', async () => {
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockResolvedValue(account);

    await createBotAccount({
      createAccount,
      username: 'helper',
      displayName: 'Helper',
    });

    const [data] = createAccount.mock.calls[0];
    // `false` and absent are different requests: absent takes Oxy's default,
    // which is discoverable, and a value of `false` asserts it. An assertion on
    // the VALUE would pass either way, so this asserts on the KEY.
    expect(Object.keys(data)).not.toContain('isPrivateAccount');
  });

  it('forwards an explicit `false` as a value, not as silence', async () => {
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockResolvedValue(account);

    await createBotAccount({
      createAccount,
      username: 'helper',
      displayName: 'Helper',
      private: false,
    });

    const [data] = createAccount.mock.calls[0];
    expect(Object.keys(data)).toContain('isPrivateAccount');
    expect(data.isPrivateAccount).toBe(false);
  });

  it('keeps the account private on the retry a username conflict forces', async () => {
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockRejectedValueOnce(conflict())
      .mockResolvedValue(account);

    await createBotAccount({
      createAccount,
      username: 'helper',
      displayName: 'Helper',
      private: true,
    });

    expect(createAccount).toHaveBeenCalledTimes(2);
    // The request is rebuilt inside the retry loop, so privacy is exactly the
    // kind of thing a fix in the wrong place drops on the second attempt.
    const [retry] = createAccount.mock.calls[1];
    expect(retry.isPrivateAccount).toBe(true);
    expect(retry.username).not.toBe('helper');
    expect(retry.username.startsWith('helper-')).toBe(true);
  });

  it('rethrows anything that is not a conflict instead of retrying it', async () => {
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockRejectedValue({ status: 403 });

    await expect(
      createBotAccount({ createAccount, username: 'helper', displayName: 'Helper', private: true }),
    ).rejects.toEqual({ status: 403 });
    expect(createAccount).toHaveBeenCalledOnce();
  });
});

describe('the create screen', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    vi.clearAllMocks();
  });

  /** Drives the screen through one whole agent creation, from prompt to row. */
  async function createOneAgent() {
    mocks.post.mockImplementation((route: string) => {
      if (route === '/agents/generate') {
        return Promise.resolve({
          data: {
            name: 'Helper',
            suggestedUsername: 'helper',
            tagline: 'Helps',
            description: 'Helps with things',
            category: 'Assistant',
            tags: ['help'],
            capabilities: [],
            systemPrompt: 'You are Helper.',
            archetype: 'general',
          },
        });
      }
      return Promise.reject(new Error(`the create screen called an unexpected route: ${route}`));
    });
    mocks.createAccount.mockResolvedValue(account);
    mocks.createAgent.mockResolvedValue({ _id: 'agent_1' });

    let created: ReactTestRenderer | undefined;
    act(() => {
      created = create(<CreateAgentScreen />);
    });
    if (created === undefined) throw new Error('the create screen did not render');
    renderer = created;
    const root = created.root;

    act(() => {
      root.findByType(PromptInput).props.onValueChange('an agent that helps');
    });
    await act(async () => {
      root.findByType(PromptInput).props.onSubmit();
    });
  }

  it('asks for a private account, because the agent it builds is a draft', async () => {
    await createOneAgent();

    expect(mocks.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bot', isPrivateAccount: true }),
    );
  });

  /**
   * An agent's likeness is `components/ui/agent-glyph.tsx` drawn in its
   * account's own color, and there is no image anywhere in it — so the
   * generate-an-avatar round trip is gone and nothing is minted with one.
   *
   * Asserted on the WHOLE list of routes rather than on the absence of the one
   * that was removed: "`/agents/avatar/generate` was not called" would stay
   * green if the step came back under another name, and an avatar step is
   * exactly the kind of thing that comes back renamed.
   */
  it('mints the account with no avatar, and asks Alia for nothing but the config', async () => {
    await createOneAgent();

    expect(mocks.post.mock.calls.map((call) => call[0])).toEqual(['/agents/generate']);
    expect(mocks.createAccount.mock.calls[0]?.[0]).not.toHaveProperty('avatar');
  });
});
