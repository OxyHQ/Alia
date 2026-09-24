import React from 'react';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Searching a thread, and what a result carries.
 *
 * The load-bearing part is not that hits are drawn: it is that pressing one
 * hands back the CURSOR. An id names a message and only a cursor names a
 * position, so a result list built on ids is one nothing can jump from — and
 * it looks identical on screen.
 */

const state = vi.hoisted(() => ({
  /** What the hook was asked, so "an empty field asks nothing" is assertable. */
  askedWith: [] as string[],
  hits: [] as Record<string, unknown>[],
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
  };
});

vi.mock('@oxy.so/bloom/icons/RiCloseLine', () => ({ RiCloseLine: () => null }));

vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Muted: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@oxy.so/bloom/search', async () => {
  const ReactModule = await import('react');
  return {
    Search: (props: Record<string, unknown>) =>
      ReactModule.createElement('Input', props),
  };
});

/** Bloom's row, as a pressable with its two lines as text. */
vi.mock('@oxy.so/bloom/item', async () => {
  const ReactModule = await import('react');
  return {
    Item: ({
      title,
      subtitle,
      ...props
    }: { title?: React.ReactNode; subtitle?: React.ReactNode } & Record<string, unknown>) =>
      ReactModule.createElement(
        'Pressable',
        props,
        ReactModule.createElement('Text', null, title),
        ReactModule.createElement('Text', null, subtitle),
      ),
  };
});

vi.mock('@oxy.so/bloom/card', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement(name, null, children);
  return { Card: host('Card'), CardBody: host('CardBody') };
});

vi.mock('@oxy.so/bloom/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Button', props, children),
  };
});

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));

vi.mock('@/lib/hooks/use-thread-search', () => ({
  useThreadSearch: (_handle: string, query: string) => {
    state.askedWith.push(query);
    return {
      data: query.trim() === '' ? undefined : state.hits,
      isFetching: false,
      isError: false,
    };
  },
}));

const { ThreadSearch } = await import('../thread-search');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function render(element: React.ReactElement) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(element);
  });
  if (next === undefined) throw new Error('ThreadSearch did not render');
  renderer = next;
  return next;
}

/**
 * `name` is a plain string on purpose: comparing `node.type` against a literal
 * narrows to `ElementType` and TypeScript calls the whole comparison
 * unintentional. Same shape as the header suite next door.
 */
function nodes(r: ReactTestRenderer, name: string): ReactTestInstance[] {
  return r.root.findAll((node) => node.type === name);
}

function type(r: ReactTestRenderer, text: string) {
  act(() => nodes(r, 'Input')[0].props.onChangeText(text));
}

function texts(r: ReactTestRenderer): unknown[] {
  return nodes(r, 'Text').map((node) => node.props.children);
}

function results(r: ReactTestRenderer): ReactTestInstance[] {
  return nodes(r, 'Pressable');
}

const HIT = {
  messageId: 'm-12',
  conversationId: 'conv_first',
  role: 'user' as const,
  snippet: 'the migration is what we said we would do',
  createdAt: '2026-03-04T10:00:00.000Z',
  cursor: 'cursor-12',
};

/** A message the SERVER wrote: no client id, and `null` is not a key. */
const SERVER_HIT = {
  ...HIT,
  messageId: null,
  role: 'assistant' as const,
  cursor: 'cursor-13',
};

beforeEach(() => {
  state.askedWith = [];
  state.hits = [HIT, SERVER_HIT];
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('searching a thread', () => {
  it('asks nothing until something is typed', () => {
    // An empty field is an invitation, not a search that found nothing — and
    // "everything" is not a result.
    const r = render(
      <ThreadSearch handle="pepe" onJump={vi.fn()} onClose={vi.fn()} />,
    );

    expect(state.askedWith).toEqual(['']);
    expect(texts(r)).toContain('chat.searchThreadHint');
    expect(results(r)).toHaveLength(0);
  });

  it('draws a row per hit once there is a query', () => {
    const r = render(
      <ThreadSearch handle="pepe" onJump={vi.fn()} onClose={vi.fn()} />,
    );
    type(r, 'migration');

    expect(state.askedWith).toContain('migration');
    expect(results(r)).toHaveLength(2);
    expect(texts(r)).toContain(HIT.snippet);
  });

  it('hands back the whole hit, cursor included, which is what can be jumped to', () => {
    const onJump = vi.fn();
    const r = render(
      <ThreadSearch handle="pepe" onJump={onJump} onClose={vi.fn()} />,
    );
    type(r, 'migration');
    act(() => results(r)[0].props.onPress());

    expect(onJump).toHaveBeenCalledWith(HIT);
    // Named, because this is the field the window is asked for and the one an
    // id-shaped result would be missing.
    expect(onJump.mock.calls[0][0].cursor).toBe('cursor-12');
  });

  it('draws a hit the server wrote, which has no client id at all', () => {
    // `messageId` is null on anything the server wrote, and half a thread is
    // written by the server. A row that leans on it — to key, to jump — has
    // nothing to lean on for those.
    const onJump = vi.fn();
    const r = render(
      <ThreadSearch handle="pepe" onJump={onJump} onClose={vi.fn()} />,
    );
    type(r, 'migration');
    act(() => results(r)[1].props.onPress());

    expect(results(r)).toHaveLength(2);
    expect(onJump).toHaveBeenCalledWith(SERVER_HIT);
  });

  it('says a search found nothing, which is not the same as not having searched', () => {
    state.hits = [];
    const r = render(
      <ThreadSearch handle="pepe" onJump={vi.fn()} onClose={vi.fn()} />,
    );
    type(r, 'nothing like this was ever said');

    expect(texts(r)).toContain('chat.searchThreadEmpty');
    expect(texts(r)).not.toContain('chat.searchThreadHint');
  });
});
