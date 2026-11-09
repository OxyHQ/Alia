import type React from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  thread: null as null | Record<string, unknown>,
  participants: null as null | Record<string, unknown>,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});
vi.mock('@oxy.so/bloom/button-group', () => ({
  ButtonGroup: ({ children }: { children?: React.ReactNode }) => children,
  ButtonGroupItem: () => null,
}));
vi.mock('@oxy.so/bloom/icons/RiArrowLeftLine', () => ({ RiArrowLeftLine: () => null }));
vi.mock('@oxy.so/bloom/page-header', () => ({
  PageHeader: ({ leading, title }: { leading?: React.ReactNode; title?: React.ReactNode }) => (
    <>
      {leading}
      {title}
    </>
  ),
}));
vi.mock('@oxy.so/bloom/typography', () => ({
  Text: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock('../../../src/lib/labels', () => ({
  useLabels: () => ({ t: (k: string) => k, back: 'Back' }),
}));
vi.mock('../../../src/lib/agent-character', () => ({ readAgentCharacter: (v: unknown) => v }));
vi.mock('../../../src/lib/alia-character', () => ({ ALIA_AVATAR: { preset: 'alia' } }));
vi.mock('../../../src/components/AliaParticipants', () => ({
  AliaParticipants: (props: Record<string, unknown>) => {
    seen.participants = props;
    return null;
  },
}));
vi.mock('../../../src/components/thread/AliaThread', () => ({
  AliaThread: (props: Record<string, unknown>) => {
    seen.thread = props;
    return null;
  },
}));

const { AgentExchangeView } = await import('../../../src/components/thread/AgentExchangeView');
const { ALIA_LEAD } = await import('../../../src/lib/participants');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('draws the exchange read-only, with no composer and nothing to act on', () => {
  const onBack = vi.fn();
  const sindi = { id: 'sindi', name: 'Sindi' };
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <AgentExchangeView
        exchange={{ agent: sindi, pairs: [{ asker: null, task: 'Flats?', answer: 'Three.' }] }}
        lead={ALIA_LEAD}
        onBack={onBack}
      />,
    );
  });
  const props = seen.thread as Record<string, unknown>;
  expect(props.readOnly).toBe(true);
  for (const action of ['onRegenerate', 'onStartEdit', 'onReply', 'onOpenAgentChat', 'empty']) {
    expect(props[action]).toBeUndefined();
  }
  // The asker is Alia (no agent identity) and the answerer is Sindi, never the person.
  const messages = props.messages as Array<Record<string, unknown>>;
  expect(messages.map((m) => [m.role, m.content, (m.agentInfo as typeof sindi)?.id])).toEqual([
    ['assistant', 'Flats?', undefined],
    ['assistant', 'Three.', 'sindi'],
  ]);
  // Neither of them is announced as a newcomer in a conversation they are both in.
  expect([...(props.memberIds as Set<string>)]).toEqual(expect.arrayContaining(['alia', 'sindi']));
  expect(renderer?.root.findAll((n) => (n.type as unknown) === 'View')[0]?.props.testID).toBe(
    'agent-exchange',
  );
});
