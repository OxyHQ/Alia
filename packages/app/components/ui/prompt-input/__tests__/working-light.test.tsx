import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Bloom's `ComposerLoader`, mounted inside Alia's bar.
 *
 * This is the one export of the two composer families Alia can take whole —
 * `active` is a plain boolean with a 450ms fade and no opinion about what it is
 * waiting for — so what has to be pinned is the wiring around it: that it is
 * lit by the real turn and by nothing else, that it never paints over the bar's
 * own surface, and that it never becomes one more ancestor between a finger and
 * a control.
 *
 * The loader itself is a host element here. Not because mounting the real one
 * would be wrong in principle, but because it cannot be done in this suite:
 * `@oxy.so/bloom` publishes extensionless relative ESM under `lib/module/`,
 * which node resolves only through a bundler, and `vitest.config.ts` declares
 * no `server.deps.inline` for it. Every other Bloom import in `packages/app`'s
 * tests is stubbed for the same reason. What the stub keeps is the props, which
 * is the whole contract this file is about.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Text: host('Text'),
    Pressable: host('Pressable'),
    ActivityIndicator: host('ActivityIndicator'),
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    ScrollView: host('ScrollView'),
    Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web },
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    },
  };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const icon = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props);
  return {
    ArrowUp: icon('ArrowUp'),
    Square: icon('Square'),
    Maximize2: icon('Maximize2'),
    Minimize2: icon('Minimize2'),
  };
});

vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/keyboard', async () => {
  const ReactModule = await import('react');
  const host = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement('KeyboardAvoidingView', props, children);
  return { KeyboardAvoidingView: host };
});

vi.mock('@oxy.so/bloom/portal', async () => {
  const ReactModule = await import('react');
  return {
    Portal: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

vi.mock('@oxy.so/bloom/composer-loader', async () => {
  const ReactModule = await import('react');
  return {
    ComposerLoader: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('ComposerLoader', props, children),
  };
});

vi.mock('../textarea', async () => {
  const ReactModule = await import('react');
  return {
    PromptInputTextarea: (props: Record<string, unknown>) =>
      ReactModule.createElement('Textarea', props),
  };
});

vi.mock('../add-menu', async () => {
  const ReactModule = await import('react');
  return {
    PromptInputAddMenu: (props: Record<string, unknown>) =>
      ReactModule.createElement('AddMenu', props),
  };
});

vi.mock('../mic-button', async () => {
  const ReactModule = await import('react');
  return {
    PromptInputMicButton: (props: Record<string, unknown>) =>
      ReactModule.createElement('Mic', props),
  };
});

vi.mock('../dictation-bar', async () => {
  const ReactModule = await import('react');
  return {
    PromptInputDictationBar: (props: Record<string, unknown>) =>
      ReactModule.createElement('DictationBar', props),
  };
});

vi.mock('../autocomplete', async () => {
  const ReactModule = await import('react');
  return {
    PromptInputAutocomplete: (props: Record<string, unknown>) =>
      ReactModule.createElement('Autocomplete', props),
  };
});

vi.mock('../attachments', async () => {
  const ReactModule = await import('react');
  return { PromptInputAttachments: () => ReactModule.createElement('Attachments', null) };
});

vi.mock('@/components/model-selector', async () => {
  const ReactModule = await import('react');
  return {
    ModelSelector: (props: Record<string, unknown>) =>
      ReactModule.createElement('ModelSelector', props),
  };
});

vi.mock('@/components/effort-selector', async () => {
  const ReactModule = await import('react');
  return {
    EffortSelector: (props: Record<string, unknown>) =>
      ReactModule.createElement('EffortSelector', props),
  };
});

/** Swapped per test, so the recorder can be made to be listening. */
const stt = {
  isRecording: false,
  isTranscribing: false,
  error: null as string | null,
  startRecording: () => {},
  stopAndTranscribe: async () => null,
  cancel: () => {},
};

vi.mock('@/lib/hooks/use-speech-to-text', () => ({ useSpeechToText: () => stt }));

vi.mock('@/lib/hooks/use-is-large-screen', () => ({ useIsLargeScreen: () => true }));

import { PromptInput } from '../prompt-input';
import { COMPOSER_RADIUS } from '../context';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function render(element: React.ReactElement) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(element);
  });
  if (next === undefined) throw new Error('PromptInput did not render');
  renderer = next;
  return next;
}

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  stt.isRecording = false;
  stt.isTranscribing = false;
});

