import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the show screen TELLS a person when they press the bin.
 *
 * The report this exists for: *"había un botón que yo creía que era para borrar
 * el show pero solo lo borró de Alia y sigue en Syra."* Two separate untruths
 * were reachable from that one press, and only one of them is fixable here.
 *
 * The one that is: the screen toasted `Removed from Alia` in the same tick it
 * called the store, then navigated away — so a delete the API refused still
 * reported success, over a show that was still there. That is asserted below,
 * against the REAL store with a mocked HTTP client, because the lie lived in
 * the seam between them: the store's `void` answer left the screen nothing to
 * branch on. A test that mocked the store would measure a re-implementation of
 * exactly the thing that was wrong.
 *
 * The limit this file used to record is gone: Syra now deletes, the API deletes
 * there before it deletes here, and the button means what "delete" means. So
 * the assertions on the confirmation's own words changed with it — they pin the
 * screen to naming what is destroyed BEFORE the press, which is the whole
 * reason a destructive confirmation exists.
 */

const httpDelete = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const confirmSurface = vi.hoisted(() => vi.fn());
const routerBack = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/client', () => ({
  default: {
    get: vi.fn().mockRejectedValue(new Error('no network in this test')),
    post: vi.fn(),
    patch: vi.fn(),
    delete: httpDelete,
  },
}));

vi.mock('@oxyhq/bloom/toast', () => ({
  toast: { success: toastSuccess, error: toastError },
}));

vi.mock('@oxyhq/bloom/surfaces', () => ({ confirm: confirmSurface }));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'series-abc' }),
  useRouter: () => ({ back: routerBack, push: vi.fn() }),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);

  type ListProps = {
    data?: readonly unknown[];
    renderItem?: (info: { item: unknown; index: number }) => React.ReactNode;
    keyExtractor?: (item: unknown, index: number) => string;
    ListHeaderComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    ListEmptyComponent?: React.ReactNode;
  };

  // Renders the header, the rows and the FOOTER — the footer is where the
  // control under test lives, and a mock that dropped it would make this whole
  // file pass by rendering nothing.
  const FlatList = ({
    data = [],
    renderItem,
    keyExtractor,
    ListHeaderComponent,
    ListFooterComponent,
    ListEmptyComponent,
  }: ListProps) =>
    ReactModule.createElement(
      'FlatList',
      null,
      ListHeaderComponent,
      data.length === 0
        ? ListEmptyComponent
        : data.map((item, index) =>
            ReactModule.createElement(
              ReactModule.Fragment,
              { key: keyExtractor ? keyExtractor(item, index) : String(index) },
              renderItem?.({ item, index }),
            ),
          ),
      ListFooterComponent,
    );

  return {
    View: host('View'),
    Pressable: host('Pressable'),
    FlatList,
    RefreshControl: host('RefreshControl'),
    Linking: { openURL: vi.fn() },
    StyleSheet: { absoluteFill: {}, create: (styles: unknown) => styles },
  };
});

vi.mock('expo-linear-gradient', async () => {
  const ReactModule = await import('react');
  return {
    LinearGradient: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('LinearGradient', null, children),
  };
});

/**
 * Named one by one, NOT via a `Proxy` — a proxy that answers every key also
 * answers `then`, which makes the module namespace thenable and hangs
 * `await import()` forever rather than failing.
 */
vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const icon = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props);

  return {
    Plus: icon('Plus'),
    Trash2: icon('Trash2'),
    ChevronLeft: icon('ChevronLeft'),
    ExternalLink: icon('ExternalLink'),
    Lock: icon('Lock'),
    Link2: icon('Link2'),
    Globe: icon('Globe'),
    Pencil: icon('Pencil'),
  };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@/components/ui/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Button', props, children),
  };
});

vi.mock('@/components/ui/avatar', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => ({ children }: React.PropsWithChildren) =>
    ReactModule.createElement(name, null, children);
  return { Avatar: host('Avatar'), AvatarFallback: host('AvatarFallback') };
});

vi.mock('@/components/ui/skeleton', async () => {
  const ReactModule = await import('react');
  return { Skeleton: () => ReactModule.createElement('Skeleton') };
});

vi.mock('@oxyhq/bloom/content-panel', async () => {
  const ReactModule = await import('react');
  return {
    ContentPanel: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('ContentPanel', null, children),
  };
});

vi.mock('@oxyhq/bloom/theme', () => ({ withAlpha: (color: string) => color }));

vi.mock('@/components/show/show-artwork', async () => {
  const ReactModule = await import('react');
  return { ShowArtwork: () => ReactModule.createElement('ShowArtwork') };
});

vi.mock('@/components/show/episode-create-dialog', async () => {
  const ReactModule = await import('react');
  return { EpisodeCreateDialog: () => ReactModule.createElement('EpisodeCreateDialog') };
});

