import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  agentAvatars: [] as unknown[],
  agentKeys: [] as Array<number | undefined>,
  markKeys: [] as Array<number | undefined>,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: React.ReactNode }) => children,
  Pressable: ({ children }: { children?: React.ReactNode }) => children,
  StyleSheet: { hairlineWidth: 1 },
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
vi.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({
    colors: { backgroundSecondary: '#eee', backgroundTertiary: '#ddd', border: '#ccc' },
  }),
}));
vi.mock('@oxy.so/bloom/agent-avatar', () => ({
  AgentAvatar: ({ character, reactionKey }: { character: unknown; reactionKey?: number }) => {
    seen.agentAvatars.push(character);
    seen.agentKeys.push(reactionKey);
    return null;
  },
}));
vi.mock('../../src/lib/agent-character', () => ({
  agentCharacter: (id: string) => ({ id }),
}));
vi.mock('@oxy.so/bloom/typography', () => ({
  Text: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock('../../src/components/AliaChatContent', () => ({
  AliaChatMark: ({ reactionKey }: { reactionKey?: number }) => {
    seen.markKeys.push(reactionKey);
    return null;
  },
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
    seen.markKeys = [];
    seen.agentAvatars = [];
    seen.agentKeys = [];
  });

  it('shows no profile on an empty chat, whose greeting already carries the avatar', () => {
    const renderer = render(<AliaChatHeader hasMessages={false} onClear={vi.fn()} />);

    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Alia' })).toHaveLength(0);
    expect(seen.markKeys).toEqual([]);
  });

  it('shows the profile once there is a conversation', () => {
    const renderer = render(<AliaChatHeader hasMessages onClear={vi.fn()} />);

    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Alia' }).length).toBeGreaterThan(0);
  });

  it('puts the agents that answered beside Alia, named together, three at most', () => {
    const agents = ['lumi', 'atlas', 'sol'].map((id) => ({ id, name: id.toUpperCase() }));
    const renderer = render(<AliaChatHeader hasMessages agents={agents} onClear={vi.fn()} />);

    // Alia and the first two agents: a third agent is in the conversation, not in the profile.
    expect(seen.agentAvatars).toEqual([{ id: 'lumi' }, { id: 'atlas' }]);
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Alia + LUMI + ATLAS' }).length,
    ).toBeGreaterThan(0);
  });

  it('has every avatar in the profile react to a tap, not only Alia', () => {
    const agents = [{ id: 'lumi', name: 'Lumi' }];
    const renderer = render(<AliaChatHeader hasMessages agents={agents} onClear={vi.fn()} />);
    seen.markKeys = [];
    seen.agentKeys = [];

    const profile = renderer.root.findAllByProps({ accessibilityLabel: 'Alia + Lumi' })[0];
    act(() => (profile?.props.onPress as () => void)());

    expect(seen.markKeys.at(-1)).toBe(1);
    expect(seen.agentKeys.at(-1)).toBe(1);
  });

  it('draws only Alia when no agent has answered', () => {
    render(<AliaChatHeader hasMessages agents={[]} onClear={vi.fn()} />);

    expect(seen.agentAvatars).toEqual([]);
  });

  it('offers neither clear nor close on an empty chat that cannot be dismissed', () => {
    render(<AliaChatHeader hasMessages={false} onClear={vi.fn()} />);

    expect(seen.items).toEqual([]);
  });

  it('clears the chat from its own island once there are messages', () => {
    const onClear = vi.fn();
    render(<AliaChatHeader hasMessages onClear={onClear} />);

    (item('Clear')?.onPress as () => void)();
    expect(onClear).toHaveBeenCalledOnce();
    expect(item('Close')).toBeUndefined();
  });

  it('draws the close button only where the host can dismiss the chat', () => {
    const onClose = vi.fn();
    render(<AliaChatHeader hasMessages={false} onClear={vi.fn()} onClose={onClose} />);

    (item('Close')?.onPress as () => void)();
    expect(onClose).toHaveBeenCalledOnce();
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

  it('makes the profile a button: it runs the host action when given one', () => {
    const onProfilePress = vi.fn();
    const renderer = render(
      <AliaChatHeader hasMessages onClear={vi.fn()} onProfilePress={onProfilePress} />,
    );

    act(() => renderer.root.findByProps({ accessibilityLabel: 'Alia' }).props.onPress());

    expect(onProfilePress).toHaveBeenCalledOnce();
    expect(seen.markKeys.every((key) => key === 0)).toBe(true);
  });

  it('makes the avatar wave when the host gives the profile no action', () => {
    const renderer = render(<AliaChatHeader hasMessages onClear={vi.fn()} />);
    expect(seen.markKeys.at(-1)).toBe(0);

    act(() => renderer.root.findByProps({ accessibilityLabel: 'Alia' }).props.onPress());

    expect(seen.markKeys.at(-1)).toBe(1);
  });
});
