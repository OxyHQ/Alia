import { create } from 'zustand';

export type TTSPlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

interface TTSStore {
  activeMessageId: string | null;
  playbackState: TTSPlaybackState;
  error: string | null;

  setActiveMessage: (messageId: string | null) => void;
  setPlaybackState: (state: TTSPlaybackState) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useTTSStore = create<TTSStore>((set) => ({
  activeMessageId: null,
  playbackState: 'idle',
  error: null,

  setActiveMessage: (messageId) => set({ activeMessageId: messageId }),
  setPlaybackState: (state) => set({ playbackState: state }),
  setError: (error) => set({ error, playbackState: 'error' }),
  reset: () => set({ activeMessageId: null, playbackState: 'idle', error: null }),
}));
