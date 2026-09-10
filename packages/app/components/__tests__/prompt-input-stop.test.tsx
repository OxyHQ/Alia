import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Whether "Stop generating" can be pressed while an answer streams — and
 * whether it SAYS it can.
 *
 * The composer used to wrap its whole bar in a `Pressable` that took the same
 * `disabled` the page computed as `isLoading || disabled`. On web that is one
 * `aria-disabled` on the DIV around everything, so for the length of a stream
 * the accessibility tree reported the textbox, the add menu, the model selector
 * AND the stop button as disabled — the one control whose job is to end the
 * stream, announced as unusable for exactly as long as it was needed.
 *
 * So what is pinned here is structural: no ancestor of the stop button carries
 * `disabled`, the stop button itself is enabled and says so, and the lock the
 * stream imposes lands on the editable controls individually.
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
    StyleSheet: { create: <T,>(styles: T) => styles },
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

/** `cn` reaches `expo-crypto` through `random-uuid`; the composer never calls that. */
vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));

vi.mock('@/lib/keyboard', async () => {
  const ReactModule = await import('react');
  const host = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement('KeyboardAvoidingView', props, children);
  return { KeyboardAvoidingView: host };
});

vi.mock('@oxy.so/bloom/portal', async () => {
  const ReactModule = await import('react');
  return {
    Portal: ({ children }: React.PropsWithChildren) => ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

/**
 * The editable controls, each a host element that reports what the context
 * told it. They are stubbed because each one drags in a native module
 * (pickers, the recorder, the catalogue), and what is under test is the
 * disabled state each is HANDED — which the stub makes legible as a prop.
 */
vi.mock('../ui/prompt-input/textarea', async () => {
  const ReactModule = await import('react');
  const { usePromptInput } = await import('../ui/prompt-input/context');
  return {
    PromptInputTextarea: (props: Record<string, unknown>) => {
      const { disabled, isLoading } = usePromptInput();
      return ReactModule.createElement('Textarea', { ...props, editable: !disabled && !isLoading });
    },
  };
});

vi.mock('../ui/prompt-input/add-menu', async () => {
  const ReactModule = await import('react');
  const { usePromptInput } = await import('../ui/prompt-input/context');
  return {
    PromptInputAddMenu: (props: Record<string, unknown>) => {
      const { disabled, isLoading } = usePromptInput();
      return ReactModule.createElement('AddMenu', { ...props, disabled: disabled || isLoading });
    },
  };
});

vi.mock('../ui/prompt-input/mic-button', async () => {
  const ReactModule = await import('react');
  return { PromptInputMicButton: (props: Record<string, unknown>) => ReactModule.createElement('Mic', props) };
});

vi.mock('../ui/prompt-input/dictation-bar', async () => {
  const ReactModule = await import('react');
  return { PromptInputDictationBar: (props: Record<string, unknown>) => ReactModule.createElement('DictationBar', props) };
});

vi.mock('../ui/prompt-input/autocomplete', async () => {
  const ReactModule = await import('react');
  return { PromptInputAutocomplete: (props: Record<string, unknown>) => ReactModule.createElement('Autocomplete', props) };
});

vi.mock('../ui/prompt-input/attachments', async () => {
  const ReactModule = await import('react');
  return { PromptInputAttachments: () => ReactModule.createElement('Attachments', null) };
});

vi.mock('@/components/model-selector', async () => {
  const ReactModule = await import('react');
  return { ModelSelector: (props: Record<string, unknown>) => ReactModule.createElement('ModelSelector', props) };
});

vi.mock('@/components/effort-selector', async () => {
  const ReactModule = await import('react');
  return { EffortSelector: (props: Record<string, unknown>) => ReactModule.createElement('EffortSelector', props) };
});

vi.mock('@/lib/hooks/use-speech-to-text', () => ({
  useSpeechToText: () => ({
    isRecording: false,
    isTranscribing: false,
    error: null,
    startRecording: () => {},
    stopAndTranscribe: async () => null,
    cancel: () => {},
  }),
}));

vi.mock('@/lib/hooks/use-is-large-screen', () => ({ useIsLargeScreen: () => true }));

import { PromptInput } from '../ui/prompt-input/prompt-input';

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
});

/** Host nodes by name — `name` is typed as `string` so `type` stays wide. */
function nodes(r: ReactTestRenderer, name: string): ReactTestInstance[] {
  return r.root.findAll((node) => node.type === name);
}

/** The one control labelled as the stop button. */
function stopButton(r: ReactTestRenderer): ReactTestInstance {
  const found = r.root.findAll(
    (node) => typeof node.type === 'string' && node.props.accessibilityLabel === 'Stop generating',
  );
  if (found.length !== 1) throw new Error(`expected one stop button, found ${found.length}`);
  return found[0];
}

/** Every host ancestor of a node, nearest first. */
function hostAncestors(node: ReactTestInstance): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  for (let cursor = node.parent; cursor !== null; cursor = cursor.parent) {
    if (typeof cursor.type === 'string') out.push(cursor);
  }
  return out;
}

