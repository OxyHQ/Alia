import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Where a source's favicon is fetched from, and what the reader sees when it
 * never arrives.
 *
 * The first is a privacy decision, not a styling one. Pointing an `<img>` at a
 * public favicon service would send that service one request per source
 * straight from the reader's browser, naming the publication and carrying the
 * reader's IP — the reading habits of everyone using Alia, handed to a company
 * with no part in the product. So the URL is asserted whole, against Alia's own
 * configured API base: any third-party host would fail this.
 *
 * The second is what makes the first affordable. Most of these icons are
 * missing, slow, or blocked; every one of those has to leave the row exactly as
 * it looks today, because a mark that vanishes or turns into a broken image is
 * worse than the generic glyph it replaced.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const h = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return {
    View: h('View'),
    Pressable: h('Pressable'),
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web },
  };
});

vi.mock('expo-image', async () => {
  const ReactModule = await import('react');
  return { Image: (props: Record<string, unknown>) => ReactModule.createElement('Image', props) };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const h = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return { Globe: h('Globe') };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  const h = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return { Text: h('Text') };
});

vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (n: string) => n }));

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { MessageSources } from '@/components/message-sources';
import config from '@/lib/config';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A finished `webSearch` exactly as `messages.tool_invocations` stores one. */
const persistedSearch = (urls: string[]) => [
  {
    toolCallId: 'call_1',
    toolName: 'webSearch',
    state: 'result' as const,
    args: { query: 'anything' },
    result: {
      results: urls.map((url, i) => ({ title: `Result ${i}`, url, snippet: 's' })),
      count: urls.length,
    },
  },
];

let renderer: ReactTestRenderer | null = null;

function render(urls: string[]) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(<MessageSources onPress={vi.fn()} toolInvocations={persistedSearch(urls)} />);
  });
  if (next === undefined) throw new Error('MessageSources did not render');
  renderer = next;
  return next.root;
}

/** Host elements by name, which is what a reader would actually be shown. */
function nodes(root: ReturnType<typeof render>, name: string) {
  return root.findAll((node) => node.type === name);
}

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('the favicon behind a source mark', () => {
  it("asks Alia's own API for the icon, and no third party", () => {
    const root = render(['https://www.nytimes.com/2026/09/article.html']);
    const [image] = nodes(root, 'Image');

    // `www.` is stripped by `extractSources`, so the mark and the request agree
    // on the domain the reader is shown.
    expect(image.props.source).toEqual({ uri: `${config.apiUrl}/favicons/nytimes.com` });
    expect(String(image.props.source.uri).startsWith(config.apiUrl)).toBe(true);
  });

  it('asks once per source, for that source', () => {
    const root = render(['https://elpais.com/a', 'https://reuters.com/b']);

    expect(nodes(root, 'Image').map((image) => image.props.source.uri)).toEqual([
      // Reversed in the stack so the first source sits on top of the overlap.
      `${config.apiUrl}/favicons/reuters.com`,
      `${config.apiUrl}/favicons/elpais.com`,
    ]);
  });

  it('shows the globe while the icon is still on its way', () => {
    // The first frame of every source is this one, and there is no spinner:
    // the mark has to be complete before the icon exists.
    const root = render(['https://elpais.com/a']);

    expect(nodes(root, 'Globe')).toHaveLength(1);
  });

  it('drops the globe once the icon is drawn', () => {
    const root = render(['https://elpais.com/a']);
    const [image] = nodes(root, 'Image');

    act(() => { image.props.onLoad(); });

    expect(nodes(root, 'Globe')).toHaveLength(0);
    expect(nodes(root, 'Image')).toHaveLength(1);
  });

  it('keeps the globe and removes the image when the icon cannot be fetched', () => {
    // A 404 from the proxy — a site with no favicon, or a domain it refuses to
    // fetch — must read as "no icon", never as a broken image.
    const root = render(['https://elpais.com/a']);
    const [image] = nodes(root, 'Image');

    act(() => { image.props.onError(); });

    expect(nodes(root, 'Image')).toHaveLength(0);
    expect(nodes(root, 'Globe')).toHaveLength(1);
  });

  it('lets one source fail without touching the others', () => {
    const root = render(['https://elpais.com/a', 'https://reuters.com/b', 'https://lemonde.fr/c']);
    const images = nodes(root, 'Image');

    act(() => { images[0].props.onError(); });
    act(() => { images[1].props.onLoad(); });

    // One failed, one loaded, one still pending: two images left, two globes.
    expect(nodes(root, 'Image')).toHaveLength(2);
    expect(nodes(root, 'Globe')).toHaveLength(2);
  });
});
