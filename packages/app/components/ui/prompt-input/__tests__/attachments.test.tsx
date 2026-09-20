import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The attachment row: what a tile looks like, and which attachment its button
 * drops.
 *
 * A picture and a file are told apart by SHAPE here rather than by a caption —
 * the picture is a small square showing only itself, the file a wide tile whose
 * name has to be read. So the two are pinned as being different, not merely as
 * each rendering something.
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
    ScrollView: host('ScrollView'),
    ActivityIndicator: host('ActivityIndicator'),
  };
});

vi.mock('expo-image', async () => {
  const ReactModule = await import('react');
  return { Image: (props: Record<string, unknown>) => ReactModule.createElement('Image', props) };
});

vi.mock('expo-linear-gradient', async () => {
  const ReactModule = await import('react');
  return {
    LinearGradient: (props: Record<string, unknown>) =>
      ReactModule.createElement('LinearGradient', props),
  };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const icon = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props);
  return {
    FileText: icon('FileText'),
    FileSpreadsheet: icon('FileSpreadsheet'),
    FileCode: icon('FileCode'),
    FileArchive: icon('FileArchive'),
    FileAudio: icon('FileAudio'),
    File: icon('File'),
    X: icon('X'),
    RotateCw: icon('RotateCw'),
    TriangleAlert: icon('TriangleAlert'),
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
 * Real resolved colours are `rgb(...)` strings, and the real `withAlpha` parses
 * them. The stand-in keeps that shape so a test cannot pass on a value the
 * component would never receive.
 */
vi.mock('@oxy.so/bloom/theme', () => ({
  withAlpha: (color: string, alpha: number) =>
    color.replace(/^rgb\(([^)]+)\)$/, (_m, channels: string) => `rgba(${channels}, ${alpha})`),
}));

/**
 * The strip's labels are localised now, and `@/lib/i18n` reaches
 * `expo-localization` at module load — a native module with nothing behind it
 * here. `t` returns the key plus its parameters so an assertion can still see
 * WHICH attachment a button names, which is the property the remove button has
 * to keep.
 */
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined
        ? key
        : `${key} ${Object.entries(params)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(' ')}`,
  }),
}));

vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({
    colors: {
      surface: 'rgb(255, 255, 255)',
      mutedForeground: 'rgb(120, 120, 120)',
      error: 'rgb(239, 68, 68)',
      success: 'rgb(34, 197, 94)',
      warning: 'rgb(234, 179, 8)',
      info: 'rgb(59, 130, 246)',
      secondary: 'rgb(236, 72, 153)',
      tertiary: 'rgb(139, 92, 246)',
    },
  }),
}));

import { PromptInputAttachments } from '../attachments';
import {
  PromptInputContext,
  COMPOSER_RADIUS,
  ATTACHMENT_ROW_INSET,
  ATTACHMENT_TILE_RADIUS,
  type Attachment,
  type PromptInputContextType,
} from '../context';
import type { IntakeItem } from '../use-attachment-intake';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

const image = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'img',
  uri: 'file:///a.png',
  type: 'image',
  name: 'photo.png',
  size: 1000,
  mimeType: 'image/png',
  ...over,
});

const doc = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'doc',
  uri: 'file:///a.pdf',
  type: 'document',
  name: 'report.pdf',
  size: 2000,
  mimeType: 'application/pdf',
  ...over,
});

function render(attachments: Attachment[]) {
  const removeAttachment = vi.fn();
  const value = { attachments, removeAttachment } as unknown as PromptInputContextType;
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(
      <PromptInputContext.Provider value={value}>
        <PromptInputAttachments />
      </PromptInputContext.Provider>,
    );
  });
  if (next === undefined) throw new Error('the attachment row did not render');
  renderer = next;
  return { r: next, removeAttachment };
}

/**
 * The strip with files still being read in it.
 *
 * A separate helper rather than another argument to `render`, because a
 * pending file is not an attachment: it has no `uri`, it lives in the intake
 * queue and not in the list, and the whole point of the separation is that the
 * two cannot be confused for one another.
 */
function renderPending(items: IntakeItem[], attachments: Attachment[] = []) {
  const cancel = vi.fn();
  const retry = vi.fn();
  const value = {
    attachments,
    removeAttachment: vi.fn(),
    intake: { items, cancel, retry, accept: vi.fn(), dismiss: cancel, isBusy: true },
  } as unknown as PromptInputContextType;
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(
      <PromptInputContext.Provider value={value}>
        <PromptInputAttachments />
      </PromptInputContext.Provider>,
    );
  });
  if (next === undefined) throw new Error('the attachment row did not render');
  renderer = next;
  return { r: next, cancel, retry };
}