vi.mock('@/components/show/episode-row', async () => {
  const ReactModule = await import('react');
  return {
    EpisodeRow: ({ episode, onDelete }: { episode: { id: string }; onDelete: (id: string) => void }) =>
      ReactModule.createElement('EpisodeRow', {
        accessibilityLabel: `row ${episode.id}`,
        onDelete: () => onDelete(episode.id),
      }),
  };
});

vi.mock('@/lib/hooks/use-show-progress', () => ({ useShowProgress: () => undefined }));

vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { primary: '#000', background: '#fff', foreground: '#000' } }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SERIES = {
  id: 'series-abc',
  userId: 'user-1',
  syraPodcastId: 'syra-pod-1',
  title: 'The Wednesday Digest',
  format: 'podcast' as const,
  brief: 'A weekly look at what I have been reading.',
  speakers: [],
  visibility: 'private' as const,
  nextEpisodeNumber: 2,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

const EPISODE = {
  id: 'episode-xyz',
  seriesId: 'series-abc',
  episodeNumber: 1,
  title: 'The first one',
  status: 'completed' as const,
  progress: 100,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

let tree: ReactTestRenderer | undefined;

async function renderScreen(episodes: (typeof EPISODE)[] = []) {
  const { useShowStore } = await import('@/lib/stores/show-store');
  useShowStore.setState({
    series: [SERIES],
    episodesBySeries: { 'series-abc': episodes },
    error: null,
  });

  const { default: SeriesDetailScreen } = await import('../[id]');

  await act(async () => {
    tree = create(React.createElement(SeriesDetailScreen));
  });

  if (!tree) throw new Error('the screen did not render');
  return tree;
}

/**
 * `type: string` rather than a literal — `node.type` is `ElementType`, and TS
 * calls a comparison against a string LITERAL an unintentional one.
 */
function byLabel(rendered: ReactTestRenderer, type: string, label: string): ReactTestInstance {
  return rendered.root.find(
    (node) => node.type === type && node.props.accessibilityLabel === label,
  );
}

function pressRemoveShow(rendered: ReactTestRenderer): Promise<void> {
  const control = byLabel(rendered, 'Pressable', 'Remove this show from Alia');
  return act(async () => {
    await control.props.onPress();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmSurface.mockResolvedValue(true);
});

afterEach(() => {
  tree?.unmount();
  tree = undefined;
});

describe('removing a show', () => {
  it('does not say the show is gone when the request failed', async () => {
    httpDelete.mockRejectedValueOnce(new Error('Failed to delete the series'));
    const rendered = await renderScreen();

    await pressRemoveShow(rendered);

    // The whole defect: a failed delete used to report success and navigate
    // away from a show it had not removed.
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    expect(routerBack).not.toHaveBeenCalled();

    const { useShowStore } = await import('@/lib/stores/show-store');
    expect(useShowStore.getState().series.map((s) => s.id)).toEqual(['series-abc']);
  });

  it('says it is gone from both, when the request succeeded', async () => {
    httpDelete.mockResolvedValueOnce({ data: { deleted: true, syraPodcastDeleted: true } });
    const rendered = await renderScreen();

    await pressRemoveShow(rendered);

    expect(httpDelete).toHaveBeenCalledWith('/shows/series/series-abc');
    expect(toastError).not.toHaveBeenCalled();
    // The message names both places, because both is what happened. It used to
    // promise the podcast survived on Syra, which stopped being true.
    expect(toastSuccess).toHaveBeenCalledWith('Show deleted from Alia and Syra');
    expect(routerBack).toHaveBeenCalled();
  });

  it('asks first, and names what is destroyed before anything is removed', async () => {
    confirmSurface.mockResolvedValue(false);
    const rendered = await renderScreen();

    await pressRemoveShow(rendered);

    // Declined means nothing happened at all — not a request, not a message.
    expect(httpDelete).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(routerBack).not.toHaveBeenCalled();

    /**
     * And the words it asked with. This deletes the Syra podcast, its episodes,
     * their audio and everyone subscribed to it, and it cannot be undone — so
     * the confirmation has to say that at the moment of the decision, not in a
     * toast once it is too late to decline.
     */
    const asked = confirmSurface.mock.calls[0]?.[0] as { title: string; description: string };
    expect(asked.title).toContain('everywhere');
    expect(asked.description).toContain('deleted from Syra too');
    expect(asked.description).toContain('cannot be undone');
  });
});

describe('removing an episode', () => {
  it('does not say the episode is gone when the request failed', async () => {
    httpDelete.mockRejectedValueOnce(new Error('Failed to delete the episode'));

    const { useShowStore } = await import('@/lib/stores/show-store');
    const rendered = await renderScreen([EPISODE]);

    const row = byLabel(rendered, 'EpisodeRow', 'row episode-xyz');
    await act(async () => {
      await row.props.onDelete();
    });

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
    expect(useShowStore.getState().episodesBySeries['series-abc']?.map((e) => e.id)).toEqual([
      'episode-xyz',
    ]);
  });
});
