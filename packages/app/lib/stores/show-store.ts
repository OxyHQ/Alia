/**
 * Show series and their episodes.
 *
 * ## `id`, never `_id`
 *
 * This store used to declare `_id` and the screen indexed `show._id`, in five
 * places. The API has answered `id` since the Postgres port, so every one of
 * those reads was `undefined` — which does not throw: `keyExtractor` returned
 * undefined for every row, and a delete posted to `/v1/shows/undefined`. A
 * Mongo leftover that survived because nothing about it looks broken until you
 * check what the server actually sends.
 *
 * ## The audio is Syra's, so no `audioUrl` reaches here
 *
 * An episode carries `syraEpisodeId` and nothing else about its media. What is
 * playable, and by whom, is Syra's decision and is resolved at play time by
 * `components/show/episode-player.tsx`.
 */

import { create } from 'zustand';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';
import { errorMessage as getErrorMessage } from '../errors/error-utils';

export type ShowFormat = 'podcast' | 'news' | 'debate' | 'interview' | 'explainer';
export type ShowVisibility = 'private' | 'unlisted' | 'public';
export type ShowEpisodeStatus =
  | 'queued'
  | 'generating_script'
  | 'generating_audio'
  | 'concatenating'
  | 'publishing'
  | 'completed'
  | 'failed';

/** The statuses that mean an episode is still being produced. */
export const ACTIVE_EPISODE_STATUSES: readonly ShowEpisodeStatus[] = [
  'queued',
  'generating_script',
  'generating_audio',
  'concatenating',
  'publishing',
];

export interface ShowSpeaker {
  name: string;
  voiceId: string;
  voiceName: string;
  role: string;
}

