import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `react-native-markdown-display` defaults `markdownit`, `allowedImageHandlers`
 * and `topLevelMaxExceededItem` to new objects per render, which rebuilt the
 * parser and the renderer on every render of every block. These pin that
 * `AliaMarkdown` hands it the same objects on every render.
 */
const seen = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
  parsers: 0,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: React.ReactNode }) => children,
  Text: ({ children }: { children?: React.ReactNode }) => children,
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
  Linking: { openURL: vi.fn() },
  useColorScheme: () => 'light',
}));

vi.mock('react-native-markdown-display', () => ({
  default: (props: Record<string, unknown>) => {
    seen.props.push(props);
    return null;
  },
  MarkdownIt: (options: unknown) => {
    seen.parsers += 1;
    return { options };
  },
}));

import { AliaMarkdown } from '../../src/components/Markdown';

const COLORS = {
  text: '#000',
  muted: '#eee',
  border: '#ddd',
  primary: '#70f',
  mutedForeground: '#777',
};

describe('AliaMarkdown hands the renderer stable objects', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    seen.props.length = 0;
  });
  afterEach(() => {
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it('shares one parser, one handler list and one overflow item across renders and blocks', () => {
    act(() => {
      renderer = TestRenderer.create(<AliaMarkdown content="One" colors={COLORS} />);
    });
    // A streamed token: the same message, longer, and then split into blocks.
    act(() => renderer.update(<AliaMarkdown content="One more" colors={COLORS} />));
    act(() => renderer.update(<AliaMarkdown content={'One more\n\nTwo'} colors={COLORS} />));

    expect(seen.props.length).toBeGreaterThanOrEqual(4);
    const [first, ...rest] = seen.props;
    expect(first.markdownit).toBeDefined();
    expect(first.allowedImageHandlers).toEqual([
      'data:image/png;base64',
      'data:image/gif;base64',
      'data:image/jpeg;base64',
      'https://',
      'http://',
    ]);
    expect(first.topLevelMaxExceededItem).toBeDefined();
    for (const props of rest) {
      expect(props.markdownit).toBe(first.markdownit);
      expect(props.allowedImageHandlers).toBe(first.allowedImageHandlers);
      expect(props.topLevelMaxExceededItem).toBe(first.topLevelMaxExceededItem);
    }
    // Built once, when the module loaded — never per render.
    expect(seen.parsers).toBe(1);
    expect(first.markdownit).toEqual({ options: { typographer: true } });
  });
});
