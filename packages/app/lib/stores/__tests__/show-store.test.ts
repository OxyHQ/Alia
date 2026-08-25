import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The show store, and the Mongo leftover it removes.
 *
 * The store used to declare `_id` while the API has answered `id` since the
 * Postgres port. That does not throw — it produces `undefined` — so the screen
 * rendered rows with `key={undefined}`, and a delete posted to
 * `/v1/shows/undefined`, which is a 404 the UI reported as "failed to delete".
 *
 * These assert the URL the store actually calls, because that is where the bug
 * was visible and a type alone cannot catch it: `_id` on a response object typed
 * `any` compiles perfectly.
 */

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('../../api/client', () => ({
  default: { get, post, patch, delete: del },
}));

const SERIES = {
  id: 'series-abc',
  userId: 'user-1',
  syraPodcastId: 'syra-pod-1',
  title: 'The Wednesday Digest',
  format: 'podcast' as const,
  brief: 'A weekly look at what I have been reading.',
  speakers: [],
  visibility: 'private' as const,
  nextEpisodeNumber: 3,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

const EPISODE = {
  id: 'episode-xyz',
  seriesId: 'series-abc',
  episodeNumber: 2,
  title: 'The second one',
  topic: 'what happened this week',
  status: 'completed' as const,
  progress: 100,
  syraEpisodeId: 'syra-ep-2',
  durationMs: 90_000,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

async function freshStore() {
  vi.resetModules();
  const module = await import('../show-store');
  episodeDisplayTitle = module.episodeDisplayTitle;
  return module.useShowStore;
}

/**
 * Rebound by `freshStore`, because `vi.resetModules()` gives every test its own
 * copy of the module and a binding captured at import time would be a different
 * function from the one the store under test is using.
 */
let episodeDisplayTitle: (episode: {
  title: string | null;
  episodeNumber: number;
}) => string;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reading a series', () => {
  it('keys everything by `id`, and the delete URL carries a real id', async () => {
    const useShowStore = await freshStore();
    get.mockResolvedValueOnce({ data: { series: [SERIES], pagination: {} } });
    del.mockResolvedValueOnce({ data: { deleted: true } });

    await useShowStore.getState().fetchSeries();
    expect(useShowStore.getState().series.map((s) => s.id)).toEqual(['series-abc']);

    await useShowStore.getState().deleteSeries('series-abc');

    // The exact defect the `_id` field caused, asserted as a URL rather than as
    // a type: reading a field the server does not send produced
    // `/shows/series/undefined`, and it is only visible here.
    expect(del).toHaveBeenCalledWith('/shows/series/series-abc');
    expect(del.mock.calls[0]?.[0]).not.toContain('undefined');
    expect(useShowStore.getState().series).toEqual([]);
  });

  it('loads a series and its episodes together', async () => {
    const useShowStore = await freshStore();
    get.mockResolvedValueOnce({ data: { series: SERIES, episodes: [EPISODE], total: 1 } });

    const loaded = await useShowStore.getState().fetchOneSeries('series-abc');

    expect(get).toHaveBeenCalledWith('/shows/series/series-abc');
    expect(loaded?.id).toBe('series-abc');
    expect(useShowStore.getState().episodesBySeries['series-abc']?.[0]?.id).toBe('episode-xyz');
  });

  it('drops the cached episodes when the series goes', async () => {
    const useShowStore = await freshStore();
    get.mockResolvedValueOnce({ data: { series: SERIES, episodes: [EPISODE], total: 1 } });
    del.mockResolvedValueOnce({ data: { deleted: true } });

    await useShowStore.getState().fetchOneSeries('series-abc');
    await useShowStore.getState().deleteSeries('series-abc');

    // Left behind, a re-created series of the same id would show the old list.
    expect(useShowStore.getState().episodesBySeries['series-abc']).toBeUndefined();
  });
});

