import { createElement } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * A turn as a chat bubble: the person's at the end in the agent's colour with its icons on the
 * side facing the thread, a reply at the start with its icons after it; the icons appear on hover.
 */

const { hosts } = vi.hoisted(() => ({
  hosts: async (...names: string[]) => {
    const ReactModule = await import('react');
    return Object.fromEntries(
      names.map((name) => [
        name,
        ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
          ReactModule.createElement(name, props, children),
      ]),
    );
  },
}));

vi.mock('react-native', async () => ({
  ...(await hosts('View', 'Pressable')),
  Platform: { OS: 'web' },
}));
vi.mock('@oxy.so/bloom/hooks', async () => {
  const ReactModule = await import('react');
  return {
    useInteractionState: () => {
      const [state, setState] = ReactModule.useState(false);
      return { state, onIn: () => setState(true), onOut: () => setState(false) };
    },
  };
});
vi.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({
    colors: { backgroundSecondary: '#eee', text: '#111', textSecondary: '#666' },
  }),
}));

import { ChatBubble } from '../../../src/components/thread/ChatBubble';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const Glyph = () => null;
const action = (key: string, onPress = vi.fn()) => ({
  key,
  label: key,
  icon: Glyph as never,
  onPress,
});

const COLORS = { background: '#009957', foreground: '#ffffff' };

function mount(side: 'user' | 'reply', actions = [action('copy')]) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <ChatBubble side={side} colors={side === 'user' ? COLORS : null} actions={actions}>
        {createElement('View', { testID: 'words' })}
      </ChatBubble>,
    );
  });
  return renderer.root;
}
const is = (node: ReactTestInstance, name: string) => (node.type as unknown) === name;
const row = (root: ReactTestInstance) => root.findAll((n) => is(n, 'View'))[0]!;
const icons = (root: ReactTestInstance) =>
  root.find((n) => is(n, 'View') && String(n.props.className ?? '').includes('gap-0.5'));

describe('ChatBubble', () => {
  it("puts the person's bubble at the end in the agent's colour, icons first", () => {
    const root = mount('user');
    expect(row(root).props.className).toContain('justify-end');
    const children = row(root).children as ReactTestInstance[];
    expect(String(children[0]!.props.className)).toContain('gap-0.5');
    const bubble = children[1]!;
    expect(bubble.props.style).toEqual({ backgroundColor: '#009957' });
    expect(String(bubble.props.className)).toContain('rounded-3xl');
    expect(String(bubble.props.className)).toContain('py-3');
    expect(String(bubble.props.className)).toContain('max-w-[80%]');
  });

  it('puts a reply at the start in a neutral bubble, 8px tall, icons after it', () => {
    const root = mount('reply');
    expect(row(root).props.className).toContain('justify-start');
    const children = row(root).children as ReactTestInstance[];
    const bubble = children[0]!;
    expect(String(bubble.props.className)).toContain('bg-background-tertiary-default');
    expect(String(bubble.props.className)).toContain('py-2');
    expect(bubble.props.style).toBeUndefined();
    expect(String(children[1]!.props.className)).toContain('gap-0.5');
  });

  it('shows the icons only while the row is hovered', () => {
    const root = mount('reply');
    expect(icons(root).props.style).toEqual({ opacity: 0 });
    expect(icons(root).props.pointerEvents).toBe('none');
    act(() => row(root).props.onPointerEnter());
    expect(icons(root).props.style).toEqual({ opacity: 1 });
    expect(icons(root).props.pointerEvents).toBe('auto');
    act(() => row(root).props.onPointerLeave());
    expect(icons(root).props.style).toEqual({ opacity: 0 });
  });

  it('draws one pressable per action, named by its label, that does what the action does', () => {
    const copy = vi.fn();
    const root = mount('reply', [action('copy', copy), action('like')]);
    const buttons = root.findAll((n) => is(n, 'Pressable'));
    expect(buttons.map((b) => b.props.accessibilityLabel)).toEqual(['copy', 'like']);
    act(() => buttons[0]!.props.onPress());
    expect(copy).toHaveBeenCalledOnce();
  });

  it('draws no icon group when the turn has no actions', () => {
    const root = mount('reply', []);
    expect(root.findAll((n) => String(n.props.className ?? '').includes('gap-0.5'))).toHaveLength(
      0,
    );
  });
});
