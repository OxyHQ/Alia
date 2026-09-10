import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The "Files and sources" sections of the execution panel (#544).
 *
 * Pinned: an output is listed by its full name — truncated on screen, whole
 * for assistive tech — and is a control only when something can open it; a
 * source opens where it points; and a section with nothing in it stays, with
 * its header and one line saying so, rather than vanishing or looking like a
 * load that failed (#542). The extract's "Create file or site" and "Add
 * source" buttons are deliberately absent: nothing answers them (#539).
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Pressable: host('Pressable'),
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
  };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const icon = (name: string) => (props: Record<string, unknown>) => ReactModule.createElement(name, props);
  return { ChevronRight: icon('ChevronRight'), FileText: icon('FileText'), Globe: icon('Globe') };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key}(${Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(',')})`,
  }),
}));
vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));

import { FilesAndSources } from '@/components/execution/files-and-sources';
import type { OutputFile, Source } from '@/lib/thought-utils';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Host names as `string`, the way the other suites spell them: a literal would not compare against `ElementType`. */
const HOST_PRESSABLE: string = 'Pressable';
const HOST_VIEW: string = 'View';
const HOST_TEXT: string = 'Text';

const LONG_NAME = 'a-very-long-generated-report-name-that-does-not-fit-in-three-hundred-pixels-2026-09-10.md';

const outputs: OutputFile[] = [
  { id: 'g1', name: 'qa-ui.md', toolName: 'generateFile' },
  { id: 'g2', name: LONG_NAME, toolName: 'generateFile' },
];
const sources: Source[] = [
  { title: 'One', url: 'https://one.test/', snippet: '', domain: 'one.test' },
  { title: 'Two', url: 'https://two.test/page', snippet: '', domain: 'two.test' },
];

let renderer: ReactTestRenderer | null = null;

function render(element: React.ReactElement) {
  let next: ReactTestRenderer | undefined;
  act(() => { next = create(element); });
  if (next === undefined) throw new Error('did not render');
  renderer = next;
  return next;
}

function text(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(r.toJSON());
  return out.join(' | ');
}

const buttons = (r: ReactTestRenderer) => r.root.findAll((node) => node.type === HOST_PRESSABLE && node.props.accessibilityRole === 'button');
const labelled = (r: ReactTestRenderer, label: string) => r.root.findAll((node) => node.props.accessibilityLabel === label && (node.type === HOST_PRESSABLE || node.type === HOST_VIEW));

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('with outputs and sources', () => {
  it('lists each output by its whole name, as a control only when it can be opened', () => {
    const onOpenOutput = vi.fn((output: OutputFile) => output.id === 'g1');
    const r = render(<FilesAndSources outputs={outputs} sources={sources} onOpenOutput={onOpenOutput} onOpenSource={() => {}} />);

    // The openable one is a button whose name says what the press does.
    const openable = buttons(r).find((b) => b.props.accessibilityLabel === 'thought.openOutput(name=qa-ui.md)');
    expect(openable).toBeDefined();
    // The other is a labelled row, not a dead button — the long name whole.
    const plain = labelled(r, LONG_NAME);
    expect(plain).toHaveLength(1);
    expect(plain[0].type).toBe(HOST_VIEW);
    // On screen the name sits on one line.
    const nameText = r.root.findAll((node) => node.type === HOST_TEXT && node.props.children === LONG_NAME);
    expect(nameText[0].props.numberOfLines).toBe(1);

    expect(text(r)).not.toContain('thought.noOutputs');
    expect(text(r)).not.toContain('thought.noSources');
  });

  it('opens a source where it points', () => {
    const onOpenSource = vi.fn();
    const r = render(<FilesAndSources outputs={outputs} sources={sources} onOpenSource={onOpenSource} />);
    const second = buttons(r).find((b) => b.props.accessibilityLabel === 'thought.sourceLabel(n=2,title=Two)');
    if (second === undefined) throw new Error('no source row');
    act(() => { second.props.onPress(); });
    expect(onOpenSource).toHaveBeenCalledWith(sources[1]);
    expect(text(r)).toContain('two.test');
  });

  it('folds a section on its header and unfolds it again', () => {
    const r = render(<FilesAndSources outputs={outputs} sources={sources} onOpenSource={() => {}} />);
    const header = buttons(r).find((b) => b.props.accessibilityLabel === 'thought.outputs');
    if (header === undefined) throw new Error('no header');
    expect(header.props.accessibilityState).toMatchObject({ expanded: true });
    act(() => { header.props.onPress(); });
    expect(text(r)).not.toContain('qa-ui.md');
    expect(text(r)).toContain('One');
    act(() => { buttons(r).find((b) => b.props.accessibilityLabel === 'thought.outputs')!.props.onPress(); });
    expect(text(r)).toContain('qa-ui.md');
  });
});

describe('with nothing', () => {
  it('keeps both sections, each saying it is empty, and ships no add buttons', () => {
    const r = render(<FilesAndSources outputs={[]} sources={[]} onOpenSource={() => {}} />);
    expect(text(r)).toContain('thought.outputs');
    expect(text(r)).toContain('thought.noOutputs');
    expect(text(r)).toContain('thought.sources');
    expect(text(r)).toContain('thought.noSources');
    // Only the two section toggles are controls.
    expect(buttons(r).map((b) => b.props.accessibilityLabel)).toEqual(['thought.outputs', 'thought.sources']);
  });
});
