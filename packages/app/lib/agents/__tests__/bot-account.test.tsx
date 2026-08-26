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
  checkUsernameAvailability: vi.fn(),
  createAccount: vi.fn(),
  createAgent: vi.fn(),
  post: vi.fn(),
  replace: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
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
  toast: { error: mocks.toastError, success: mocks.toastSuccess, info: mocks.toastInfo },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock('@oxyhq/services', () => ({
  useOxy: () => ({
    createAccount: mocks.createAccount,
    oxyServices: { checkUsernameAvailability: mocks.checkUsernameAvailability },
  }),
}));

// The create screen writes through the agent MUTATION now, not a store. Stubbing
// the hook keeps this file about which account gets minted, and means no query
// client has to be stood up to ask that question.
vi.mock('@/lib/hooks/use-agents', () => ({
  useCreateAgent: () => ({ mutateAsync: mocks.createAgent }),
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

/** `POST /accounts` answering with whatever handle it actually granted. */
function accountNamed(username: string): AccountNode {
  return { ...account, account: { ...account.account, username } };
}

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

  it('gives up with something a person can act on, once the attempts run out', async () => {
    // Never executed in production until Oxy stopped suffixing, so its ending
    // is exercised here rather than assumed: a rejection nobody can read is the
    // easy way for an untried path to fail.
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockRejectedValue(conflict());

    await expect(
      createBotAccount({ createAccount, username: 'helper', displayName: 'Helper' }),
    ).rejects.toThrow(/taken/i);

    // It really tried, rather than giving up on the first refusal — and it
    // stopped, rather than hammering Oxy forever.
    expect(createAccount.mock.calls.length).toBeGreaterThan(1);
    expect(createAccount.mock.calls.length).toBeLessThan(10);
    const attempted = createAccount.mock.calls.map(([data]) => data.username);
    expect(new Set(attempted).size).toBe(attempted.length);
  });

  it('still retries when the pre-flight search already chose the name', async () => {
    /**
     * Where the two halves meet, and the first place a disagreement between
     * them would show. The search picks a name it was told is free; Oxy refuses
     * it anyway, because free-then-taken is exactly the window the pre-check
     * cannot close. The retry has to carry on from there.
     */
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockRejectedValueOnce(conflict())
      .mockResolvedValue(account);
    const checkAvailability = vi.fn<(username: string) => Promise<boolean>>()
      .mockImplementation((username) => Promise.resolve(username === 'helper2bot'));

    await createBotAccount({
      createAccount,
      checkAvailability,
      username: 'helper',
      displayName: 'Helper',
    });

    const attempted = createAccount.mock.calls.map(([data]) => data.username);
    // The search's answer first, then something else — never the same name
    // twice, which would ask Oxy a question it has already refused.
    expect(attempted[0]).toBe('helper2bot');
    expect(attempted).toHaveLength(2);
    expect(attempted[1]).not.toBe(attempted[0]);
  });

  it('resolves the collision a first name makes likely, with a handle a person can read', async () => {
    /**
     * Generated agents are named like people now — "Claudio", "Nadia" — so the
     * handle is one short word in a namespace shared with every person on Oxy.
     * Collisions stop being the rare case and become the ordinary one, which
     * moves this whole path from "never runs" to "runs most of the time".
     *
     * `claudio2bot`, not `claudio-a7f3bot`: the pre-flight picks the readable
     * one, and the random suffix stays where it belongs — reacting to a race it
     * has already lost. The number sits INSIDE the label either way, because
     * the label is applied to the candidate rather than carried by it.
     */
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockResolvedValue(accountNamed('claudio2bot'));
    const checkAvailability = vi.fn<(username: string) => Promise<boolean>>()
      .mockImplementation((username) => Promise.resolve(username !== 'claudiobot'));

    await createBotAccount({
      createAccount,
      checkAvailability,
      username: 'claudio',
      displayName: 'Claudio',
    });

    expect(checkAvailability.mock.calls.map(([u]) => u)).toEqual(['claudiobot', 'claudio2bot']);
    expect(createAccount.mock.calls[0][0].username).toBe('claudio2bot');
  });

  /**
   * The label Oxy requires of a `bot` handle, asserted on the username that
   * actually LEAVES for `POST /accounts` — never on the suggestion, which is a
   * base by design, and never on a variable this file could read on the way
   * past. Two changes here have been "verified" against the payload being built
   * while every request failed.
   */
  it('mints a handle that ends in the label, from a suggestion that does not', async () => {
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockResolvedValue(account);

    await createBotAccount({ createAccount, username: 'helper', displayName: 'Helper' });

    expect(createAccount.mock.calls[0][0].username).toBe('helperbot');
  });

  it('ends the retry in the label too, which is where the wrong order breaks', async () => {
    /**
     * The whole reason the label goes on last. Applied before the collision
     * suffix, this second attempt would be `helperbot-a7f3` — refused for
     * exactly the reason the first one was, then refused four more times, until
     * the loop's own bound turns it into "that name is taken".
     */
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockRejectedValueOnce(conflict())
      .mockResolvedValue(account);

    await createBotAccount({ createAccount, username: 'helper', displayName: 'Helper' });

    const attempted = createAccount.mock.calls.map(([data]) => data.username);
    expect(attempted).toHaveLength(2);
    expect(attempted[1]).toMatch(/^helper-[a-z0-9]+bot$/);
    for (const username of attempted) {
      expect(username.toLowerCase().endsWith('bot'), username).toBe(true);
    }
  });

  it('does not label a suggestion that already carries one, whatever its case', async () => {
    // `mybotbot` is what an unconditional append produces, and Oxy would take
    // it — so nothing but this case says the append is conditional. The folded
    // one matters because Oxy's uniqueness index folds: a case-sensitive test
    // would leave `mybot` alone and relabel `MyBot`, two names that index
    // considers one.
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockResolvedValue(account);

    await createBotAccount({ createAccount, username: 'mybot', displayName: 'Mybot' });
    await createBotAccount({ createAccount, username: 'MyBot', displayName: 'MyBot' });

    expect(createAccount.mock.calls.map(([data]) => data.username)).toEqual(['mybot', 'MyBot']);
  });

  it('asks about the handle it will mint, not about the name it was given', async () => {
    // A pre-flight that asked about `helper` would be answering for a name
    // nobody is going to take — free or taken, it says nothing about whether
    // `helperbot` is available.
    const createAccount = vi.fn<(data: CreateAccountInput) => Promise<AccountNode>>()
      .mockResolvedValue(account);
    const checkAvailability = vi.fn<(username: string) => Promise<boolean>>()
      .mockResolvedValue(true);

    await createBotAccount({
      createAccount,
      checkAvailability,
      username: 'helper',
      displayName: 'Helper',
    });

    expect(checkAvailability.mock.calls.map(([u]) => u)).toEqual(['helperbot']);
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
    // Free unless a case says otherwise, so the existing cases keep meaning
    // what they meant before a check existed at all.
    if (mocks.checkUsernameAvailability.getMockImplementation() === undefined) {
      mocks.checkUsernameAvailability.mockResolvedValue({ available: true });
    }
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
   * An agent's likeness is an `IdentityMark` drawn in its account's own color,
   * and there is no image anywhere in it — so the generate-an-avatar round trip
   * is gone and nothing is minted with one.
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

/**
 * The handle a new agent is minted with, and whether anybody is told.
 *
 * Oxy SUFFIXES a colliding username rather than refusing it, so `helper`
 * quietly became `helper1` and nothing said so — the retry loop below was
 * written for a 409 that the create path has never returned. Asking first turns
 * that into a name chosen in the open.
 *
 * The pre-check is UX, never authority: the window between asking and minting
 * is real, so the 409 retry stays and the cases that cover it are untouched.
 */
describe('the handle a created agent gets', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    vi.clearAllMocks();
  });

  async function createOne() {
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
      return Promise.reject(new Error(`unexpected route: ${route}`));
    });
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

  /** The usernames the screen asked about, in order. */
  const asked = () => mocks.checkUsernameAvailability.mock.calls.map((call) => call[0]);
  /** The username it actually minted with. */
  const minted = () => mocks.createAccount.mock.calls[0]?.[0]?.username;

  it('mints the suggestion when it is free, and says nothing about handles', async () => {
    mocks.checkUsernameAvailability.mockResolvedValue({ available: true });
    mocks.createAccount.mockResolvedValue(accountNamed('helperbot'));

    await createOne();

    // `helperbot`, from a suggestion of `helper`: the label is what a bot's
    // handle must end in, and it is added here rather than proposed. Nothing is
    // said about it, because it is not an adjustment — it is the handle.
    expect(asked()).toEqual(['helperbot']);
    expect(minted()).toBe('helperbot');
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it('walks to a readable next handle when the suggestion is taken', async () => {
    // `helper2bot`, not `helper-a7f3bot`: this one is going to be read back, and
    // it is the shape Oxy's own suffixing produces. The number goes on the NAME
    // and the label stays last, which is the only order Oxy accepts.
    mocks.checkUsernameAvailability.mockImplementation((username: string) =>
      Promise.resolve({ available: username === 'helper3bot' }),
    );
    mocks.createAccount.mockResolvedValue(accountNamed('helper3bot'));

    await createOne();

    expect(asked()).toEqual(['helperbot', 'helper2bot', 'helper3bot']);
    expect(minted()).toBe('helper3bot');
  });

  it('tells the person the handle they got, when it is not the one proposed', async () => {
    mocks.checkUsernameAvailability.mockImplementation((username: string) =>
      Promise.resolve({ available: username === 'helper2bot' }),
    );
    mocks.createAccount.mockResolvedValue(accountNamed('helper2bot'));

    await createOne();

    // Visible, and carrying the handle — a message that did not name it would
    // leave the person to go and find out, which is the bug being fixed.
    expect(mocks.toastInfo).toHaveBeenCalledWith('agents.handleAdjusted');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('mints anyway when the check cannot answer, because the server decides', async () => {
    // Degrading to "I don't know" is right; degrading to "you may not create"
    // is not. The account still gets made, and Oxy still has the last word.
    mocks.checkUsernameAvailability.mockRejectedValue(new Error('oxy is down'));
    mocks.createAccount.mockResolvedValue(accountNamed('helperbot'));

    await createOne();

    expect(asked()).toEqual(['helperbot']);
    expect(minted()).toBe('helperbot');
    expect(mocks.createAgent).toHaveBeenCalled();
  });
});
