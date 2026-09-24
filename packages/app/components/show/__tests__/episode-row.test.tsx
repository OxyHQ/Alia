import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What an episode row SAYS about an episode.
 *
 * Three states look alike in markup and mean opposite things to a person: an
 * episode being made, an episode that is ready, and an episode that failed. The
 * one that is easiest to get wrong is a private show's — Syra parks a private
 * episode at `processing` forever on purpose, so anything in Alia that implies
 * "still working" or "broken" about a finished episode is a lie the UI tells
 * about a recording that plays perfectly well.
 *
 * These assert the visible text and where the play affordance is, because that
 * is what a person actually reads.
 */

const audio = vi.hoisted(() => ({
  state: 'idle' as 'idle' | 'loading' | 'playing' | 'paused' | 'unplayable',
  problem: null as
    | null
    | 'signed-out'
    | 'forbidden'
    | 'missing'
    | 'unavailable'
    | 'unreachable',
  toggle: vi.fn(),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);

  return {
    Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web },
    View: host('View'),
  };
});

/** Each glyph as a host named for what it shows. */
vi.mock('@oxy.so/bloom/icons/RiPlayFill', async () => {
  const ReactModule = await import('react');
  return { RiPlayFill: () => ReactModule.createElement('Play') };
});
vi.mock('@oxy.so/bloom/icons/RiPauseFill', async () => {
  const ReactModule = await import('react');
  return { RiPauseFill: () => ReactModule.createElement('Pause') };
});
vi.mock('@oxy.so/bloom/icons/RiErrorWarningLine', async () => {
  const ReactModule = await import('react');
  return {
    RiErrorWarningLine: () => ReactModule.createElement('AlertCircle'),
  };
});
vi.mock('@oxy.so/bloom/icons/RiDeleteBinLine', async () => {
  const ReactModule = await import('react');
  return { RiDeleteBinLine: () => ReactModule.createElement('Trash2') };
});

/** A host that draws its icon, so which glyph a control shows is readable. */
vi.mock('@oxy.so/bloom/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({
      children,
      icon,
      ...props
    }: React.PropsWithChildren<{ icon?: React.ComponentType }>) =>
      ReactModule.createElement(
        'Button',
        props,
        icon ? ReactModule.createElement(icon) : null,
        children,
      ),
  };
});

vi.mock('@oxy.so/bloom/item', async () => {
  const ReactModule = await import('react');
  return {
    Item: ({
      children,
      trailing,
    }: React.PropsWithChildren<{ trailing?: React.ReactNode }>) =>
      ReactModule.createElement('Item', null, children, trailing),
  };
});

vi.mock('@oxy.so/bloom/admonition', async () => {
  const ReactModule = await import('react');
  return {
    Admonition: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement(
        'Admonition',
        null,
        ReactModule.createElement('Text', null, children),
      ),
  };
});

vi.mock('@oxy.so/bloom/loading', async () => {
  const ReactModule = await import('react');
  return {
    Loading: (props: Record<string, unknown>) =>
      ReactModule.createElement('ActivityIndicator', props),
  };
});

vi.mock('@oxy.so/bloom/stat-bar', async () => {
  const ReactModule = await import('react');
  return {
    Meter: (props: Record<string, unknown>) =>
      ReactModule.createElement('Meter', props),
  };
});

vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({
    colors: { textSecondary: '#888', error: 'red' },
  }),
}));

/**
 * Only the hook. `EPISODE_AUDIO_PROBLEM_LABEL` deliberately lives in the row
 * itself, so these read the REAL words a listener sees rather than a copy of
 * them kept alive in a mock — a test of a re-implementation measures the
 * re-implementation.
 */
vi.mock('@/lib/hooks/use-episode-audio', () => ({
  useEpisodeAudio: () => ({
    state: audio.state,
    problem: audio.problem,
    toggle: audio.toggle,
  }),
}));