/** Host nodes by name — `name` is typed as `string` so `type` stays wide. */
function nodes(r: ReactTestRenderer, name: string): ReactTestInstance[] {
  return r.root.findAll((node) => node.type === name);
}

/** Widened to `string` so a `node.type` comparison is not narrowed to a literal. */
const LOADER: string = 'ComposerLoader';

function loaders(r: ReactTestRenderer): ReactTestInstance[] {
  return nodes(r, LOADER);
}

/** Every host ancestor of a node, nearest first. */
function hostAncestors(node: ReactTestInstance): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  for (let cursor = node.parent; cursor !== null; cursor = cursor.parent) {
    if (typeof cursor.type === 'string') out.push(cursor);
  }
  return out;
}

const chatComposer = (over: Record<string, unknown> = {}) => (
  <PromptInput
    value=""
    onValueChange={() => {}}
    onSubmit={() => {}}
    selectedModel="mode:auto"
    onModelChange={() => {}}
    onStop={() => {}}
    disableKeyboardAvoidance
    {...over}
  />
);

describe('the composer’s working light', () => {
  it('lights while a turn is in flight', () => {
    const r = render(chatComposer({ isLoading: true }));
    const band = loaders(r);

    expect(band).toHaveLength(1);
    expect(band[0].props.active).toBe(true);
  });

  it('stays mounted and unlit when idle, so the 450ms fade has something to animate', () => {
    const band = loaders(render(chatComposer()));

    expect(band).toHaveLength(1);
    expect(band[0].props.active).toBe(false);
  });

  it('leaves the bar’s own paint alone', () => {
    // `surface` defaults to TRUE in Bloom: the loader would paint
    // `theme.colors.card` under Bloom's `BUTTON_SHADOW` and replace the bar's
    // tuned three-part shadow for the length of every stream.
    const band = loaders(render(chatComposer({ isLoading: true })))[0];

    expect(band.props.surface).toBe(false);
    // And it traces the corner the bar actually wears, not Bloom's full pill.
    expect(band.props.radius).toBe(COMPOSER_RADIUS);
  });

  it('goes dark while the recorder is listening', () => {
    stt.isRecording = true;
    const band = loaders(render(chatComposer({ isLoading: true })));

    expect(band).toHaveLength(1);
    expect(band[0].props.active).toBe(false);
  });

  it('is never mounted by an input that has no stream to wait for', () => {
    // No `selectedModel`/`onModelChange`, so this is the generic prompt input:
    // no `onStop`, and an `isLoading` nothing will ever set.
    const r = render(
      <PromptInput value="" onValueChange={() => {}} onSubmit={() => {}} disableKeyboardAvoidance />,
    );

    expect(loaders(r)).toHaveLength(0);
  });

  it('is a layer, not a control: it takes no touch and says nothing', () => {
    const band = loaders(render(chatComposer({ isLoading: true })))[0];
    const wrapper = hostAncestors(band)[0];

    expect(wrapper.props.pointerEvents).toBe('none');
    // A screen reader is already told a turn is in flight twice — the send
    // button became "Stop generating" and the textbox reports itself
    // uneditable. A third announcement is noise.
    expect(wrapper.props.accessibilityElementsHidden).toBe(true);
    expect(wrapper.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('lies under the composer’s own controls rather than over them', () => {
    // It is the bar's FIRST child. A child draws above its parent's background
    // and below its later siblings, so this position — and only this one — puts
    // the band on the surface while the draft stays over the top of it.
    const r = render(chatComposer({ isLoading: true }));
    const band = loaders(r)[0];
    const bar = hostAncestors(band)[1];
    const send = r.root.findAll(
      (node) => typeof node.type === 'string' && node.props.accessibilityLabel === 'composer.stop',
    )[0];

    expect(bar.props.id).toMatch(/-bar$/);
    const order = bar.children.filter(
      (child): child is ReactTestInstance => typeof child !== 'string',
    );
    expect(order[0].findAll((node) => node.type === LOADER)).toHaveLength(1);
    // And the stop button is NOT inside the light — it is a later sibling's
    // descendant, which is what keeps it pressable. Compared by node TYPE
    // rather than by instance identity: react-test-renderer hands back a fresh
    // wrapper on each traversal, so an identity check here would pass whether
    // or not the button were buried under the band.
    expect(hostAncestors(send).map((node) => node.type)).not.toContain(LOADER);
  });
});
