import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<{ agents: Array<{ id: string; name: string }>; onPress: () => void }>,
}));

vi.mock('@oxy.so/bloom/button-group', () => ({
  ButtonGroup: ({ children }: { children?: React.ReactNode }) => children,
  ButtonGroupItem: (props: Record<string, unknown>) => {
    seen.items.push(props);
    return null;
  },
}));
vi.mock('@oxy.so/bloom/icons', () => ({ RiCloseLine: 'close', RiDeleteBin6Line: 'bin' }));
vi.mock('@oxy.so/bloom/page-header', () => ({
  PageHeader: ({
    leading,
    title,
    actions,
  }: {
    leading?: React.ReactNode;
    title?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <>
      {leading}
      {title}
      {actions}
    </>
  ),
}));
vi.mock('@oxy.so/bloom/agent-reply', () => ({
  AgentProfile: (props: { agents: Array<{ id: string; name: string }>; onPress: () => void }) => {
    seen.profiles.push(props);
    return null;
  },
}));
vi.mock('../../src/components/AliaAvatar', () => ({ ALIA_AVATAR: { preset: 'alia' } }));
vi.mock('../../src/lib/agent-character', () => ({
  agentCharacter: (id: string) => ({ id }),
}));

import { AliaChatHeader } from '../../src/components/AliaChatHeader';
import { AliaChatLabelsProvider } from '../../src/lib/labels';

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (renderer === null) throw new Error('The header did not render.');
  return renderer;
}

const item = (label: string) => seen.items.find((props) => props.accessibilityLabel === label);

describe('AliaChatHeader', () => {
  beforeEach(() => {
    seen.items = [];
    seen.profiles = [];
  });

  const team = () => seen.profiles.at(-1)?.agents.map((agent) => agent.name);

  it('shows no profile on an empty chat, whose greeting already carries the avatar', () => {
    render(<AliaChatHeader hasMessages={false} onClear={vi.fn()} />);

    expect(seen.profiles).toEqual([]);
  });

  it('shows Alia alone once there is a conversation', () => {
    render(<AliaChatHeader hasMessages onClear={vi.fn()} />);

    expect(team()).toEqual(['Alia']);
  });

  it('joins the agents that answered to Alia, with their own characters', () => {
    const agents = ['lumi', 'atlas'].map((id) => ({ id, name: id.toUpperCase() }));
    render(<AliaChatHeader hasMessages agents={agents} onClear={vi.fn()} />);

    expect(team()).toEqual(['Alia', 'LUMI', 'ATLAS']);
    expect(
      seen.profiles.at(-1)?.agents.map((agent) => (agent as { avatar?: unknown }).avatar),
    ).toEqual([{ preset: 'alia' }, { id: 'lumi' }, { id: 'atlas' }]);
  });

  it('runs the host action when the profile is pressed, and is inert without one', () => {
    const onProfilePress = vi.fn();
    render(<AliaChatHeader hasMessages onClear={vi.fn()} onProfilePress={onProfilePress} />);
    seen.profiles.at(-1)?.onPress();
    expect(onProfilePress).toHaveBeenCalledTimes(1);

    render(<AliaChatHeader hasMessages onClear={vi.fn()} />);
    expect(() => seen.profiles.at(-1)?.onPress()).not.toThrow();
  });

  it('offers neither clear nor close on an empty chat that cannot be dismissed', () => {
    render(<AliaChatHeader hasMessages={false} onClear={vi.fn()} />);

    expect(seen.items).toEqual([]);
  });

  it('clears the chat from its own island once there are messages', () => {
    const onClear = vi.fn();
    render(<AliaChatHeader hasMessages onClear={onClear} />);

    (item('Clear')?.onPress as () => void)();
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(item('Close')).toBeUndefined();
  });

  it('draws the close button only where the host can dismiss the chat', () => {
    const onClose = vi.fn();
    render(<AliaChatHeader hasMessages={false} onClear={vi.fn()} onClose={onClose} />);

    (item('Close')?.onPress as () => void)();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(item('Clear')).toBeUndefined();
  });

  it("takes the host's labels for its buttons", () => {
    render(
      <AliaChatLabelsProvider labels={{ clear: 'Borrar', close: 'Cerrar' }}>
        <AliaChatHeader hasMessages onClear={vi.fn()} onClose={vi.fn()} />
      </AliaChatLabelsProvider>,
    );

    expect(item('Borrar')).toBeDefined();
    expect(item('Cerrar')).toBeDefined();
  });
});