describe('starting an episode', () => {
  it('asks for another one with nothing to say, and sends a body anyway', async () => {
    const useShowStore = await freshStore();
    post.mockResolvedValueOnce({
      data: {
        episodeId: 'episode-new',
        seriesId: 'series-abc',
        episodeNumber: 3,
        // `null`, which is what the API stores for an episode nobody named.
        title: null,
        status: 'queued',
      },
    });

    const id = await useShowStore.getState().createEpisode('series-abc');

    /**
     * `{}`, not `undefined`. This is the whole change on this side: the button
     * asks for another episode and says nothing about it, because the series
     * already knows what the show is about.
     *
     * Asserted as the exact body rather than as "no topic", because the two
     * differ where it matters — a `POST` with no body at all reaches Express as
     * `req.body === undefined`, which is not the same request.
     */
    expect(post).toHaveBeenCalledWith('/shows/series/series-abc/episodes', {});
    expect(id).toBe('episode-new');

    const [first] = useShowStore.getState().episodesBySeries['series-abc'] ?? [];
    expect(first?.status).toBe('queued');
    expect(first?.episodeNumber).toBe(3);
    // No subject is INVENTED for the optimistic row. The script has not chosen
    // one yet, and a row claiming otherwise would show a subject that never
    // came from anywhere.
    expect(first?.topic).toBeUndefined();
  });

  it('still carries a subject and a name when the owner supplies them', async () => {
    // The positive control for the assertion above: a store that dropped every
    // input would satisfy "posts an empty body" perfectly.
    const useShowStore = await freshStore();
    post.mockResolvedValueOnce({
      data: {
        episodeId: 'episode-new',
        seriesId: 'series-abc',
        episodeNumber: 3,
        title: 'The Reckoning',
        status: 'queued',
      },
    });

    await useShowStore
      .getState()
      .createEpisode('series-abc', {
        title: 'The Reckoning',
        topic: 'hablemos de la fotosíntesis',
      });

    // No `notes: undefined` key either — the API distinguishes an absent field
    // from a present empty one.
    expect(post).toHaveBeenCalledWith('/shows/series/series-abc/episodes', {
      title: 'The Reckoning',
      topic: 'hablemos de la fotosíntesis',
    });

    const [first] = useShowStore.getState().episodesBySeries['series-abc'] ?? [];
    expect(first?.topic).toBe('hablemos de la fotosíntesis');
    expect(first?.title).toBe('The Reckoning');
  });

  it('holds no name for an episode nobody named, and shows the number instead', async () => {
    const useShowStore = await freshStore();
    post.mockResolvedValueOnce({
      data: {
        episodeId: 'episode-new',
        seriesId: 'series-abc',
        episodeNumber: 3,
        title: null,
        status: 'queued',
      },
    });

    await useShowStore.getState().createEpisode('series-abc');

    /**
     * `null` on the row and `Episode 3` on the screen, which are different
     * things. Storing the placeholder instead would be a name the database does
     * not hold and that nothing later replaces — and it is exactly what makes
     * "the owner chose this" and "nothing named it" indistinguishable.
     */
    const [first] = useShowStore.getState().episodesBySeries['series-abc'] ?? [];
    expect(first?.title).toBeNull();
    expect(first === undefined ? '' : episodeDisplayTitle(first)).toBe('Episode 3');
  });

  it('reports a refusal rather than pretending it started', async () => {
    const useShowStore = await freshStore();
    post.mockRejectedValueOnce({
      response: { data: { error: { message: 'Maximum 3 episodes generating at once.' } } },
    });

    const id = await useShowStore.getState().createEpisode('series-abc');

    expect(id).toBeNull();
    expect(useShowStore.getState().error).toContain('Maximum 3');
    // No optimistic row for an episode the server refused.
    expect(useShowStore.getState().episodesBySeries['series-abc']).toBeUndefined();
  });
});