/** The real store, with only its transport stubbed — the row reads live progress from it. */
vi.mock('@/lib/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { useShowStore, type ShowEpisode } from '@/lib/stores/show-store';
import { EpisodeRow } from '../episode-row';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Fixed so `Today` in the metadata line is decidable. */
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

const BASE: ShowEpisode = {
  id: 'episode-1',
  seriesId: 'series-1',
  episodeNumber: 3,
  title: 'What the deep sea is hiding',
  topic: 'recent discoveries in the hadal zone',
  status: 'completed',
  progress: 100,
  syraEpisodeId: 'syra-ep-3',
  durationMs: 750_000,
  createdAt: '2026-08-24T09:00:00.000Z',
  updatedAt: '2026-08-24T09:20:00.000Z',
};

const onDelete = vi.fn();
let renderer: ReactTestRenderer | null = null;

function renderRow(episode: ShowEpisode) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(<EpisodeRow episode={episode} onDelete={onDelete} />);
  });
  if (next === undefined) throw new Error('EpisodeRow did not render');
  renderer = next;
  return next.root;
}

type Root = ReturnType<typeof renderRow>;

/**
 * Host elements by name. The mocks render plain host elements, and
 * `findAllByType` is typed for components — a string literal compared against
 * `TestInstance['type']` does not typecheck, while a `string` variable does.
 */
function nodes(root: Root, name: string) {
  return root.findAll((node) => node.type === name);
}

/** Every string the row renders, in order. */
function lines(root: Root): string[] {
  return nodes(root, 'Text')
    .map((node) =>
      React.Children.toArray(node.props.children as React.ReactNode)
        .map((child) =>
          typeof child === 'string' || typeof child === 'number'
            ? String(child)
            : '',
        )
        .join(''),
    )
    .filter((line) => line !== '');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  audio.state = 'idle';
  audio.problem = null;
  audio.toggle.mockReset();
  onDelete.mockReset();
  act(() => {
    useShowStore.setState({ activeGenerations: new Map() });
  });
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.useRealTimers();
});

