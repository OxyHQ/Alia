import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ContextUsage } from '@/features/chat/model/context-usage';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type RightPanel = 'credits' | 'thought' | 'canvas' | 'gallery' | 'agent' | null;

/**
 * The agent whose terminal the code panel can show, and the route it was
 * opened from.
 *
 * Keyed by the ROUTE rather than held globally: the panel is the layout's and
 * outlives a navigation, so a terminal opened in one agent's chat would
 * otherwise keep streaming that agent's activity beside the next chat. The
 * panel offers it only while the route is the one it was opened on (#608 §5,
 * selection identity).
 */
export interface AgentTerminalSelection {
  agentId: string;
  route: string;
}

/**
 * What the code panel shows: its changes, or its second tab — the canvas
 * preview, or the agent's terminal in the same slot.
 */
export type CodePanelView = 'changes' | 'preview' | 'terminal';

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
  /**
   * Which panel the right slot shows. The thought panel's selection (which turn, which tab) is the
   * SDK's `useThoughtStore`: the thread selects, this only says the panel is on show.
   */
  rightPanel: RightPanel;
  /**
   * What each conversation's latest turn put in the context window, by
   * conversation id, as the `alia.context` event reported it; and the latest of
   * any, for Settings › Usage. Session state: a reload shows it again after the
   * next turn.
   */
  contextUsage: Record<string, ContextUsage>;
  lastContextUsage: ContextUsage | null;
  setContextUsage: (conversationId: string | null, usage: ContextUsage) => void;
  shortcutsDialogOpen: boolean;
  canvasArtifacts: CanvasArtifact[];
  activeAgentSessionId: string | null;
  activeAgentId: string | null;
  /** The conversation whose turn opened the active agent session, when one did. */
  activeAgentConversationId: string | null;
  agentTerminal: AgentTerminalSelection | null;
  codePanelView: CodePanelView;
  /**
   * Whether the intro screen has been answered on this device — by signing in
   * or by choosing to continue without an account. Persisted, so the home
   * route only ever redirects to /welcome on a genuine first run.
   */

  // Actions
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setRightPanel: (panel: RightPanel) => void;
  toggleRightPanel: (panel: RightPanel) => void;
  openAgentPanel: (sessionId: string, agentId: string, conversationId?: string | null) => void;
  /** Open the code panel on this agent's terminal, for the route it was asked for on. */
  openAgentTerminal: (agentId: string, route: string) => void;
  setCodePanelView: (view: CodePanelView) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  toggleShortcutsDialog: () => void;
  addCanvasArtifact: (artifact: CanvasArtifact) => void;
  clearCanvasArtifacts: () => void;

  /**
   * How wide the right panel is, in px, on a screen wide enough to show it
   * beside the chat.
   *
   * It used to be two constants — 320, or 420 when an agent was in it — so the
   * execution panel, the canvas and the agent were each whatever width somebody
   * picked once. #608 §5 asks for "panel lateral y redimensionado coherentes
   * con el template", and the template's panel is dragged.
   *
   * One width for every kind of panel rather than one per kind: the drag is the
   * reader's statement about how they want their screen divided, and it would
   * be a strange kind of memory that forgot it because the panel now holds a
   * different thing.
   */
  rightPanelWidth: number;
  setRightPanelWidth: (width: number) => void;
}

/** What the drag is clamped to. Bloom's own handle defaults to the same range. */
export const RIGHT_PANEL_MIN_WIDTH = 320;
export const RIGHT_PANEL_MAX_WIDTH = 560;
/** Bloom's `AiChatShell` default, the template's panel width. */
export const RIGHT_PANEL_DEFAULT_WIDTH = 410;

/** Keeps a restored or dragged width inside the range the layout can honour. */
export function clampRightPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return RIGHT_PANEL_DEFAULT_WIDTH;
  return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)));
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      sidebarOpen: true,
      rightPanel: null,
      contextUsage: {},
      lastContextUsage: null,
      setContextUsage: (conversationId, usage) =>
        set((state) => ({
          lastContextUsage: usage,
          contextUsage:
            conversationId === null
              ? state.contextUsage
              : { ...state.contextUsage, [conversationId]: usage },
        })),
      shortcutsDialogOpen: false,
      canvasArtifacts: [],
      activeAgentSessionId: null,
      activeAgentId: null,
      activeAgentConversationId: null,
      agentTerminal: null,
      codePanelView: 'changes',
      rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH,

      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      setSidebarOpen: (open) => set({ sidebarOpen: open }),

      setRightPanel: (panel) =>
        set({
          rightPanel: panel,
          ...(panel === null && { codePanelView: 'changes' as const }),
        }),

      toggleRightPanel: (panel) =>
        set((state) => ({ rightPanel: state.rightPanel === panel ? null : panel })),

      openAgentPanel: (sessionId, agentId, conversationId = null) =>
        set({
          rightPanel: 'agent',
          activeAgentSessionId: sessionId,
          activeAgentId: agentId,
          activeAgentConversationId: conversationId,
        }),

      openAgentTerminal: (agentId, route) =>
        set({ rightPanel: 'canvas', agentTerminal: { agentId, route }, codePanelView: 'terminal' }),

      setCodePanelView: (view) => set({ codePanelView: view }),

      setShortcutsDialogOpen: (open) => set({ shortcutsDialogOpen: open }),

      toggleShortcutsDialog: () =>
        set((state) => ({ shortcutsDialogOpen: !state.shortcutsDialogOpen })),

      addCanvasArtifact: (artifact) =>
        set((state) => ({ canvasArtifacts: [...state.canvasArtifacts, artifact] })),

      clearCanvasArtifacts: () => set({ canvasArtifacts: [] }),

      setRightPanelWidth: (width) => set({ rightPanelWidth: clampRightPanelWidth(width) }),
    }),
    {
      name: 'alia-ui',
      storage: createJSONStorage(() => AsyncStorage),
      // Only the sidebar collapse survives reloads; the rest is session state.
      // The intro no longer records anything: whether somebody has met Alia is
      // whether they have an account, not what their browser remembers.
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        rightPanelWidth: state.rightPanelWidth,
      }),
      /**
       * A width written by an older build, or by hand, is clamped on the way
       * back in. Restoring 4000 would push the chat off the screen with no way
       * to drag it back, because the handle lives on the panel's edge.
       */
      merge: (persisted, current) => {
        const saved = persisted as Partial<UIState> | undefined;
        return {
          ...current,
          ...saved,
          rightPanelWidth: clampRightPanelWidth(
            saved?.rightPanelWidth ?? RIGHT_PANEL_DEFAULT_WIDTH,
          ),
        };
      },
    },
  ),
);
