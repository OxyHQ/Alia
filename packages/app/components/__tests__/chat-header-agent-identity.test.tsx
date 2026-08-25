import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who the header says you are talking to, and what it costs to say it.
 *
 * `ChatHeader` is memoized on purpose: the chat screen re-renders roughly twenty
 * times a SECOND while an answer streams, and until now none of the header's
 * props changed per token, so the memo held and the whole header — credits,
 * menu, ghost toggle — was rendered once. Adding an identity is where that gets
 * lost, because the obvious way to pass one is an object literal at the call
 * site, and an object literal is a new reference on every render.
 *
 * So the identity crosses as two primitives, and both halves of that are pinned
 * here: the memo still holds with them (and demonstrably does NOT hold when a
 * reference changes per render), and the call site is checked for the literal
 * that would break it.
 */

const renders = { credits: 0 };

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web },
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const icon = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props);
  return { Search: icon('Search'), MoreHorizontal: icon('MoreHorizontal'), Menu: icon('Menu') };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/ui/ghost-icon', async () => {
  const ReactModule = await import('react');
  return { GhostIcon: (props: Record<string, unknown>) => ReactModule.createElement('GhostIcon', props) };
});

vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Button', props, children),
  };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@/components/ui/agent-glyph', async () => {
  const ReactModule = await import('react');
  return { AgentGlyph: (props: Record<string, unknown>) => ReactModule.createElement('AgentGlyph', props) };
});

/**
 * The render counter hangs off this one because it is always mounted, in both
 * the agent and the plain case — so a count of 1 means the whole header
 * rendered once, not that a conditional branch happened to be skipped.
 */
vi.mock('@/components/credits-menu', async () => {
  const ReactModule = await import('react');
  return {
    CreditsMenu: () => {
      renders.credits += 1;
      return ReactModule.createElement('CreditsMenu', null);
    },
  };
});

vi.mock('expo-router', () => ({
  useNavigation: () => ({ toggleDrawer: () => {} }),
  useRouter: () => ({ push: () => {} }),
}));

vi.mock('@/components/ui/dropdown-menu', async () => {
  const ReactModule = await import('react');
  const host = (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    Root: host('DropdownRoot'),
    Trigger: host('DropdownTrigger'),
    Content: host('DropdownContent'),
    Item: host('DropdownItem'),
    ItemIcon: host('DropdownItemIcon'),
    ItemTitle: host('DropdownItemTitle'),
    Separator: host('DropdownSeparator'),
  };
});

vi.mock('@oxyhq/bloom/toast', () => ({ toast: { info: () => {} } }));
vi.mock('@oxyhq/bloom/surfaces', () => ({ confirm: async () => false }));
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ChatHeader } from '../chat-header';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function render(element: React.ReactElement) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(element);
  });
  if (next === undefined) throw new Error('ChatHeader did not render');
  renderer = next;
  return next;
}

function nodes(r: ReactTestRenderer, name: string) {
  return r.root.findAll((node) => node.type === name);
}

