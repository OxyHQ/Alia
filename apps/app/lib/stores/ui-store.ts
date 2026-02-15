import { create } from 'zustand';

type RightPanel = 'credits' | null;

interface UIState {
  sidebarOpen: boolean;
  rightPanel: RightPanel;

  // Actions
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setRightPanel: (panel: RightPanel) => void;
  toggleRightPanel: (panel: RightPanel) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: false,
  rightPanel: null,

  toggleSidebar: () =>
    set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setSidebarOpen: (open) =>
    set({ sidebarOpen: open }),

  setRightPanel: (panel) =>
    set({ rightPanel: panel }),

  toggleRightPanel: (panel) =>
    set((state) => ({
      rightPanel: state.rightPanel === panel ? null : panel,
    })),
}));
