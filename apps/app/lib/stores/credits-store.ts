import { create } from 'zustand';
import apiClient from '@/lib/api/client';

interface CreditsState {
  credits: number;
  freeCredits: number;
  dailyRefresh: number;
  lastRefresh: Date | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchCredits: () => Promise<void>;
  updateCredits: (credits: number) => void;
  reset: () => void;
}

const initialState = {
  credits: 1000,
  freeCredits: 1000,
  dailyRefresh: 300,
  lastRefresh: null,
  isLoading: false,
  error: null,
};

export const useCreditsStore = create<CreditsState>((set) => ({
  ...initialState,

  fetchCredits: async () => {
    set({ isLoading: true, error: null });

    try {
      const response = await apiClient.get('/credits');

      set({
        credits: response.data.credits,
        freeCredits: response.data.freeCredits,
        dailyRefresh: response.data.dailyRefresh,
        lastRefresh: response.data.lastRefresh ? new Date(response.data.lastRefresh) : null,
        isLoading: false,
      });
    } catch (error: any) {
      // If not authenticated or any error, keep defaults
      if (error.response?.status === 401) {
        set({ isLoading: false });
        return;
      }
      console.error('Failed to fetch credits:', error);
      set({
        error: error.response?.data?.error || 'Failed to fetch credits',
        isLoading: false,
      });
    }
  },

  updateCredits: (credits: number) => {
    set({ credits });
  },

  reset: () => {
    set(initialState);
  },
}));
