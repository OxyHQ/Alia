import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({
  agent: { id: 'eusebio', name: 'Eusebio' },
  messages: [
    { role: 'assistant', content: 'Hello again.', agent: { id: 'eusebio', name: 'Eusebio' } },
  ],
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@oxy.so/bloom/typography', () => ({ Text: 'Text' }));
vi.mock('@oxy.so/bloom/agent-avatar', () => ({
  AgentAvatarProvider: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock('../../src/lib/labels', () => ({
  AliaChatLabelsProvider: ({ children }: React.PropsWithChildren) => children,
  useLabels: () => ({ t: (key: string) => key }),
}));
vi.mock('../../src/runtime/config', () => ({
  AliaRuntimeProvider: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock('../../src/runtime/sharing', () => ({
  SharedConversationGoneError: class extends Error {},
  useSharedConversation: () => ({ data, isLoading: false }),
  sharedMessages: () =>
    data.messages.map((message, index) => ({
      id: `shared-${index}`,
      role: message.role,
      content: message.content,
      agentInfo: message.agent,
    })),
}));
vi.mock('../../src/components/thread/ThreadSkeleton', () => ({ ThreadSkeleton: () => null }));
vi.mock('../../src/components/thread/AliaThread', async () => ({
  AliaThread: (props: Record<string, unknown>) => React.createElement('Thread', props),
}));
import { AliaSharedConversation } from '../../src/components/AliaSharedConversation';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));

it('passes the shared conversation lead to the same thread membership rule', () => {
  act(() => {
    renderer = create(<AliaSharedConversation token="shared" />);
  });
  const thread = renderer.root.findByType('Thread' as never);
  expect(thread.props.memberIds).toEqual(new Set(['eusebio']));
  expect(thread.props.messages[0].agentInfo).toEqual(data.agent);
  expect(thread.props.readOnly).toBe(true);
});