describe('EpisodeRow', () => {
  it('states a ready episode the way Syra states one, and offers a play control', () => {
    const root = renderRow(BASE);

    expect(lines(root)).toContain('Episode 3 · Today · 12 min');
    expect(nodes(root, 'Play')).toHaveLength(1);
    expect(nodes(root, 'Pause')).toHaveLength(0);

    const play = nodes(root, 'Button').find(
      (node) => node.props.accessibilityLabel === `Play ${BASE.title}`,
    );
    expect(play).toBeDefined();
    act(() => play?.props.onPress());
    expect(audio.toggle).toHaveBeenCalledOnce();
  });

  it('shows a pause control while it is playing', () => {
    audio.state = 'playing';
    const root = renderRow(BASE);

    expect(nodes(root, 'Pause')).toHaveLength(1);
    expect(nodes(root, 'Play')).toHaveLength(0);
  });

  /**
   * What replaced `NotSupportedError: Failed to load because no supported source
   * was found`, which is what an owner actually got in a browser: the row said
   * `12 min`, the console said that, and neither said the request had gone out
   * without the token. Each refusal now reads as a different sentence, because
   * "couldn't play this one" is as actionable as the DOMException was to
   * somebody who is simply signed out.
   */
  describe('an episode that would not play', () => {
    it('names the refusal in the same quiet line as the duration it stands in for', () => {
      audio.state = 'unplayable';
      audio.problem = 'missing';
      const root = renderRow(BASE);
      const rendered = lines(root);

      expect(rendered).toContain(
        'Episode 3 · Today · Syra has no recording for this',
      );
      // The words that would misdescribe a finished episode. Syra parks a private
      // episode at `processing` for good; Alia must not repeat that here.
      expect(rendered.join(' ')).not.toMatch(/processing|failed|broken/i);
    });

    it('tells somebody who is signed out to sign in, rather than blaming the episode', () => {
      audio.state = 'unplayable';
      audio.problem = 'signed-out';
      const root = renderRow(BASE);

      expect(lines(root)).toContain('Episode 3 · Today · Sign in to play this');
    });

    it('says the request never reached Syra when that is what happened', () => {
      // A developer on `localhost` is not in Syra's CORS allow-list, so the
      // preflight fails and the fetch rejects without ever being answered.
      audio.state = 'unplayable';
      audio.problem = 'unreachable';
      const root = renderRow(BASE);

      expect(lines(root)).toContain("Episode 3 · Today · Couldn't reach Syra");
    });

    it('shows the duration, and no refusal at all, when there is none', () => {
      // The positive control. A row that always printed a refusal would satisfy
      // every assertion above and lie about every episode that plays.
      const root = renderRow(BASE);

      expect(lines(root)).toContain('Episode 3 · Today · 12 min');
      expect(lines(root).join(' ')).not.toMatch(
        /Sign in|reach Syra|no recording|wouldn/,
      );
    });
  });

  it('shows an episode still being made as work in progress, with no play control', () => {
    act(() => {
      useShowStore.setState({
        activeGenerations: new Map([
          [
            'episode-1',
            {
              episodeId: 'episode-1',
              seriesId: 'series-1',
              status: 'generating_audio',
              progress: 40,
              currentStep: 'Recording Ana',
              segmentIndex: 2,
              totalSegments: 5,
            },
          ],
        ]),
      });
    });

    // `syraEpisodeId` is present, because `POST /shows/series/:id/episodes`
    // reserves a Syra DRAFT before the pipeline runs — every episode has one
    // from the moment it is queued. A row that decided playability on the id
    // alone would offer a play control for a recording that does not exist yet.
    const root = renderRow({
      ...BASE,
      status: 'generating_audio',
      progress: 40,
      durationMs: null,
    });
    const rendered = lines(root);

    expect(nodes(root, 'Play')).toHaveLength(0);
    expect(nodes(root, 'AlertCircle')).toHaveLength(0);
    expect(rendered).toContain('Recording Ana');
    expect(rendered).toContain('Segment 2/5');
    // No duration is known yet, so the line states what IS known and nothing more.
    expect(rendered).toContain('Episode 3 · Today');
  });

  it('draws the progress bar from the episode itself, so a reload mid-generation still shows one', () => {
    // No socket event has arrived — `activeGenerations` is empty, exactly as it
    // is on a cold load of a series that was already generating.
    const root = renderRow({
      ...BASE,
      status: 'generating_script',
      progress: 25,
      durationMs: null,
    });

    expect(lines(root)).toContain('Writing the script');
    const [bar] = nodes(root, 'Meter');
    expect(bar?.props.value).toBe(25);
    expect(bar?.props.max).toBe(100);
  });

  it('says why a failed episode failed', () => {
    const root = renderRow({
      ...BASE,
      status: 'failed',
      durationMs: null,
      error: 'The voice service was busy',
    });
    const rendered = lines(root);

    expect(rendered).toContain('The voice service was busy');
    expect(nodes(root, 'AlertCircle')).toHaveLength(1);
    expect(nodes(root, 'Play')).toHaveLength(0);
  });

  /**
   * The user-visible half of a fix whose other half is a column in Postgres.
   *
   * The pipeline skips a line it cannot render, publishes, and writes
   * `completed` — so this row used to say `Episode 3 · Today · 12 min` about a
   * recording missing lines. The API marks the segments it could not render;
   * these assert that the mark ARRIVES here, in words.
   *
   * Older episodes also carry `sfx` segments from before sound effects were
   * removed, most of them marked failed. Those are not lines and the feature is
   * gone, so they are never counted.
   */
  describe('a line the episode could not make', () => {
    /** One lost line, beside legacy sound cues that also never rendered. */
    const withLosses: ShowEpisode = {
      ...BASE,
      segments: [
        { index: 0, speaker: '', text: '', type: 'sfx', renderFailed: true },
        { index: 1, speaker: 'Ana', text: 'Hello.', type: 'dialogue' },
        { index: 2, speaker: '', text: '', type: 'transition', renderFailed: true },
        {
          index: 3,
          speaker: 'Ana',
          text: 'Goodbye.',
          type: 'dialogue',
          renderFailed: true,
        },
        { index: 4, speaker: '', text: '', type: 'sfx' },
      ],
    };

    it('is stated in the same quiet line as the duration, counting lines only', () => {
      const root = renderRow(withLosses);

      expect(lines(root)).toContain('Episode 3 · Today · 12 min · 1 line missing');
      expect(lines(root).join(' ')).not.toMatch(/sound effect/);
      // Still an episode: it plays, and nothing calls it broken.
      expect(nodes(root, 'Play')).toHaveLength(1);
      expect(nodes(root, 'AlertCircle')).toHaveLength(0);
    });

    it('says nothing at all when every segment rendered', () => {
      // The positive control. A row that always showed the phrase would satisfy
      // the assertion above and label every show ever made as damaged.
      const root = renderRow({
        ...BASE,
        segments: withLosses.segments?.map((segment) => ({
          ...segment,
          renderFailed: false,
        })),
      });

      expect(lines(root)).toContain('Episode 3 · Today · 12 min');
      expect(lines(root).join(' ')).not.toMatch(/missing/);
    });

    it('says nothing for an older episode whose only losses are sound cues', () => {
      const root = renderRow({
        ...BASE,
        segments: [
          { index: 0, speaker: '', text: '', type: 'sfx', renderFailed: true },
          { index: 1, speaker: 'Ana', text: 'Hello.', type: 'dialogue' },
        ],
      });

      expect(lines(root)).toContain('Episode 3 · Today · 12 min');
      expect(lines(root).join(' ')).not.toMatch(/missing/);
    });

    it('counts several lines in the plural', () => {
      const root = renderRow({
        ...BASE,
        segments: [
          { index: 0, speaker: 'Ana', text: 'Hello.', type: 'dialogue', renderFailed: true },
          { index: 1, speaker: 'Ana', text: 'Bye.', type: 'dialogue', renderFailed: true },
        ],
      });

      expect(lines(root)).toContain('Episode 3 · Today · 12 min · 2 lines missing');
    });

    it('withholds the count while the episode is still being made', () => {
      // Segments are marked as each batch finishes, so a count shown here is a
      // number that climbs beside a progress bar already saying it is not done.
      const root = renderRow({
        ...withLosses,
        status: 'generating_audio',
        durationMs: null,
      });

      expect(lines(root).join(' ')).not.toMatch(/missing/);
      expect(lines(root)).toContain('Episode 3 · Today');
    });

    it('says nothing for an episode whose segments the API did not send', () => {
      // `segments` is optional on the client type and absent is not zero — a
      // row that read `undefined` as "everything failed" would be worse than
      // the silence this replaces.
      const root = renderRow({ ...BASE, segments: undefined });

      expect(lines(root)).toContain('Episode 3 · Today · 12 min');
      expect(lines(root).join(' ')).not.toMatch(/missing/);
    });
  });

  it('keeps the remove action reachable, and named for what it destroys', () => {
    const root = renderRow(BASE);
    const remove = nodes(root, 'Button').find(
      (node) =>
        node.props.accessibilityLabel === `Delete ${BASE.title} everywhere`,
    );

    // The qualifier is part of the contract, not decoration. It said `from
    // Alia` while the recording survived on Syra; the action now deletes in
    // both places, so the label a screen reader announces has to say so — an
    // understated label is as wrong as an overstated one, in the other
    // direction, and this is the surface that catches either.
    expect(remove).toBeDefined();
    // Always drawn — not hidden behind a hover — so it is there on a device
    // with no pointer, and it is the bin glyph.
    expect(remove ? nodes(remove, 'Trash2') : []).toHaveLength(1);

    act(() => remove?.props.onPress());
    expect(onDelete).toHaveBeenCalledWith('episode-1');
  });
});
