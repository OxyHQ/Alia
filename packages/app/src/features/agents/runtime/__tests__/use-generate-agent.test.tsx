import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Creating an agent from a sentence stores the model picked on that screen as
 * the new agent's model (ADR 0012: `POST /agents` takes a `modelId`), and
 * `null` — nobody picked one — as the server's default.
 */

const created = vi.hoisted(() => ({ bodies: [] as Array<Record<string, unknown>> }));

vi.mock('@/features/agents/runtime/use-agents', () => ({
  useCreateAgent: () => ({
    mutateAsync: async (body: Record<string, unknown>) => {
      created.bodies.push(body);
      return { _id: 'agent-1' };
    },
  }),
}));
vi.mock('@/shared/api/client', () => ({
  default: { post: async () => ({ data: { suggestedUsername: 'scout', name: 'Scout', tagline: 't' } }) },
}));
vi.mock('@/shared/api/routes', () => ({ API_ROUTES: { agents: { generate: '/agents/generate' } } }));
vi.mock('@/features/agents/model/bot-account', () => ({
  createBotAccount: async () => ({ accountId: 'acct-1', account: { username: 'scoutbot' } }),
  applyBotUsernameSuffix: (name: string) => `${name}bot`,
}));
vi.mock('@oxy.so/core', () => ({ SELECTABLE_ACCOUNT_CATEGORY_IDS: [] }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ createAccount: vi.fn(), oxyServices: {} }) }));

import { useGenerateAgent } from '../use-generate-agent';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function hook() {
  let generate: ReturnType<typeof useGenerateAgent> | null = null;
  function Probe() {
    generate = useGenerateAgent();
    return null;
  }
  act(() => {
    create(<Probe />);
  });
  return generate!;
}

beforeEach(() => {
  created.bodies = [];
});

describe('useGenerateAgent', () => {
  it('creates the agent with the model picked for it', async () => {
    await hook()('a research scout', 'general', 'acme/chat-1');
    expect(created.bodies[0]).toMatchObject({ oxyAccountId: 'acct-1', modelId: 'acme/chat-1' });
  });

  it('sends null when nobody picked one, which is the server default', async () => {
    await hook()('a research scout', 'general');
    expect(created.bodies[0]).toMatchObject({ modelId: null });
  });
});
