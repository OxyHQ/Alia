import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The app-language row no longer owns a picker of its own — Oxy resolves the
 * language (the account's primary locale, or the device/guest locale when
 * signed out) and ships the multi-select picker that reads and writes it.
 * This row's only job is to show what Oxy resolved and open that picker,
 * `showBottomSheet('LanguageSelector')`, on press — exactly like every other
 * Oxy-owned surface in Settings (`ManageAccount`, etc.).
 */

const mocks = vi.hoisted(() => ({
  showBottomSheet: vi.fn(),
  currentLanguage: 'en-US',
  currentLanguages: [] as string[],
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View'), Pressable: host('Pressable') };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const glyph = (props: Record<string, unknown>) => ReactModule.createElement('Glyph', props);
  return { ChevronRight: glyph, Globe2: glyph };
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

vi.mock('@oxy.so/services', () => ({
  useOxy: () => ({
    showBottomSheet: mocks.showBottomSheet,
    currentLanguage: mocks.currentLanguage,
    currentLanguages: mocks.currentLanguages,
  }),
}));

vi.mock('@oxy.so/core', () => ({
  // Stands in for the real catalog lookup: uppercases the base language so
  // the assertion can tell the resolved code reached the label.
  getNativeLanguageName: (code: string) => `native:${code}`,
}));

import { LanguageSelector } from '../language-selector';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HOST_PRESSABLE: string = 'Pressable';
const HOST_TEXT: string = 'Text';

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  mocks.showBottomSheet.mockClear();
  mocks.currentLanguage = 'en-US';
  mocks.currentLanguages = [];
});

function render() {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(<LanguageSelector />);
  });
  if (next === undefined) throw new Error('the language row did not render');
  renderer = next;
  return next;
}

describe('the app-language row', () => {
  it('opens the Oxy-owned language picker on press, not a picker of its own', () => {
    const r = render();
    const rows = r.root.findAll((node) => node.type === HOST_PRESSABLE);

    expect(rows).toHaveLength(1);
    act(() => rows[0]?.props.onPress());

    expect(mocks.showBottomSheet).toHaveBeenCalledWith('LanguageSelector');
  });

  it('describes the single resolved locale when there is no account override list', () => {
    mocks.currentLanguage = 'en-US';
    mocks.currentLanguages = [];
    const r = render();

    const texts = r.root.findAll((node) => node.type === HOST_TEXT).map((n) => n.props.children);
    expect(texts).toContain('native:en-US');
  });

  it('describes every account locale, primary first, when signed in', () => {
    mocks.currentLanguages = ['es-ES', 'en-US'];
    const r = render();

    const texts = r.root.findAll((node) => node.type === HOST_TEXT).map((n) => n.props.children);
    expect(texts).toContain('native:es-ES, native:en-US');
  });
});
