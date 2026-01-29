import { create } from 'zustand';

type RightPanel = 'credits' | null;

interface UIState {
  sidebarOpen: boolean;
  theme: 'light' | 'dark' | 'system';
  rightPanel: RightPanel;

  // Actions
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setRightPanel: (panel: RightPanel) => void;
  toggleRightPanel: (panel: RightPanel) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: false,
  theme: 'system',
  rightPanel: null,

  toggleSidebar: () =>
    set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setSidebarOpen: (open) =>
    set({ sidebarOpen: open }),

  setTheme: (theme) =>
    set({ theme }),

  setRightPanel: (panel) =>
    set({ rightPanel: panel }),

  toggleRightPanel: (panel) =>
    set((state) => ({
      rightPanel: state.rightPanel === panel ? null : panel,
    })),
}));