beforeEach(() => {
  renders.credits = 0;
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('the chat header, with an agent', () => {
  it("shows the agent's mark in its own color, beside its name", () => {
    const r = render(<ChatHeader agentName="Pepe" agentColor="#7c3aed" />);

    expect(nodes(r, 'AgentGlyph')[0]?.props).toMatchObject({ color: '#7c3aed', label: 'Pepe' });
    expect(
      nodes(r, 'Text').map((node) => node.props.children),
    ).toContain('Pepe');
  });

  it('passes an unresolved color through untouched, for the glyph to fall back on', () => {
    // Oxy failing to resolve the account is ordinary traffic, and the decision
    // about what to draw then belongs to the glyph — the header must not invent
    // a color of its own on the way, which would make the fallback unreachable.
    const r = render(<ChatHeader agentName="Pepe" agentColor={null} />);

    expect(nodes(r, 'AgentGlyph')[0]?.props.color).toBeNull();
  });

  it('draws no identity at all on Alia’s own chat', () => {
    const r = render(<ChatHeader />);

    expect(nodes(r, 'AgentGlyph')).toHaveLength(0);
    // The rest of the header is still there — this is the same header, minus a
    // title it never had.
    expect(nodes(r, 'CreditsMenu')).toHaveLength(1);
    expect(nodes(r, 'Search')).toHaveLength(1);
  });
});

describe('the chat header, while an answer streams', () => {
  const STREAMING_FLUSHES = 20;

  it('renders once across a whole stream, identity and all', () => {
    const onGhostModePress = () => {};
    const header = () => (
      <ChatHeader onGhostModePress={onGhostModePress} agentName="Pepe" agentColor="#7c3aed" />
    );

    const r = render(header());
    for (let i = 0; i < STREAMING_FLUSHES; i++) {
      act(() => r.update(header()));
    }

    expect(renders.credits).toBe(1);
  });

  it('re-renders on every flush the moment one prop stops comparing by value', () => {
    // The control for the assertion above: without it, "rendered once" could
    // just as well mean the harness cannot see a re-render at all. A fresh
    // arrow per render is the realistic way this breaks — an inline
    // `onGhostModePress={() => …}` or an inline identity object at the call
    // site — and it costs exactly one full header render per streaming flush.
    const r = render(<ChatHeader onGhostModePress={() => {}} agentName="Pepe" />);
    for (let i = 0; i < STREAMING_FLUSHES; i++) {
      act(() => r.update(<ChatHeader onGhostModePress={() => {}} agentName="Pepe" />));
    }

    expect(renders.credits).toBe(STREAMING_FLUSHES + 1);
  });
});

/**
 * The memo above is only worth anything if the CALL SITE keeps its side of the
 * bargain, and no render-count test of the component can see that: it renders
 * the props it was handed. So the call site is read.
 */
describe('the call site in chat-page-content', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../chat-page-content.tsx', import.meta.url)),
    'utf8',
  );

  /** The `<ChatHeader … />` element, whole. */
  function chatHeaderElement(text: string): string {
    const start = text.indexOf('<ChatHeader');
    if (start === -1) throw new Error('no <ChatHeader> element in the source');
    const end = text.indexOf('/>', start);
    if (end === -1) throw new Error('the <ChatHeader> element is not self-closing');
    return text.slice(start, end + 2);
  }

  /** A prop value that is built fresh on every render, and so defeats the memo. */
  const FRESHLY_BUILT = /=\{\s*[{[(]/;

  it('hands the header no value that is rebuilt per render', () => {
    const element = chatHeaderElement(source);

    // Positive control on the extractor itself: an assertion over an empty
    // string would pass, and would keep passing after the element was renamed.
    expect(element).toContain('agentName={agentName}');
    expect(element).not.toMatch(FRESHLY_BUILT);
  });

  it('would catch an identity object written inline', () => {
    // The same predicate against the thing it exists to reject.
    const broken = source.replace(
      'agentName={agentName}',
      'agentIdentity={{ name: agentName, color: agentColor }}',
    );

    expect(chatHeaderElement(broken)).toMatch(FRESHLY_BUILT);
  });
});

/**
 * Where the title sits.
 *
 * The header is three columns, and the title is centred in the HEADER — rather
 * than in whatever the flanking groups leave over — if and only if the two side
 * columns are the same width. So that equality is what is pinned here, read off
 * the columns themselves rather than hardcoded: change one side's width and the
 * two stop matching, whatever they were changed to.
 *
 * Measured in Chromium over the real `react-native-web` layout engine, with the
 * component's own sizes (36px controls, 8px gaps, 16px padding): before this,
 * the title sat 83.5px left of centre on a 1280px screen and 65.5px left on a
 * 375px one — adrift, and adrift by DIFFERENT amounts, because the menu button
 * on the left is `md:hidden` and so weighs nothing on a desktop. With equal side
 * columns the same measurement reports an offset of exactly 0.
 */
describe('the chat header, as three columns', () => {
  /** The classes that decide how wide a column gets. */
  function widthClasses(node: ReactTestInstance): string[] {
    const className: unknown = node.props.className;
    if (typeof className !== 'string') return [];
    return className
      .split(/\s+/)
      .filter((name) => /(^|:)(flex-1|grow|basis-|w-|min-w-|max-w-)/.test(name))
      .sort();
  }

  /**
   * The header's own columns — its direct children, not everything nested.
   *
   * The outermost host `View` is the header itself; its immediate children are
   * the three column elements, which carry the classes that size them.
   */
  function columns(r: ReactTestRenderer): ReactTestInstance[] {
    const header = nodes(r, 'View')[0];
    return header.children.filter(
      (child): child is ReactTestInstance =>
        typeof child !== 'string' && typeof child.props.className === 'string',
    );
  }

  it('gives the two flanking columns the same width, which is what centres the title', () => {
    const r = render(<ChatHeader agentName="Pepe" agentColor="#7c3aed" />);
    const [left, centre, right] = columns(r);

    expect(columns(r)).toHaveLength(3);
    // Positive control on the reader itself: two columns with no width classes
    // at all would compare equal and pin nothing, which is exactly the state
    // this replaced.
    expect(widthClasses(left)).not.toHaveLength(0);
    expect(widthClasses(left)).toEqual(widthClasses(right));
    // And the middle one is the one that takes the slack.
    expect(widthClasses(centre)).toContain('flex-1');
  });

  it('lets a long name truncate instead of pushing the controls', () => {
    const r = render(<ChatHeader agentName="Un agente con un nombre larguísimo" />);
    const title = nodes(r, 'Text')[0];

    // Both halves are needed: React Native defaults `flexShrink` to 0, so
    // `numberOfLines` alone clips nothing — the text keeps its full width and
    // runs under the controls, measured at 8px of overlap on a 375px screen.
    expect(title.props.numberOfLines).toBe(1);
    expect(String(title.props.className).split(/\s+/)).toContain('shrink');
  });

  it('leaves the header with no agent flanked exactly as it was', () => {
    const r = render(<ChatHeader />);
    const [left, right] = columns(r);

    // No centre column at all, and the two groups still balance — so nothing
    // moves on the screen everyone uses.
    expect(columns(r)).toHaveLength(2);
    expect(widthClasses(left)).toEqual(widthClasses(right));
  });
});
