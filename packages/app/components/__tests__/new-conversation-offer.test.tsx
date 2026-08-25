import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The offer to start the next stretch, and the one thing it must never do.
 *
 * The agent's tool writes NOTHING — it emits a single frame — so a suggestion
 * nobody acts on has to leave the thread exactly as it was. That is the whole
 * safety property: the model can propose a cut and is structurally incapable of
 * making one, and this half must not quietly supply the capability the other
 * half withheld.
 *
 * So the load-bearing case here is the boring one: ignoring the card creates no
 * conversation. Its positive control is the accept path, which must create
 * exactly one — without that, "created nothing" would also be satisfied by a
 * button wired to nothing at all.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View'), Pressable: host('Pressable') };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { NewConversationOffer } from '../new-conversation-offer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function render(props: React.ComponentProps<typeof NewConversationOffer>) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(<NewConversationOffer {...props} />);
  });
  if (next === undefined) throw new Error('the offer did not render');
  renderer = next;
  return next.root;
}

/**
 * Host elements by name. `findAllByType` is typed for components, so a string
 * LITERAL compared against `TestInstance['type']` does not typecheck while a
 * string variable does — same reason as `show-artwork.test.tsx`.
 */
function hosts(root: ReturnType<typeof render>, name: string) {
  return root.findAll((node) => node.type === name);
}

/** The two buttons, in the order they are offered. */
function buttons(root: ReturnType<typeof render>) {
  return hosts(root, 'Pressable');
}

function texts(root: ReturnType<typeof render>) {
  return hosts(root, 'Text')
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('the offer to start a new conversation', () => {
  it('creates nothing when it is ignored', () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();

    render({ reason: 'we have moved to the billing bug', onAccept, onDismiss });
    // Rendered, read, and left alone — which is what most of them will be.

    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('creates nothing when it is dismissed either', () => {
    const onAccept = vi.fn();
    const onDismiss = vi.fn();

    const root = render({ reason: 'we have moved on', onAccept, onDismiss });
    act(() => buttons(root)[1]?.props.onPress());

    expect(onAccept).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('starts exactly one when it is accepted', () => {
    // The control on both cases above: they would also pass if the buttons were
    // wired to nothing.
    const onAccept = vi.fn();
    const onDismiss = vi.fn();

    const root = render({ reason: 'we have moved on', onAccept, onDismiss });
    act(() => buttons(root)[0]?.props.onPress());

    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("shows the model's own sentence, unaltered", () => {
    // Not translated and not rewritten: it is the agent's reasoning, and a
    // substitute of ours would read as theirs.
    const reason = 'we have moved from the migration to the billing bug';

    expect(texts(render({ reason, onAccept: vi.fn(), onDismiss: vi.fn() }))).toContain(reason);
  });

  it('drops the line rather than inventing one when no reason came', () => {
    const shown = texts(render({ reason: '', onAccept: vi.fn(), onDismiss: vi.fn() }));

    // The offer and its two answers, and nothing standing in for the reason.
    expect(shown).toEqual([
      'chat.newConversationOffer',
      'chat.newConversationAccept',
      'chat.newConversationDismiss',
    ]);
  });
});