const pending = (over: Partial<IntakeItem> = {}): IntakeItem => ({
  id: 'in-1',
  name: 'photo.png',
  size: 4096,
  mimeType: 'image/png',
  kind: 'image',
  status: 'reading',
  fraction: null,
  ...over,
});

function nodes(r: ReactTestRenderer, name: string): ReactTestInstance[] {
  return r.root.findAll((node) => node.type === name);
}

/** Every class on a node, as a list. */
function classes(node: ReactTestInstance): string[] {
  const className: unknown = node.props.className;
  return typeof className === 'string' ? className.split(/\s+/) : [];
}

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('an image tile', () => {
  it('is a small square showing only the picture', () => {
    const { r } = render([image()]);
    const tile = nodes(r, 'View').find((node) => classes(node).includes('h-14'));

    // `h-14 w-14` is 56px square — equal on both axes is the property, and the
    // browser measurement pins the pixels.
    expect(classes(tile as ReactTestInstance)).toContain('w-14');
    expect(nodes(r, 'Image')).toHaveLength(1);
    // The name is NOT written over it — the thumbnail is the label, and a
    // caption across it covers the part that identifies it.
    expect(nodes(r, 'Text')).toHaveLength(0);
  });

  it('shows an indeterminate spinner, because no percentage exists to show', () => {
    // `isLoading` is only ever set for a pasted image and cleared by
    // `FileReader.onload`; nothing measures an upload. A ring here would be
    // drawn against a number the app never computes.
    const { r } = render([image({ isLoading: true, uri: '' })]);

    expect(nodes(r, 'ActivityIndicator')).toHaveLength(1);
    expect(nodes(r, 'Image')).toHaveLength(0);
  });
});

describe('a file tile', () => {
  it('is wide, and names the file and its kind', () => {
    const { r } = render([doc()]);
    const written = nodes(r, 'Text').map((node) => node.props.children);

    expect(written).toContain('report.pdf');
    expect(written).toContain('PDF');
  });

  it('is shaped unlike an image tile, which is the point of the change', () => {
    const { r: withImage } = render([image()]);
    // Read before unmounting: a node's props resolve lazily against a live tree.
    const imageClasses = classes(
      nodes(withImage, 'View').find((node) => classes(node).includes('h-14')) as ReactTestInstance,
    );
    act(() => renderer?.unmount());

    const { r: withDoc } = render([doc()]);
    const docClasses = classes(
      nodes(withDoc, 'View').find((node) => classes(node).includes('w-60')) as ReactTestInstance,
    );

    // A 56px square against a width that is narrow on a phone and wider on a
    // large screen — different shapes, not merely different contents.
    expect(imageClasses).toContain('w-14');
    expect(docClasses).toContain('md:w-80');
    expect(docClasses).not.toContain('w-14');
  });

  it('lets a long name truncate rather than widen the tile', () => {
    const { r } = render([doc({ name: 'a-report-with-a-preposterously-long-name.pdf' })]);
    const name = nodes(r, 'Text')[0];
    const holder = nodes(r, 'View').find((node) => classes(node).includes('flex-1'));

    expect(name.props.numberOfLines).toBe(1);
    // Both halves: a flex child will not shrink past its content without
    // `min-w-0`, so the ellipsis never arrives and the tile is pushed wider
    // instead.
    expect(classes(holder as ReactTestInstance)).toContain('min-w-0');
  });
});

describe('the remove button', () => {
  it('drops the attachment it names, not the first one', () => {
    const three = [
      doc({ id: 'a', name: 'first.pdf' }),
      doc({ id: 'b', name: 'second.pdf' }),
      doc({ id: 'c', name: 'third.pdf' }),
    ];
    const { r, removeAttachment } = render(three);
    const buttons = nodes(r, 'Pressable');

    expect(buttons).toHaveLength(3);
    act(() => buttons[1].props.onPress());

    // Three, so that "removes the one it names" cannot be satisfied by removing
    // whichever happens to be first.
    expect(removeAttachment).toHaveBeenCalledWith('b');
    expect(removeAttachment).toHaveBeenCalledTimes(1);
  });

  it('says which attachment it drops, by position as well as name', () => {
    const { r } = render([doc({ id: 'a', name: 'first.pdf' }), doc({ id: 'b', name: 'second.pdf' })]);
    const labels = nodes(r, 'Pressable').map((node) => node.props.accessibilityLabel);

    // Position as well as name, because two files can share a name and the name
    // alone would then describe both buttons. Read through the stubbed `t`, so
    // what is pinned is that both facts reach the label — the words themselves
    // are `composer.remove` in `lib/i18n/locales/*.json` and change with the
    // reader's language.
    expect(labels).toEqual([
      'composer.remove position=1 name=first.pdf',
      'composer.remove position=2 name=second.pdf',
    ]);
  });
});