export interface ShowSeries {
  id: string;
  userId: string;
  syraPodcastId: string;
  title: string;
  description?: string | null;
  format: ShowFormat;
  brief: string;
  speakers: ShowSpeaker[];
  visibility: ShowVisibility;
  coverImageAssetId?: string | null;
  nextEpisodeNumber: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShowEpisode {
  id: string;
  seriesId: string;
  episodeNumber: number;
  title: string;
  topic: string;
  notes?: string | null;
  status: ShowEpisodeStatus;
  progress: number;
  error?: string | null;
  creditsCharged?: number | null;
  /** Syra's id. What makes an episode playable, once it has one. */
  syraEpisodeId?: string | null;
  recap?: string | null;
  durationMs?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShowVoice {
  voiceId: string;
  name: string;
  gender: 'male' | 'female';
  accent: string;
  description: string;
}

export interface ShowProgress {
  episodeId: string;
  seriesId: string;
  status: string;
  progress: number;
  currentStep: string;
  segmentIndex?: number;
  totalSegments?: number;
}

export interface ShowPreferences {
  defaultVisibility: ShowVisibility;
  defaultFormat: ShowFormat;
}

interface ShowStore {
  series: ShowSeries[];
  /** Episodes of the series currently open, keyed by series id. */
  episodesBySeries: Record<string, ShowEpisode[]>;
  loading: boolean;
  error: string | null;
  voices: ShowVoice[];
  preferences: ShowPreferences | null;

  /** In-flight generations, keyed by episode id. */
  activeGenerations: Map<string, ShowProgress>;

  fetchSeries: () => Promise<void>;
  fetchOneSeries: (id: string) => Promise<ShowSeries | null>;
  createSeries: (input: {
    title: string;
    brief: string;
    description?: string;
    format?: ShowFormat;
    visibility?: ShowVisibility;
  }) => Promise<string | null>;
  updateSeries: (
    id: string,
    patch: {
      title?: string;
      brief?: string;
      description?: string;
      visibility?: ShowVisibility;
      regenerateCover?: boolean;
    },
  ) => Promise<boolean>;
  deleteSeries: (id: string) => Promise<void>;

  createEpisode: (
    seriesId: string,
    input: { title: string; topic: string; notes?: string },
  ) => Promise<string | null>;
  deleteEpisode: (seriesId: string, episodeId: string) => Promise<void>;

  fetchVoices: () => Promise<void>;
  fetchPreferences: () => Promise<void>;
  savePreferences: (next: ShowPreferences) => Promise<void>;
  updateProgress: (progress: ShowProgress) => void;
  clearError: () => void;
}

export const useShowStore = create<ShowStore>((set, get) => ({
  series: [],
  episodesBySeries: {},
  loading: false,
  error: null,
  voices: [],
  preferences: null,
  activeGenerations: new Map(),

  fetchSeries: async () => {
    set({ loading: true, error: null });
    try {
      const res = await apiClient.get(API_ROUTES.shows.series.list);
      set({ series: res.data.series, loading: false });
    } catch (err: unknown) {
      set({ error: getErrorMessage(err, 'Failed to load your shows'), loading: false });
    }
  },

  fetchOneSeries: async (id) => {
    try {
      const res = await apiClient.get(API_ROUTES.shows.series.get(id));
      const { series, episodes } = res.data as { series: ShowSeries; episodes: ShowEpisode[] };

      set((state) => ({
        series: state.series.some((s) => s.id === id)
          ? state.series.map((s) => (s.id === id ? series : s))
          : [series, ...state.series],
        episodesBySeries: { ...state.episodesBySeries, [id]: episodes },
      }));

      return series;
    } catch (err: unknown) {
      set({ error: getErrorMessage(err, 'Failed to load that show') });
      return null;
    }
  },

  createSeries: async (input) => {
    set({ error: null });
    try {
      const res = await apiClient.post(API_ROUTES.shows.series.create, input);
      const series = res.data as ShowSeries;
      set((state) => ({ series: [series, ...state.series] }));
      return series.id;
    } catch (err: unknown) {
      set({ error: getErrorMessage(err, 'Failed to create the show') });
      return null;
    }
  },

  updateSeries: async (id, patch) => {
    try {
      const res = await apiClient.patch(API_ROUTES.shows.series.update(id), patch);
      const updated = res.data as ShowSeries;
      set((state) => ({ series: state.series.map((s) => (s.id === id ? updated : s)) }));
      return true;
    } catch (err: unknown) {
      set({ error: getErrorMessage(err, 'Failed to update the show') });
      return false;
    }
  },

  deleteSeries: async (id) => {
    try {
      await apiClient.delete(API_ROUTES.shows.series.delete(id));
      set((state) => {
        // The episodes go with it, so the cache entry goes too — leaving it
        // would make a re-created series of the same id show the old list.
        const { [id]: _removed, ...rest } = state.episodesBySeries;
        return { series: state.series.filter((s) => s.id !== id), episodesBySeries: rest };
      });
    } catch (err: unknown) {
      set({ error: getErrorMessage(err, 'Failed to delete the show') });
    }
  },

  createEpisode: async (seriesId, input) => {
    set({ error: null });
    try {
      const res = await apiClient.post(API_ROUTES.shows.episodes.create(seriesId), input);
      const { episodeId, episodeNumber } = res.data as {
        episodeId: string;
        episodeNumber: number;
      };

      // A placeholder, so the list shows the episode as queued immediately
      // rather than after the next poll. The pipeline's first progress event
      // replaces it.
      const now = new Date().toISOString();
      const placeholder: ShowEpisode = {
        id: episodeId,
        seriesId,
        episodeNumber,
        title: input.title,
        topic: input.topic,
        status: 'queued',
        progress: 0,
        createdAt: now,
        updatedAt: now,
      };

      set((state) => ({
        episodesBySeries: {
          ...state.episodesBySeries,
          [seriesId]: [placeholder, ...(state.episodesBySeries[seriesId] ?? [])],
        },
      }));

      return episodeId;
    } catch (err: unknown) {
      set({ error: getErrorMessage(err, 'Failed to start the episode') });
      return null;
    }
  },

  deleteEpisode: async (seriesId, episodeId) => {
    try {
      await apiClient.delete(API_ROUTES.shows.episodes.delete(episodeId));
      set((state) => ({
        episodesBySeries: {
          ...state.episodesBySeries,
          [seriesId]: (state.episodesBySeries[seriesId] ?? []).filter((e) => e.id !== episodeId),
        },
      }));
    } catch (err: unknown) {
      set({ error: getErrorMessage(err, 'Failed to delete the episode') });
    }
  },

  fetchVoices: async () => {
    try {
      const res = await apiClient.get(API_ROUTES.shows.voices);
      set({ voices: res.data.voices });
    } catch (err: unknown) {
      // Voices are an optional enhancement; keep any previously loaded list
      // rather than blocking the UI with an error state.
      set({ error: getErrorMessage(err, 'Could not load the voice list') });
    }
  },

  fetchPreferences: async () => {
    try {
      const res = await apiClient.get(API_ROUTES.shows.preferences);
      set({ preferences: res.data as ShowPreferences });
    } catch {
      // The server's own defaults apply when this fails, and the create screen
      // states them; a failure here is not worth an error banner.
      set({ preferences: { defaultVisibility: 'private', defaultFormat: 'podcast' } });
    }
  },

  savePreferences: async (next) => {
    try {
      const res = await apiClient.put(API_ROUTES.shows.preferences, next);
      set({ preferences: res.data as ShowPreferences });
    } catch (err: unknown) {
      set({ error: getErrorMessage(err, 'Failed to save your preferences') });
    }
  },

  updateProgress: (progress) => {
    set((state) => {
      const existing = state.activeGenerations.get(progress.episodeId);
      if (
        existing &&
        existing.progress === progress.progress &&
        existing.status === progress.status
      ) {
        return state;
      }

      const nextActive = new Map(state.activeGenerations);
      nextActive.set(progress.episodeId, progress);

      const episodes = state.episodesBySeries[progress.seriesId];
      const nextEpisodes = episodes?.map((episode) =>
        episode.id === progress.episodeId
          ? {
              ...episode,
              status: progress.status as ShowEpisodeStatus,
              progress: progress.progress,
            }
          : episode,
      );

      // A finished episode is no longer "in flight". Its final shape comes from
      // the refetch the listener triggers, not from this event.
      if (progress.status === 'completed' || progress.status === 'failed') {
        nextActive.delete(progress.episodeId);
      }

      return {
        activeGenerations: nextActive,
        episodesBySeries:
          nextEpisodes === undefined
            ? state.episodesBySeries
            : { ...state.episodesBySeries, [progress.seriesId]: nextEpisodes },
      };
    });
  },

  clearError: () => set({ error: null }),
}));

/** The episodes of one series, or an empty list. A stable reference per series. */
export function useSeriesEpisodes(seriesId: string): ShowEpisode[] {
  return useShowStore((state) => state.episodesBySeries[seriesId]) ?? EMPTY_EPISODES;
}

/**
 * One shared empty array, so a series with no episodes yet does not hand the
 * selector a new `[]` on every render and re-render the list forever.
 */
const EMPTY_EPISODES: ShowEpisode[] = [];
