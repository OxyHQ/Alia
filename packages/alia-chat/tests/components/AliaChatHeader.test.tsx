import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
  profiles: [] as Array<{ agents: Array<{ id: string; name: string }>; onPress: () => void }>,
}));

vi.mock('@oxy.so/bloom/button-group', () => ({
  ButtonGroup: ({ children }: { children?: React.ReactNode }) => children,
  ButtonGroupItem: (props: Record<string, unknown>) => {
    seen.items.push(props);
    return null;
  },
}));
vi.mock('@oxy.so/bloom/icons', () => ({
  RiArrowLeftLine: 'back-icon',
  RiDeleteBin6Line: 'bin-icon',
  RiMoreFill: 'more-icon',
  RiShare2Line: 'share-icon',
}));
vi.mock('@oxy.so/bloom/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) => children,
  DropdownMenuItem: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    seen.rows.push(props);
    return null;
  },
}));
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
  readAgentCharacter: (value: unknown) => ({ value }),
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
    seen.rows = [];
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

  it('joins the agents that answered to Alia, each drawn with the look it has', () => {
    const agents = ['lumi', 'atlas'].map((id) => ({
      id,
      name: id.toUpperCase(),
      character: { shape: 'heart', color: id },
    }));
    render(<AliaChatHeader hasMessages agents={agents} onClear={vi.fn()} />);

    expect(team()).toEqual(['Alia', 'LUMI', 'ATLAS']);
    expect(
      seen.profiles.at(-1)?.agents.map((agent) => (agent as { avatar?: unknown }).avatar),
    ).toEqual([
      { preset: 'alia' },
      { value: { shape: 'heart', color: 'lumi' } },
      { value: { shape: 'heart', color: 'atlas' } },
    ]);
  });

  it('runs the host action when the profile is pressed, and is inert without one', () => {
    const onProfilePress = vi.fn();
    render(<AliaChatHeader hasMessages onClear={vi.fn()} onProfilePress={onProfilePress} />);
    seen.profiles.at(-1)?.onPress();
    expect(onProfilePress).toHaveBeenCalledTimes(1);

    render(<AliaChatHeader hasMessages onClear={vi.fn()} />);
    expect(() => seen.profiles.at(-1)?.onPress()).not.toThrow();
  });

  it('draws a back button at the start, named in the host’s words, only where there is somewhere to go', () => {
    const onBack = vi.fn();
    render(<AliaChatHeader hasMessages={false} onClear={vi.fn()} onBack={onBack} />);
    (item('Back')?.onPress as () => void)();
    expect(onBack).toHaveBeenCalledTimes(1);

    seen.items = [];
    render(<AliaChatHeader hasMessages={false} onClear={vi.fn()} />);
    expect(item('Back')).toBeUndefined();
  });

  it('lets the host’s own start content take the back button’s place', () => {
    render(
      <AliaChatHeader
        hasMessages={false}
        onClear={vi.fn()}
        onBack={vi.fn()}
        leading={<>drawer</>}
      />,
    );
    expect(item('Back')).toBeUndefined();
  });

  it('draws nothing over an empty chat: there is nothing to do there', () => {
    const renderer = render(
      <AliaChatHeader hasMessages={false} onClear={vi.fn()} onShare={vi.fn()} />,
    );
    expect(renderer.toJSON()).toBeNull();
    expect(seen.items).toEqual([]);
  });

  it('keeps what the host brought on an empty chat, but not share or the menu', () => {
    render(
      <AliaChatHeader
        hasMessages={false}
        onClear={vi.fn()}
        onBack={vi.fn()}
        onShare={vi.fn()}
        menu={<>host rows</>}
      />,
    );
    expect(item('Back')).toBeDefined();
    expect(item('Share')).toBeUndefined();
    expect(item('More')).toBeUndefined();
  });

  it('draws share with a conversation, where the host can share', () => {
    const onShare = vi.fn();
    render(<AliaChatHeader hasMessages onClear={vi.fn()} onShare={onShare} />);
    (item('Share')?.onPress as () => void)();
    expect(onShare).toHaveBeenCalledTimes(1);

    seen.items = [];
    render(<AliaChatHeader hasMessages onClear={vi.fn()} />);
    expect(item('Share')).toBeUndefined();
  });

  it('has the three-dots menu with a conversation, Clear in it after the host’s rows', () => {
    const onClear = vi.fn();
    render(<AliaChatHeader hasMessages onClear={onClear} menu={<>host rows</>} />);
    expect(item('More')).toBeDefined();
    expect(seen.rows).toHaveLength(1);
    expect(seen.rows[0]?.tone).toBe('danger');
    (seen.rows[0]?.onPress as () => void)();
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("takes the host's labels for its buttons", () => {
    render(
      <AliaChatLabelsProvider labels={{ back: 'Volver', share: 'Compartir', more: 'Más' }}>
        <AliaChatHeader hasMessages onClear={vi.fn()} onBack={vi.fn()} onShare={vi.fn()} />
      </AliaChatLabelsProvider>,
    );
    expect(item('Volver')).toBeDefined();
    expect(item('Compartir')).toBeDefined();
    expect(item('Más')).toBeDefined();
  });
});
