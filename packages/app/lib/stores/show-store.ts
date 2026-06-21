import { create } from 'zustand';
import apiClient from '../api/client';
import { API_ROUTES } from '../api/routes';

export type ShowFormat = 'podcast' | 'news' | 'debate' | 'interview' | 'explainer';
export type ShowStatus = 'queued' | 'generating_script' | 'generating_audio' | 'concatenating' | 'completed' | 'failed';

export interface ShowSpeaker {
  name: string;
  voiceId: string;
  voiceName: string;
  role: string;
}

export interface ShowSegment {
  index: number;
  speaker: string;
  text: string;
  audioUrl?: string;
  durationMs?: number;
  type: 'dialogue' | 'sfx' | 'transition';
  sfxPrompt?: string;
}

export interface Show {
  _id: string;
  userId: string;
  title: string;
  description?: string;
  topic: string;
  format: ShowFormat;
  status: ShowStatus;
  speakers: ShowSpeaker[];
  segments: ShowSegment[];
  audioUrl?: string;
  durationMs?: number;
  error?: string;
  creditsCharged?: number;
  progress: number;
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
  showId: string;
  status: string;
  progress: number;
  currentStep: string;
  segmentIndex?: number;
  totalSegments?: number;
}

interface ShowStore {
  shows: Show[];
  loading: boolean;
  error: string | null;
  voices: ShowVoice[];

  // Active generation tracking
  activeGenerations: Map<string, ShowProgress>;

  fetchShows: () => Promise<void>;
  fetchShow: (id: string) => Promise<Show | null>;
  generateShow: (params: {
    topic: string;
    format?: ShowFormat;
    sourceNotes?: string;
  }) => Promise<string | null>;
  deleteShow: (id: string) => Promise<void>;
  fetchVoices: () => Promise<void>;
  updateProgress: (progress: ShowProgress) => void;
  clearError: () => void;
}

export const useShowStore = create<ShowStore>((set, get) => ({
  shows: [],
  loading: false,
  error: null,
  voices: [],
  activeGenerations: new Map(),

  fetchShows: async () => {
    set({ loading: true, error: null });
    try {
      const res = await apiClient.get(API_ROUTES.v1.shows.list);
      set({ shows: res.data.shows, loading: false });
    } catch (err: any) {
      set({ error: err.response?.data?.error?.message || 'Failed to load shows', loading: false });
    }
  },

  fetchShow: async (id) => {
    try {
      const res = await apiClient.get(API_ROUTES.v1.shows.get(id));
      const show = res.data as Show;

      // Update in list if present
      set(state => ({
        shows: state.shows.map(s => s._id === id ? show : s),
      }));

      return show;
    } catch {
      return null;
    }
  },

  generateShow: async (params) => {
    set({ error: null });
    try {
      const res = await apiClient.post(API_ROUTES.v1.shows.generate, params);
      const { showId } = res.data;

      // Add a placeholder show to the list
      set(state => ({
        shows: [{
          _id: showId,
          userId: '',
          title: `Show: ${params.topic.slice(0, 80)}`,
          topic: params.topic,
          format: params.format || 'podcast',
          status: 'queued' as ShowStatus,
          speakers: [],
          segments: [],
          progress: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, ...state.shows],
      }));

      return showId;
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || 'Failed to generate show';
      set({ error: msg });
      return null;
    }
  },

  deleteShow: async (id) => {
    try {
      await apiClient.delete(API_ROUTES.v1.shows.delete(id));
      set(state => ({
        shows: state.shows.filter(s => s._id !== id),
      }));
    } catch (err: any) {
      set({ error: err.response?.data?.error?.message || 'Failed to delete show' });
    }
  },

  fetchVoices: async () => {
    try {
      const res = await apiClient.get(API_ROUTES.v1.shows.voices);
      set({ voices: res.data.voices });
    } catch {}
  },

  updateProgress: (progress) => {
    set(state => {
      // Skip no-op updates
      const existing = state.activeGenerations.get(progress.showId);
      if (existing && existing.progress === progress.progress && existing.status === progress.status) {
        return state;
      }

      const newMap = new Map(state.activeGenerations);
      newMap.set(progress.showId, progress);

      // Update show status in list
      const shows = state.shows.map(s => {
        if (s._id === progress.showId) {
          if (s.status === progress.status && s.progress === progress.progress) return s;
          return {
            ...s,
            status: progress.status as ShowStatus,
            progress: progress.progress,
          };
        }
        return s;
      });

      // Remove from active tracking when completed or failed
      if (progress.status === 'completed' || progress.status === 'failed') {
        newMap.delete(progress.showId);
      }

      return { activeGenerations: newMap, shows };
    });
  },

  clearError: () => set({ error: null }),
}));