const streaming = (onStop: () => void) => (
  <PromptInput
    value=""
    onValueChange={() => {}}
    onSubmit={() => {}}
    isLoading
    onStop={onStop}
    selectedModel="mode:auto"
    onModelChange={() => {}}
    disableKeyboardAvoidance
  />
);

describe('the composer, while an answer streams', () => {
  it('leaves the stop button outside every disabled ancestor', () => {
    const r = render(streaming(() => {}));
    const stop = stopButton(r);

    // The whole claim: nothing above the stop button is marked disabled. On
    // web every one of these would have become `aria-disabled` on a DIV the
    // stop button lives inside.
    const disabledAncestors = hostAncestors(stop).filter((node) => node.props.disabled === true);
    expect(disabledAncestors).toEqual([]);
  });

  it('exposes the stop button as an enabled button, by name', () => {
    const stop = stopButton(render(streaming(() => {})));

    expect(stop.props.disabled).toBe(false);
    expect(stop.props.accessibilityRole).toBe('button');
    expect(stop.props.accessibilityState).toEqual({ disabled: false });
  });

  it('cancels the stream when pressed', () => {
    const onStop = vi.fn();
    const stop = stopButton(render(streaming(onStop)));

    act(() => stop.props.onPress());

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('locks typing and attaching on the controls themselves, not on the bar', () => {
    const r = render(streaming(() => {}));

    // The textbox and the add menu take the lock individually — that is where
    // a screen reader will report it, against the control it belongs to.
    const textarea = nodes(r, 'Textarea')[0];
    const addMenu = nodes(r, 'AddMenu')[0];
    expect(textarea.props.editable).toBe(false);
    expect(addMenu.props.disabled).toBe(true);

    // And the focus-catcher around the bar is not a control at all.
    const catcher = nodes(r, 'Pressable').filter((node) => node.props.accessible === false);
    expect(catcher).toHaveLength(1);
    expect(catcher[0].props.disabled).toBeUndefined();
  });
});

describe('the composer, closed by the usage limit', () => {
  it('locks the model selector too, but never while merely streaming', () => {
    const closed = render(
      <PromptInput
        value=""
        onValueChange={() => {}}
        disabled
        selectedModel="mode:auto"
        onModelChange={() => {}}
        disableKeyboardAvoidance
      />,
    );
    const selector = nodes(closed, 'ModelSelector')[0];
    const lock = hostAncestors(selector)[0];
    expect(lock.props.pointerEvents).toBe('none');
    expect(lock.props.accessibilityElementsHidden).toBe(true);
    act(() => closed.unmount());
    renderer = null;

    const live = render(streaming(() => {}));
    const streamingSelector = nodes(live, 'ModelSelector')[0];
    expect(hostAncestors(streamingSelector)[0].props.pointerEvents).toBe('auto');
  });
});
