import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Message } from '@/lib/hooks/use-conversations';

type RightPanel = 'credits' | 'thought' | 'canvas' | 'agent' | null;

export interface CanvasArtifact {
  id: string;
  type: 'code' | 'markdown' | 'table' | 'chart' | 'image';
  content: any;
  title?: string;
  timestamp: number;
}

interface UIState {
  /** Desktop sidebar expanded/collapsed. Mobile uses the drawer's own state. */
  sidebarOpen: boolean;
  rightPanel: RightPanel;
  thoughtMessageId: string | null;
  thoughtMessages: Message[];
  shortcutsDialogOpen: boolean;
  canvasArtifacts: CanvasArtifact[];
  activeAgentSessionId: string | null;
  activeAgentId: string | null;

  // Actions
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setRightPanel: (panel: RightPanel) => void;
  toggleRightPanel: (panel: RightPanel) => void;
  openThoughtPanel: (messageId: string) => void;
  setThoughtMessages: (messages: Message[]) => void;
  openAgentPanel: (sessionId: string, agentId: string) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  toggleShortcutsDialog: () => void;
  addCanvasArtifact: (artifact: CanvasArtifact) => void;
  clearCanvasArtifacts: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
  sidebarOpen: true,
  rightPanel: null,
  thoughtMessageId: null,
  thoughtMessages: [],
  shortcutsDialogOpen: false,
  canvasArtifacts: [],
  activeAgentSessionId: null,
  activeAgentId: null,

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

  openAgentPanel: (sessionId, agentId) =>
    set({ rightPanel: 'agent', activeAgentSessionId: sessionId, activeAgentId: agentId }),

  setShortcutsDialogOpen: (open) =>
    set({ shortcutsDialogOpen: open }),

  toggleShortcutsDialog: () =>
    set((state) => ({ shortcutsDialogOpen: !state.shortcutsDialogOpen })),

  addCanvasArtifact: (artifact) =>
    set((state) => ({ canvasArtifacts: [...state.canvasArtifacts, artifact] })),

  clearCanvasArtifacts: () =>
    set({ canvasArtifacts: [] }),
}),
    {
      name: 'alia-ui',
      storage: createJSONStorage(() => AsyncStorage),
      // Only the sidebar collapse survives reloads; the rest is session state.
      partialize: (state) => ({ sidebarOpen: state.sidebarOpen }),
    },
  ),
);
