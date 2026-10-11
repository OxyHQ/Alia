import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The approval cards: above an agent's thread they show that agent's
 * requests, as before; above an Alia conversation, the ones asked in it — a
 * payment or a deletion Alia prepared. Answering sends back the hash of the
 * exact action shown.
 *
 * Bloom's `Notification` is stubbed as a host element carrying its props; the
 * words come from the real catalog.
 */

const { hosts } = vi.hoisted(() => ({
  hosts: async (...names: string[]) => {
    const ReactModule = await import('react');
    return Object.fromEntries(
      names.map((name) => [
        name,
        ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
          ReactModule.createElement(name, props, children as React.ReactNode),
      ]),
    );
  },
}));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('@oxy.so/bloom/notification', async () => hosts('Notification'));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('@/shared/api/client', () => ({
  default: { get: api.get, post: api.post, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const { AgentApprovalsBanner, ConversationApprovalsBanner } = await import(
  '@/features/agents/ui/agent-approvals-banner'
);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ALIA_DELETE = {
  id: 'ap-alia',
  actorType: 'alia',
  agentId: null,
  conversationId: 'conv-1',
  kind: 'deletion',
  hash: 'hash-alia',
  toolName: 'oxy_social__deletePost',
  summary: 'Deletion · social deletePost {"id":"p1"}',
  details: {},
  createdAt: '2026-10-11T00:00:00Z',
  expiresAt: '2026-10-12T00:00:00Z',
};
const AGENT_SEND = {
  ...ALIA_DELETE,
  id: 'ap-agent',
  actorType: 'agent',
  agentId: 'agent-1',
  conversationId: null,
  kind: null,
  hash: 'hash-agent',
  summary: 'browser_type {...}',
};
const OTHER_CONVERSATION = { ...ALIA_DELETE, id: 'ap-other', conversationId: 'conv-2' };

let renderer: ReactTestRenderer | null = null;

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  if (!renderer) throw new Error('not rendered');
  return renderer;
}

function cards(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => (node.type as unknown) === 'Notification');
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockResolvedValue({ data: { approvals: [ALIA_DELETE, AGENT_SEND, OTHER_CONVERSATION] } });
  api.post.mockResolvedValue({ data: { status: 'succeeded' } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('approval cards', () => {
  it('above an Alia conversation: only what was asked in it, titled by its kind', async () => {
    const tree = await render(<ConversationApprovalsBanner conversationId="conv-1" />);
    const shown = cards(tree);
    expect(shown.map((card) => card.props.description)).toEqual([ALIA_DELETE.summary]);
    expect(shown[0]?.props.title).toBe('Approve this deletion?');
  });

  it("above an agent's thread: that agent's requests, as before", async () => {
    const tree = await render(<AgentApprovalsBanner agentId="agent-1" />);
    const shown = cards(tree);
    expect(shown.map((card) => card.props.description)).toEqual([AGENT_SEND.summary]);
    expect(shown[0]?.props.title).toBe('Approval required');
  });

  it('approving sends the hash of the exact action shown', async () => {
    const tree = await render(<ConversationApprovalsBanner conversationId="conv-1" />);
    const actions = cards(tree)[0]?.props.actions as Array<{ onPress: () => void }>;
    await act(async () => actions[1]?.onPress());
    expect(api.post).toHaveBeenCalledWith('/agents/approvals/ap-alia/decision', {
      approved: true,
      hash: 'hash-alia',
    });
    await act(async () => actions[0]?.onPress());
    expect(api.post).toHaveBeenLastCalledWith('/agents/approvals/ap-alia/decision', {
      approved: false,
      hash: 'hash-alia',
    });
  });
});