describe('progress events', () => {
  it('moves the episode it names, inside the series it names', async () => {
    const useShowStore = await freshStore();
    get.mockResolvedValueOnce({ data: { series: SERIES, episodes: [EPISODE], total: 1 } });
    await useShowStore.getState().fetchOneSeries('series-abc');

    useShowStore.getState().updateProgress({
      episodeId: 'episode-xyz',
      seriesId: 'series-abc',
      status: 'generating_audio',
      progress: 42,
      currentStep: 'Recording...',
    });

    const [episode] = useShowStore.getState().episodesBySeries['series-abc'] ?? [];
    expect(episode?.status).toBe('generating_audio');
    expect(episode?.progress).toBe(42);
    expect(useShowStore.getState().activeGenerations.get('episode-xyz')?.progress).toBe(42);
  });

  it('renames the episode when the script does, mid-run', async () => {
    const useShowStore = await freshStore();
    get.mockResolvedValueOnce({
      data: {
        series: SERIES,
        episodes: [{ ...EPISODE, title: 'Episode 2', status: 'queued', progress: 0 }],
        total: 1,
      },
    });
    await useShowStore.getState().fetchOneSeries('series-abc');

    useShowStore.getState().updateProgress({
      episodeId: 'episode-xyz',
      seriesId: 'series-abc',
      status: 'generating_audio',
      progress: 15,
      currentStep: 'Recording...',
      title: 'What the deep sea is hiding',
    });

    /**
     * The API reserves the episode under `Episode {n}` and the script renames it
     * minutes before the run ends. Without this the row shows the placeholder
     * for the whole recording, even though the name already exists.
     */
    const [episode] = useShowStore.getState().episodesBySeries['series-abc'] ?? [];
    expect(episode?.title).toBe('What the deep sea is hiding');
  });

  it('leaves the name alone when an event carries none', async () => {
    // The positive control. Spreading the field unconditionally blanks the
    // title on every event an older API sends.
    const useShowStore = await freshStore();
    get.mockResolvedValueOnce({ data: { series: SERIES, episodes: [EPISODE], total: 1 } });
    await useShowStore.getState().fetchOneSeries('series-abc');

    useShowStore.getState().updateProgress({
      episodeId: 'episode-xyz',
      seriesId: 'series-abc',
      status: 'generating_audio',
      progress: 15,
      currentStep: 'Recording...',
    });

    const [episode] = useShowStore.getState().episodesBySeries['series-abc'] ?? [];
    expect(episode?.title).toBe('The second one');
  });

  it('stops tracking an episode once it finishes', async () => {
    const useShowStore = await freshStore();
    get.mockResolvedValueOnce({ data: { series: SERIES, episodes: [EPISODE], total: 1 } });
    await useShowStore.getState().fetchOneSeries('series-abc');

    useShowStore.getState().updateProgress({
      episodeId: 'episode-xyz',
      seriesId: 'series-abc',
      status: 'completed',
      progress: 100,
      currentStep: 'Ready',
    });

    // A finished episode is not "in flight", so the progress card stops
    // rendering over a player that is now usable.
    expect(useShowStore.getState().activeGenerations.has('episode-xyz')).toBe(false);
    expect(useShowStore.getState().episodesBySeries['series-abc']?.[0]?.status).toBe('completed');
  });

  it('ignores an event for a series whose episodes are not loaded', async () => {
    const useShowStore = await freshStore();

    useShowStore.getState().updateProgress({
      episodeId: 'episode-elsewhere',
      seriesId: 'series-not-open',
      status: 'generating_audio',
      progress: 10,
      currentStep: 'Recording...',
    });

    // Tracked, because the user may open that series in a moment — but no empty
    // list is invented for it, which would render as "no episodes yet" over a
    // series that has some.
    expect(useShowStore.getState().activeGenerations.has('episode-elsewhere')).toBe(true);
    expect(useShowStore.getState().episodesBySeries['series-not-open']).toBeUndefined();
  });
});

describe('preferences', () => {
  it('falls back to private and podcast when the request fails', async () => {
    const useShowStore = await freshStore();
    get.mockRejectedValueOnce(new Error('offline'));

    await useShowStore.getState().fetchPreferences();

    // The server's own defaults, restated here so the create dialog can show a
    // selection rather than nothing.
    expect(useShowStore.getState().preferences).toEqual({
      defaultVisibility: 'private',
      defaultFormat: 'podcast',
    });
  });
});
