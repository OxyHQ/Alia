import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A conversation still streaming shows a spinner, and WHERE it shows is the
 * claim: at the trailing edge of the row, after the title. It used to render
 * before the title, which pushed the whole line right the moment a chat
 * started and pulled it back when the answer finished — the one row in the
 * sidebar whose text did not line up with the others.
 *
 * Order is asserted by index within the row's own children, not by a snapshot:
 * a snapshot would go red for any styling change and would not say which of
 * the two is first.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Pressable: host('Pressable'),
    ActivityIndicator: (props: Record<string, unknown>) =>
      ReactModule.createElement('ActivityIndicator', props),
  };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

/**
 * `cn` (via `lib/utils.ts`) reaches `expo-crypto` through `random-uuid`, whose
 * native module does not exist under vitest. The row makes no use of it.
 */
vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));

vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: 'rgb(113 113 122)' } }),
}));

/**
 * The row's trailing menu is a surface of its own (Bloom's dropdown, a portal,
 * its own hover rules). This file makes no claim about it, and rendering the
 * real one would drag that whole tree in to assert an index.
 */
vi.mock('../conversation-menu', async () => {
  const ReactModule = await import('react');
  return { ConversationMenu: () => ReactModule.createElement('ConversationMenu') };
});

/** The one piece of store state the row reads: which chat is streaming. */
let streamingChatId: string | null = null;
vi.mock('@/lib/stores/global-store', () => ({
  useStore: (selector: (state: { streamingChatId: string | null }) => unknown) =>
    selector({ streamingChatId }),
}));

import { ConversationItem } from '../conversation-item';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HOST_TEXT: string = 'Text';
const HOST_SPINNER: string = 'ActivityIndicator';
const CONVERSATION_ID = 'conv-1';

let renderer: ReactTestRenderer | null = null;

function render() {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(
      <ConversationItem
        conversation={{ id: CONVERSATION_ID, title: 'A conversation' } as never}
        isActive={false}
        isFavorite={false}
        isPinned={false}
        projects={[]}
        folders={[]}
        onSelect={vi.fn()}
        onToggleFavorite={vi.fn()}
        onTogglePin={vi.fn()}
        onMoveToProject={vi.fn()}
        onMoveToFolder={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
  });
  if (!next) throw new Error('render produced no tree');
  renderer = next;
  return next;
}

/** Position of the first node of `type` in a depth-first walk of the tree. */
function orderOf(tree: ReactTestRenderer, type: string): number {
  const flat = tree.root.findAll(() => true, { deep: true });
  return flat.findIndex((node) => node.type === type);
}

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
  streamingChatId = null;
});

describe('ConversationItem', () => {
  it('puts the streaming spinner after the title, not before it', () => {
    streamingChatId = CONVERSATION_ID;
    const tree = render();

    const title = orderOf(tree, HOST_TEXT);
    const spinner = orderOf(tree, HOST_SPINNER);

    expect(title).toBeGreaterThanOrEqual(0);
    expect(spinner).toBeGreaterThan(title);
  });

  it('shows no spinner when another conversation is the one streaming', () => {
    streamingChatId = 'some-other-conversation';
    const tree = render();

    expect(orderOf(tree, HOST_SPINNER)).toBe(-1);
    expect(orderOf(tree, HOST_TEXT)).toBeGreaterThanOrEqual(0);
  });
});
