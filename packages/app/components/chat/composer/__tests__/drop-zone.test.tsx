import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dropping files on the composer.
 *
 * The gesture is stateful and the browser reports it per ELEMENT, so the two
 * things worth pinning are the two things that go wrong in every hand-written
 * drop zone: the affordance strobing as the pointer crosses the bar's own
 * children, and `drop` never firing because only `dragenter` was defaulted
 * away. Both are checked against a stand-in element rather than a real one,
 * because neither depends on anything a browser would contribute.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Platform: { OS: 'web' },
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
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

import { ComposerDropOverlay, useComposerDropTarget } from '../drop-zone';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Listener = (event: unknown) => void;

let listeners: Map<string, Set<Listener>>;
let renderer: ReactTestRenderer | null = null;
let isOver = false;
let dropped: File[][] = [];

const element = {
  addEventListener: (type: string, listener: Listener) => {
    const set = listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(type, set);
  },
  removeEventListener: (type: string, listener: Listener) => {
    listeners.get(type)?.delete(listener);
  },
};

/** One drag event, delivered to whatever the hook attached. */
function fire(
  type: string,
  options: { types?: string[]; files?: File[] } = {},
): { preventDefault: ReturnType<typeof vi.fn>; dropEffect: string } {
  const event = {
    preventDefault: vi.fn(),
    dataTransfer: {
      types: options.types ?? ['Files'],
      files: options.files ?? [],
      dropEffect: '',
    },
  };
  act(() => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  });
  return {
    preventDefault: event.preventDefault,
    dropEffect: event.dataTransfer.dropEffect,
  };
}

/**
 * Host nodes by tag name.
 *
 * The comparison goes through a `string` parameter rather than a literal
 * because `node.type` is typed as `ElementType`, and TypeScript rejects
 * `=== 'View'` against it outright — the mock is a host element at runtime and
 * a react-native component to the compiler.
 */
function nodes(tree: ReactTestRenderer, name: string) {
  return tree.root.findAll((node) => node.type === name);
}

function Probe({ enabled }: { enabled: boolean }) {
  isOver = useComposerDropTarget({
    elementId: 'composer-bar',
    enabled,
    onFiles: (files) => dropped.push(files),
  });
  return null;
}

function mount(enabled = true) {
  act(() => {
    renderer = create(<Probe enabled={enabled} />);
  });
}

beforeEach(() => {
  listeners = new Map();
  dropped = [];
  isOver = false;
  vi.stubGlobal('document', { getElementById: () => element });
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.unstubAllGlobals();
});

describe('the drop affordance', () => {
  it('survives the pointer crossing the composer’s own children', () => {
    mount();

    fire('dragenter'); // onto the bar
    expect(isOver).toBe(true);

    fire('dragenter'); // onto the textarea inside it
    fire('dragleave'); // and off the bar, which fires AFTER the child's enter

    // The naive boolean is off by here, and the dashed outline has flickered
    // out from under a drag that never left the composer.
    expect(isOver).toBe(true);

    fire('dragleave');
    expect(isOver).toBe(false);
  });

  it('clears on drop, which sends no dragleave of its own', () => {
    mount();
    fire('dragenter');

    fire('drop', { files: [{ name: 'a.png' } as File] });

    expect(isOver).toBe(false);
  });

  it('ignores a drag that is carrying text rather than files', () => {
    mount();

    const enter = fire('dragenter', { types: ['text/plain'] });

    // Otherwise the composer lights up when a word is dragged across it — and
    // then swallows the drop, because it defaulted the browser away from a
    // gesture it had no intention of handling.
    expect(isOver).toBe(false);
    expect(enter.preventDefault).not.toHaveBeenCalled();
  });
});

describe('the drop itself', () => {
  it('cancels the browser’s default on dragover as well as on drop', () => {
    mount();

    const over = fire('dragover');

    // Without `preventDefault` on dragOVER the element is not a drop target at
    // all and `drop` never fires — the single most common way a hand-written
    // drop zone looks finished and does nothing.
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dropEffect).toBe('copy');
  });

  it('hands the dropped files over', () => {
    mount();
    const files = [{ name: 'a.png' } as File, { name: 'b.pdf' } as File];

    fire('drop', { files });

    expect(dropped).toEqual([files]);
  });

  it('takes nothing while the composer is shut, and still saves the page', () => {
    mount(false);

    const drop = fire('drop', { files: [{ name: 'a.png' } as File] });
    const over = fire('dragover');

    expect(dropped).toEqual([]);
    // The default has to be cancelled anyway. Alia had no drop handling at
    // all, which on web means the browser NAVIGATED THE TAB to the dropped
    // file — losing the draft, the scroll position and any stream in flight.
    // A composer that is merely closed must not be a way back to that.
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(over.dropEffect).toBe('none');
  });

  it('stops listening when the composer goes away', () => {
    mount();
    act(() => renderer?.unmount());
    renderer = null;

    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
});

describe('the overlay', () => {
  it('draws nothing at all until a drag is over the bar', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = create(<ComposerDropOverlay visible={false} enabled />);
    });
    expect(tree?.toJSON()).toBeNull();
    act(() => tree?.unmount());
  });

  it('is announced, and never takes the pointer events it is drawn from', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = create(<ComposerDropOverlay visible enabled />);
    });
    const view = tree === undefined ? undefined : nodes(tree, 'View')[0];

    // `pointerEvents="none"` is load-bearing: an overlay that takes pointer
    // events is an element the drag ENTERS, so it would fire its own
    // enter/leave pair against the very counter it is drawn from.
    expect(view?.props.pointerEvents).toBe('none');
    expect(view?.props.accessibilityRole).toBe('alert');
    act(() => tree?.unmount());
  });

  it('says which of the two situations it is in', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = create(<ComposerDropOverlay visible enabled={false} />);
    });
    const text = tree === undefined ? undefined : nodes(tree, 'Text')[0];

    expect(text?.props.children).toBe('composer.dropUnavailable');
    act(() => tree?.unmount());
  });
});
