/**
 * An agent's look is a field of its Oxy `bot` account, because every other app draws a bot from
 * the account and never from Alia. These pin the three places Alia touches it: the account is
 * born with the look its agent will have, an agent made without choosing one takes the account's,
 * and a change is written to the account with the caller's own token.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const oxy = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<{ accountId: string; data: Record<string, unknown>; token: string | null }>,
  token: null as string | null,
  accountCharacter: { shape: 'heart', color: 'pink' } as Record<string, unknown> | undefined,
}));

vi.mock('@oxy.so/core', async () => {
  const actual = await vi.importActual<typeof import('@oxy.so/core')>('@oxy.so/core');
  return {
    ...actual,
    OxyServices: class {
      token: string | null = null;
      session = {
        setAccessToken: (token: string) => {
          this.token = token;
        },
      };
      accounts = {
        get: async (accountId: string) => ({
          accountId,
          parentAccountId: 'owner-account-1',
          kind: 'bot',
          relationship: 'owner',
          account: {
            id: accountId,
            kind: 'bot',
            ...(oxy.accountCharacter !== undefined && { character: oxy.accountCharacter }),
          },
          callerMembership: { status: 'active', role: 'owner', permissions: ['account:act_as'] },
        }),
        create: async (input: Record<string, unknown>) => {
          oxy.created.push(input);
          return { accountId: 'new-bot' };
        },
        update: async (accountId: string, data: Record<string, unknown>) => {
          oxy.updated.push({ accountId, data, token: this.token });
          return { accountId };
        },
      };
    },
  };
});

import {
  clearAgentAccountVerdicts,
  createAgentBotAccount,
  setAgentAccountCharacter,
  verifyAgentAccount,
} from '../agent-account.js';

beforeEach(() => {
  oxy.created.length = 0;
  oxy.updated.length = 0;
  oxy.accountCharacter = { shape: 'heart', color: 'pink' };
  clearAgentAccountVerdicts();
});

describe('an agent’s look on its Oxy account', () => {
  it('is sent when the account is created, so the account is born with it', async () => {
    const character = { shape: 'star', eyes: 'oval', color: 'teal' };
    await createAgentBotAccount({
      accessToken: 'owner-token',
      username: 'ada',
      displayName: 'Ada',
      character,
    });
    expect(oxy.created[0]).toMatchObject({ kind: 'bot', character });
  });

  it('is left out of the create call when none was chosen, so Oxy picks one', async () => {
    await createAgentBotAccount({
      accessToken: 'owner-token',
      username: 'ada',
      displayName: 'Ada',
    });
    expect(oxy.created[0]).not.toHaveProperty('character');
  });

  it('comes back with the verdict, for an agent made without choosing one', async () => {
    const verdict = await verifyAgentAccount({
      oxyUserId: 'user-1',
      accessToken: 'owner-token',
      oxyAccountId: 'bot-1',
      cache: false,
    });
    expect(verdict).toMatchObject({
      permitted: true,
      character: { shape: 'heart', color: 'pink' },
    });
  });

  it('is absent from the verdict when the account carries none yet (before the backfill)', async () => {
    oxy.accountCharacter = undefined;
    const verdict = await verifyAgentAccount({
      oxyUserId: 'user-1',
      accessToken: 'owner-token',
      oxyAccountId: 'bot-1',
      cache: false,
    });
    expect(verdict).toMatchObject({ permitted: true });
    expect(verdict).not.toHaveProperty('character');
  });

  it('is written whole to the account with the caller’s own token', async () => {
    const character = { preset: 'blue_beret', color: 'orchid' };
    await setAgentAccountCharacter({
      accessToken: 'owner-token',
      oxyAccountId: 'bot-1',
      character,
    });
    expect(oxy.updated).toEqual([
      { accountId: 'bot-1', data: { character }, token: 'owner-token' },
    ]);
  });
});
