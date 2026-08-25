import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Where a show's cover actually comes from.
 *
 * `coverImageAssetId` is SYRA's image id, not an Oxy file id — `mintCover`
 * uploads the generated square through Syra's `uploadPodcastImage`. A wrong base
 * or a wrong path fails silently: `expo-image` renders nothing and the screen
 * looks like a show with no artwork, which is also a real state. So the URL is
 * asserted whole, against the app's own configured Syra base.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web },
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});

vi.mock('expo-image', async () => {
  const ReactModule = await import('react');
  return {
    Image: (props: Record<string, unknown>) => ReactModule.createElement('Image', props),
  };
});

/**
 * `cn` (via `lib/utils.ts`) reaches `expo-crypto` through `random-uuid`, and
 * `expo-modules-core` needs the Expo runtime that only a device build has.
 * Nothing here generates an id; this only keeps the import graph loadable.
 */
vi.mock('expo-crypto', () => ({
  getRandomValues: (values: Uint8Array) => values,
}));

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  return {
    Mic: (props: Record<string, unknown>) => ReactModule.createElement('Mic', props),
  };
});

import { ShowArtwork } from '../show-artwork';
import { SYRA_API_URL } from '@/lib/config';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function render(assetId: string | null | undefined) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(
      <ShowArtwork
        assetId={assetId}
        title="The Wednesday Digest"
        className="h-16 w-16 rounded-xl"
        iconSize={26}
      />,
    );
  });
  if (next === undefined) throw new Error('ShowArtwork did not render');
  renderer = next;
  return next.root;
}

/**
 * Host elements by name. `findAllByType` is typed for components, so a string
 * literal compared against `TestInstance['type']` does not typecheck while a
 * `string` variable does.
 */
function nodes(root: ReturnType<typeof render>, name: string) {
  return root.findAll((node) => node.type === name);
}

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('ShowArtwork', () => {
  it("fetches the cover from Syra's public image route", () => {
    const root = render('01925f3c-cover');
    const [image] = nodes(root, 'Image');

    expect(image.props.source).toEqual({
      uri: `${SYRA_API_URL}/api/images/01925f3c-cover`,
    });
    expect(image.props.accessibilityLabel).toBe('The Wednesday Digest cover art');
    expect(String(image.props.className)).toContain('h-16 w-16 rounded-xl');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    // Never what the API sends, but the difference between a placeholder and a
    // request to `/api/images/` with no id — which 400s and renders as nothing.
    ['an empty string', ''],
  ])('shows a placeholder, not a spinner, when the cover id is %s', (_label, assetId) => {
    // An account out of credits still gets its series, without art — so this is
    // a final state and must not read as something still loading.
    const root = render(assetId);

    expect(nodes(root, 'Image')).toHaveLength(0);
    expect(nodes(root, 'Mic')).toHaveLength(1);
    expect(nodes(root, 'View')[0].props.accessibilityLabel).toBe(
      'The Wednesday Digest has no cover art',
    );
  });
});
