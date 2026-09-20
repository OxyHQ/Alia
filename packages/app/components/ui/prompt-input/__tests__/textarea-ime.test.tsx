import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Enter, while an input method is mid-word.
 *
 * ## What it used to do
 *
 * `components/ui/chat-text-input.tsx` decides Enter with one question — is
 * Shift down? — and sends on every Enter that is not shifted. That is the right
 * question for a Latin keyboard and the wrong one for Japanese, Chinese or
 * Korean input, where the first Enter after typing ACCEPTS the candidate the
 * IME is offering. Under that rule the half-written message went out, and the
 * word being confirmed landed in the empty composer behind it. Nothing in the
 * repo asked the second question: a grep for `isComposing` found no hit outside
 * `node_modules`.
 *
 * ## Why the rule is Bloom's
 *
 * Both of Bloom's composers already ask it —
 * `composer-panel/ComposerPanelBase.tsx`:
 *
 *     if (!IS_WEB || native.key !== 'Enter' || native.shiftKey || native.isComposing) return;
 *
 * Alia cannot adopt either component (neither declares `onStop`, and the pill
 * keys models by display name), but the behaviour under them is a published
 * contract and this is the part of it that fits.
 *
 * `ChatTextInput` is a host element here: it is shared with inputs that have no
 * composer semantics, it is outside this change, and what is under test is the
 * seam — that the composer refuses the submit its neighbour is about to ask for
 * when the event that triggered it was the IME's.
 */

const platform = { OS: 'web' as string };

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    StyleSheet: { create: <T,>(styles: T) => styles },
    get Platform() {
      return platform;
    },
  };
});

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** `cn` reaches `expo-crypto` through `random-uuid`; this field never calls it. */
vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));

vi.mock('../../chat-text-input', async () => {
  const ReactModule = await import('react');
  return {
    ChatTextInput: (props: Record<string, unknown>) =>
      ReactModule.createElement('ChatTextInput', props),
  };
});

import { PromptInputTextarea } from '../textarea';
import { PromptInputContext, type PromptInputContextType } from '../context';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  platform.OS = 'web';
});

function field(onSubmit: () => void): ReactTestInstance {
  const context = { onSubmit, value: '', setValue: () => {} } as unknown as PromptInputContextType;
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(
      <PromptInputContext.Provider value={context}>
        <PromptInputTextarea />
      </PromptInputContext.Provider>,
    );
  });
  if (next === undefined) throw new Error('the textarea did not render');
  renderer = next;
  // `name` widened to `string` so `node.type` is not narrowed to a literal.
  const name: string = 'ChatTextInput';
  return next.root.findAll((node) => node.type === name)[0];
}

/**
 * One Enter, as `ChatTextInput` delivers it: the key event first, then — in the
 * SAME tick, from the same event — the submit it decided on. The order is the
 * point; a flag written in the first call and read one render later would
 * always be one Enter behind.
 */
function pressEnter(input: ReactTestInstance, isComposing: boolean) {
  act(() => {
    input.props.onKeyPress({ nativeEvent: { key: 'Enter', isComposing } });
    input.props.onEnterPress();
  });
}

describe('Enter in the composer', () => {
  it('sends when the person is simply typing', () => {
    const onSubmit = vi.fn();
    pressEnter(field(onSubmit), false);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not send the Enter that confirms an IME candidate', () => {
    const onSubmit = vi.fn();
    pressEnter(field(onSubmit), true);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends the very next Enter, once the word is committed', () => {
    // The veto is per event, not a latch. Composing once must not disarm the
    // key for the rest of the sentence.
    const onSubmit = vi.fn();
    const input = field(onSubmit);

    pressEnter(input, true);
    pressEnter(input, false);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('guards the native submit path by the same answer', () => {
    // `onSubmitEditing` is the native counterpart and must not be a second,
    // unguarded way into the same send.
    const onSubmit = vi.fn();
    const input = field(onSubmit);

    act(() => {
      input.props.onKeyPress({ nativeEvent: { key: 'Enter', isComposing: true } });
      input.props.onSubmitEditing();
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('asks nothing of native, which reports no composition at all', () => {
    // `isComposing` is a DOM `KeyboardEvent` field. Off native it is always
    // undefined, and a guard that trusted it would be reading noise.
    platform.OS = 'ios';
    const onSubmit = vi.fn();
    pressEnter(field(onSubmit), true);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('names the field in the reader’s language rather than in English', () => {
    // `ChatTextInput` hard-codes "Message input" for every input that uses it.
    const input = field(() => {});

    expect(input.props.accessibilityLabel).toBe('composer.message');
  });
});
