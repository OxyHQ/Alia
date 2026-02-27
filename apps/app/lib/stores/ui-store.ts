import { create } from 'zustand';
import type { Message } from '@/lib/hooks/use-conversations';

type RightPanel = 'credits' | 'thought' | 'canvas' | null;

export interface CanvasArtifact {
  id: string;
  type: 'code' | 'markdown' | 'table' | 'chart' | 'image';
  content: any;
  title?: string;
  timestamp: number;
}

interface UIState {
  sidebarOpen: boolean;
  rightPanel: RightPanel;
  thoughtMessageId: string | null;
  thoughtMessages: Message[];
  shortcutsDialogOpen: boolean;
  canvasArtifacts: CanvasArtifact[];

  // Actions
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setRightPanel: (panel: RightPanel) => void;
  toggleRightPanel: (panel: RightPanel) => void;
  openThoughtPanel: (messageId: string) => void;
  setThoughtMessages: (messages: Message[]) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  toggleShortcutsDialog: () => void;
  addCanvasArtifact: (artifact: CanvasArtifact) => void;
  clearCanvasArtifacts: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: false,
  rightPanel: null,
  thoughtMessageId: null,
  thoughtMessages: [],
  shortcutsDialogOpen: false,
  canvasArtifacts: [],

  toggleSidebar: () =>
    set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setSidebarOpen: (open) =>
    set({ sidebarOpen: open }),

  setRightPanel: (panel) =>
    set({ rightPanel: panel, ...(panel === null && { thoughtMessageId: null }) }),

  toggleRightPanel: (panel) =>
    set((state) => ({
      rightPanel: state.rightPanel === panel ? null : panel,
      ...(state.rightPanel === panel && { thoughtMessageId: null }),
    })),

  openThoughtPanel: (messageId) =>
    set({ rightPanel: 'thought', thoughtMessageId: messageId }),

  setThoughtMessages: (messages) =>
    set({ thoughtMessages: messages }),

  setShortcutsDialogOpen: (open) =>
    set({ shortcutsDialogOpen: open }),

  toggleShortcutsDialog: () =>
    set((state) => ({ shortcutsDialogOpen: !state.shortcutsDialogOpen })),

  addCanvasArtifact: (artifact) =>
    set((state) => ({ canvasArtifacts: [...state.canvasArtifacts, artifact] })),

  clearCanvasArtifacts: () =>
    set({ canvasArtifacts: [] }),
}));