describe('the row itself', () => {
  it('scrolls sideways instead of wrapping, with no bar of its own', () => {
    const { r } = render([image(), doc(), image({ id: 'i2' }), doc({ id: 'd2' }), image({ id: 'i3' })]);
    const row = nodes(r, 'ScrollView')[0];

    expect(row.props.horizontal).toBe(true);
    expect(row.props.showsHorizontalScrollIndicator).toBe(false);
  });

  it('fades at both ends, to the surface rather than to transparent', () => {
    const { r } = render([doc()]);
    const fades = nodes(r, 'LinearGradient');

    expect(fades).toHaveLength(2);
    // Fading to the `transparent` keyword passes through black on the way out
    // on some platforms, which shows as a dark smear at each end.
    for (const fade of fades) {
      expect(fade.props.colors).toContain('rgba(255, 255, 255, 0)');
      expect(fade.props.colors).toContain('rgb(255, 255, 255)');
    }
    // Opposite directions, so each end fades outward.
    expect(fades[0].props.colors).not.toEqual(fades[1].props.colors);
  });
});

describe('the tile corner, and the colours', () => {
  /**
   * The component's CODE, with its prose removed. The comments explain the
   * malformed-colour trap by quoting it, and a gate that reads those would go
   * red at the explanation rather than at the mistake.
   */
  const source = readFileSync(
    fileURLToPath(new URL('../attachments.tsx', import.meta.url)),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const composer = readFileSync(
    fileURLToPath(new URL('../prompt-input.tsx', import.meta.url)),
    'utf8',
  );

  it('is the composer’s corner less the row’s inset, so the tile looks nested', () => {
    expect(ATTACHMENT_TILE_RADIUS).toBe(COMPOSER_RADIUS - ATTACHMENT_ROW_INSET);
  });

  it('keeps the derived corner honest against the class the composer actually wears', () => {
    // The radius is a Tailwind class on the bar and a number here, and nothing
    // makes those two agree — so the class is read back. Change one without the
    // other and this is what says so.
    const worn = composer.match(/rounded-\[(\d+)px\]/);
    expect(worn).not.toBeNull();
    expect(Number(worn?.[1])).toBe(COMPOSER_RADIUS);
  });

  it('names no colour of its own', () => {
    // Positive control on the pattern: it has to match the literals this file
    // used to carry.
    expect('#EF4444').toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // And the tint is composed, not concatenated: appending to an `rgb(...)`
    // string yields a malformed colour that reads back fully opaque.
    //
    // Any interpolation followed by hex digits, and any concatenation of them —
    // NOT just a variable that happens to be spelt `color`. Written that
    // narrowly, the gate let `${tone}18` straight through, which is the exact
    // mistake it exists to stop.
    const interpolatedAlpha = /\$\{[^}]+\}[0-9a-fA-F]{2,}/;
    const concatenatedAlpha = /\+\s*["'`][0-9a-fA-F]{2,}["'`]/;
    expect(`${'rgb(1,2,3)'}18`).toMatch(/[0-9a-fA-F]{2,}$/); // the shape, spelt out
    expect(source).not.toMatch(interpolatedAlpha);
    expect(source).not.toMatch(concatenatedAlpha);
    expect(source).toContain('withAlpha');
  });

  it('draws no percentage it did not measure', () => {
    // The whole of #608 §7 in one assertion. Bloom's `use-attachment-queue.ts`
    // fills its ring from `step * (0.55 + Math.random() * 0.9)` on a 50ms tick
    // and calls `onUploadComplete` whether or not a byte moved; a number on
    // this strip has to have come from a `ProgressEvent`.
    expect(source).not.toContain('Math.random');
    expect(source).not.toContain('setInterval');
  });
});

describe('a file still being read', () => {
  it('shows activity, not a number, when nothing measurable was reported', () => {
    const { r } = renderPending([pending({ fraction: null })]);

    // `fraction: null` is "the browser would not say how far this has got".
    // The honest rendering is a spinner; a bar at 0% would read as stuck, and
    // a bar at anything else would be invented.
    expect(nodes(r, 'ActivityIndicator')).toHaveLength(1);
    expect(nodes(r, 'Text').map((node) => node.props.children)).not.toContain('0%');
  });

  it('shows the measured fraction, in the label and in the fill', () => {
    const { r } = renderPending([pending({ fraction: 0.42 })]);
    const written = nodes(r, 'Text').map((node) => node.props.children);
    const fill = nodes(r, 'View').find(
      (node) => classes(node).includes('bg-primary') && node.props.style?.width,
    );
    const tile = nodes(r, 'View').find(
      (node) => node.props.accessibilityRole === 'progressbar',
    );

    expect(written).toContain('42%');
    expect(fill?.props.style.width).toBe('42%');
    // And the same number reaches a reader, rather than a bar that is only a
    // picture of one.
    expect(tile?.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 42 });
    expect(nodes(r, 'ActivityIndicator')).toHaveLength(0);
  });

  it('offers a cancel that names the file it stops', () => {
    const { r, cancel } = renderPending([
      pending({ id: 'in-a', name: 'first.png' }),
      pending({ id: 'in-b', name: 'second.png' }),
    ]);
    const buttons = nodes(r, 'Pressable');

    expect(buttons.map((node) => node.props.accessibilityLabel)).toEqual([
      'composer.cancelRead name=first.png',
      'composer.cancelRead name=second.png',
    ]);
    act(() => buttons[1].props.onPress());

    // Two, so "stops the one it names" cannot pass by stopping the first.
    expect(cancel).toHaveBeenCalledWith('in-b');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('a file that could not be read', () => {
  it('can be read again, from the tile itself', () => {
    const { r, retry } = renderPending([pending({ id: 'in-x', status: 'failed' })]);
    const buttons = nodes(r, 'Pressable');
    const retryButton = buttons.find(
      (node) => node.props.accessibilityLabel === 'composer.retryRead name=photo.png',
    );

    expect(retryButton).toBeDefined();
    act(() => retryButton?.props.onPress());
    expect(retry).toHaveBeenCalledWith('in-x');
  });

  it('stops offering to cancel something that already stopped', () => {
    const { r } = renderPending([pending({ status: 'failed' })]);
    const labels = nodes(r, 'Pressable').map((node) => node.props.accessibilityLabel);

    // The corner control is the same pixel in both states and must not claim
    // to stop a read that has already ended — there is nothing left to abort,
    // so it discards.
    expect(labels).toContain('composer.dismissFailed name=photo.png');
    expect(labels).not.toContain('composer.cancelRead name=photo.png');
    expect(nodes(r, 'ActivityIndicator')).toHaveLength(0);
  });

  it('sits after the settled tiles rather than among them', () => {
    const { r } = renderPending([pending()], [image({ id: 'a' }), image({ id: 'b' })]);
    const tiles = nodes(r, 'View').filter((node) =>
      classes(node).some((name) => name === 'w-60' || name === 'h-14'),
    );

    // Two settled pictures, then the file still being read — newest last, and
    // never inserted between tiles the user is already reaching for.
    expect(tiles.map((tile) => (classes(tile).includes('h-14') ? 'square' : 'wide'))).toEqual(
      ['square', 'square', 'wide'],
    );
  });
});

describe('a file the composer will not take', () => {
  it('says which file and why, in the strip rather than in a toast', () => {
    const { r } = renderPending([
      pending({ name: 'enormous.png', status: 'refused', refusal: 'too-large' }),
    ]);
    const written = nodes(r, 'Text').map((node) => node.props.children);

    // A drop of six files where one was too large is a sentence the user needs
    // BESIDE the five that worked, not one that slides away after four
    // seconds. The limit reaches the sentence too, so "too large" is a fact
    // with a number rather than a complaint.
    expect(written).toContain('enormous.png');
    expect(written).toContain('composer.fileTooLarge name=enormous.png limit=20 MB');
  });

  it('offers only a way to dismiss it — retrying a refusal changes nothing', () => {
    const { r } = renderPending([
      pending({ name: 'Pictures', status: 'refused', refusal: 'empty' }),
    ]);
    const labels = nodes(r, 'Pressable').map((node) => node.props.accessibilityLabel);

    expect(labels).toEqual(['composer.dismissFailed name=Pictures']);
    // A dropped folder arrives as a zero-byte File, and reading it again would
    // produce the same nothing.
    expect(labels).not.toContain('composer.retryRead name=Pictures');
  });
});
