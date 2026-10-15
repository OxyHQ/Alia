import type React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View') };
});
vi.mock('@oxy.so/bloom/item', async () => {
  const ReactModule = await import('react');
  return {
    Item: ({ title, ...props }: Record<string, React.ReactNode>) =>
      ReactModule.createElement('Item', props, title),
  };
});
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

import { ComposerSuggestions } from '../../src/components/ComposerSuggestions';
import { composerCompletions } from '../../src/lib/suggestions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
});
const all = (r: TestRenderer.ReactTestRenderer, name: string): ReactTestInstance[] =>
  r.root.findAll((node) => node.type === name);

describe('ComposerSuggestions', () => {
  it('draws one row per completion, the typed part highlighted, the keyboard row highlighted', () => {
    const onPick = vi.fn();
    const rows = composerCompletions('lis', [], [{ id: 'm1', text: 'Trip to Lisbon' }]);
    act(() => {
      renderer = TestRenderer.create(
        <ComposerSuggestions completions={rows} selected={0} onPick={onPick} />,
      );
    });
    const r = renderer as TestRenderer.ReactTestRenderer;
    const [item] = all(r, 'Item');
    expect(item!.props.highlighted).toBe(true);
    expect(item!.props.accessibilityLabel).toBe('Trip to Lisbon');
    const highlight = all(r, 'Text').find(
      (node) => node.props.className === 'font-medium text-primary',
    );
    expect(highlight?.props.children).toBe('Lis');
    act(() => item!.props.onPress());
    expect(onPick).toHaveBeenCalledWith(rows[0]!.suggestion);
  });

  it('draws nothing without completions', () => {
    act(() => {
      renderer = TestRenderer.create(
        <ComposerSuggestions completions={[]} selected={-1} onPick={vi.fn()} />,
      );
    });
    expect((renderer as TestRenderer.ReactTestRenderer).toJSON()).toBeNull();
  });
});
