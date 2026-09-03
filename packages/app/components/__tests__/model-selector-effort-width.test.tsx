import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * How wide the composer's power button is, open and shut.
 *
 * Two rules that have to hold at once: shut it is as wide as its own label —
 * capped, so one long name cannot widen it indefinitely — and open it is exactly
 * as wide as the panel it opens, so the two share both edges. `align="end"`
 * already puts their right edges together; the width is what brings the left
 * ones.
 *
 * Measured in Chromium against the composer's real grid
 * (`grid-cols-[auto_minmax(0,1fr)_auto]`): shut, the button is 68.5px for "Low",
 * 90.1px for "Default" and 110.5px for "Extra High"; a label far too long stops
 * at exactly 160px and ellipses. Open it is 224px against a 224px panel, with
 * both edges 0.0px apart.
 */

const mocks = vi.hoisted(() => ({
  onOpenChange: null as ((open: boolean) => void) | null,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Pressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Pressable', props, children),
  };
});

/**
 * The menu keeps its own open state in the real Bloom component; the stand-in
 * hands the setter out so a test can open the thing the way a click would.
 */
vi.mock('@oxyhq/bloom/dropdown-menu', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    DropdownMenu: ({
      children,
      onOpenChange,
      ...props
    }: React.PropsWithChildren<{ onOpenChange?: (open: boolean) => void }>) => {
      mocks.onOpenChange = onOpenChange ?? null;
      return ReactModule.createElement('DropdownMenu', props, children);
    },
    DropdownMenuTrigger: host('DropdownMenuTrigger'),
    DropdownMenuContent: host('DropdownMenuContent'),
    DropdownMenuRadioGroup: host('DropdownMenuRadioGroup'),
    DropdownMenuRadioItem: host('DropdownMenuRadioItem'),
    DropdownMenuSub: host('DropdownMenuSub'),
    DropdownMenuSubContent: host('DropdownMenuSubContent'),
    DropdownMenuSubTrigger: host('DropdownMenuSubTrigger'),
  };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@/components/ui/prompt-input/composer-glyph', async () => {
  const ReactModule = await import('react');
  return {
    ComposerGlyph: (props: Record<string, unknown>) =>
      ReactModule.createElement('ComposerGlyph', props),
  };
});

vi.mock('@/components/local-models-invite', async () => {
  const ReactModule = await import('react');
  return {
    LocalModelsInvite: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: 'rgb(120, 120, 120)' } }),
}));

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Stubbed outright rather than partly: the real module reaches the native
// runtime on import, which has nothing to do with how wide a button is.
vi.mock('@/lib/hooks/use-catalogue', () => ({
  AUTOMATIC_SELECTION_ID: 'auto',
  EFFORT_LEVELS: ['instant', 'medium', 'high', 'max'],
  useCatalogue: () => ({ data: [] }),
  resolveSelection: () => ({ entry: undefined, requestedId: 'test/model' }),
}));

vi.mock('@/lib/hooks/use-local-runtimes', () => ({
  useLocalModelOptions: () => ({ options: [], ids: [] }),
}));

vi.mock('@/lib/hooks/use-product-modes', () => ({
  useProductModes: () => ({ data: undefined }),
  modeById: (id: string, modes: readonly { id: string }[] | undefined) =>
    modes?.find((mode) => mode.id === id) ?? null,
  presentation: () => ({}),
}));

vi.mock('@/lib/stores/model-store', () => ({
  effortFor: () => null,
  useModelStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ reasoningEffort: null, setReasoningEffort: () => {} }),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => {} }) }));

// `@/lib/utils` owns `cn`, and also a UUID helper that pulls the Expo native
// module in on import. The leaf is stubbed rather than `cn` itself, which the
// component genuinely uses to build the classes under test.
vi.mock('expo-crypto', () => ({
  getRandomValues: (array: Uint8Array) => array,
}));
vi.mock('@oxyhq/bloom/toast', () => ({ toast: { info: () => {}, error: () => {} } }));

import { ModelSelector, PICKER_WIDTH } from '../model-selector.web';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function render() {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(<ModelSelector selectedModel="test/model" onModelChange={() => {}} />);
  });
  if (next === undefined) throw new Error('the model selector did not render');
  renderer = next;
  return next;
}

/** Every host node of a given name, in render order. */
function hosts(r: ReactTestRenderer, name: string): ReactTestInstance[] {
  return r.root.findAll((node) => node.type === name);
}

/** The power button: the one Pressable the menu is hung off. */
function trigger(r: ReactTestRenderer): ReactTestInstance {
  return hosts(r, 'Pressable')[0];
}

function classes(node: ReactTestInstance): string[] {
  const className: unknown = node.props.className;
  return typeof className === 'string' ? className.split(/\s+/) : [];
}

function open(value: boolean) {
  act(() => mocks.onOpenChange?.(value));
}

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  mocks.onOpenChange = null;
});

describe('the power button, shut', () => {
  it('is as wide as its label, up to a ceiling', () => {
    const r = render();

    // No width of its own, so it takes its label's — but `max-w-40` stops one
    // long name widening it until the composer's text has nowhere to go.
    expect(trigger(r).props.style).toBeUndefined();
    expect(classes(trigger(r))).toContain('max-w-40');
  });

  it('truncates the label rather than letting it push', () => {
    const r = render();
    const label = hosts(r, 'Text')[0];

    // Both halves. React Native leaves `flexShrink` at 0, so `numberOfLines`
    // alone has no bounded box to clip against and the text pushes instead.
    expect(label.props.numberOfLines).toBe(1);
    expect(String(label.props.className).split(/\s+/)).toContain('shrink');
  });
});

describe('the power button, open', () => {
  it('takes the panel’s width, so the two line up on both edges', () => {
    const r = render();
    open(true);

    expect(trigger(r).props.style).toEqual({ width: PICKER_WIDTH });
    // The ceiling would fight the width it just took.
    expect(classes(trigger(r))).not.toContain('max-w-40');
  });

  it('goes back to fitting its label when it shuts', () => {
    const r = render();
    open(true);
    open(false);

    expect(trigger(r).props.style).toBeUndefined();
    expect(classes(trigger(r))).toContain('max-w-40');
  });
});

describe('the width itself', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../model-selector.web.tsx', import.meta.url)),
    'utf8',
  );

  /**
   * The trigger takes its open width from a number and the panel names its own
   * in a class, and nothing makes those agree — so the class is read back. This
   * is the whole of "the width is written in one place": change either and this
   * says so.
   */
  it('is one number, and the panel wears the same one', () => {
    const panel = source.match(/w-\[(\d+)px\]\s+min-w-\[(\d+)px\]/);

    // Positive control on the reader: a miss would leave `panel` null and every
    // assertion below it vacuous.
    expect(panel).not.toBeNull();
    expect(Number(panel?.[1])).toBe(PICKER_WIDTH);
    expect(Number(panel?.[2])).toBe(PICKER_WIDTH);
  });

  it('is no longer a fixed size the label cannot change', () => {
    // What this replaced: a hardcoded trigger width, which is what made the
    // button ignore its own label.
    expect(source).not.toContain('w-[171px]');
  });
});
