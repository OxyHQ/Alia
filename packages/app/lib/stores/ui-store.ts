import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ContextUsage } from '@/lib/chat/context-usage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Message } from '@/lib/hooks/use-conversations';
import type { FailedTurn } from '@/components/chat/turn-failure';

export type RightPanel = 'credits' | 'thought' | 'canvas' | 'gallery' | 'agent' | null;

/** The panel's tabs. The store owns them because it owns which one opens. */
export type ThoughtTab = 'steps' | 'sources' | 'activity';

/**
 * Whether the conversation a thought selection belongs to has its messages
 * yet. `loading` is the seeded-then-upgraded window in which a message can be
 * on screen without its tool history; `failed` is a load that will not
 * arrive. The panel shows each as itself instead of as "no steps".
 */
export type ThoughtScopeStatus = 'loading' | 'ready' | 'failed';

/**
 * The conversation a thought selection was made in, as the panel reads it.
 *
 * ## Why the messages travel WITH the selection
 *
 * The panel used to read one global `thoughtMessages` array that the chat
 * screen copied into only while the panel was open. So the first press on a
 * tool row rendered against whatever the array held — the previous
 * conversation, or nothing — and found no message by id: three empty tabs
 * under five visible tool rows. And with the new-chat screen mounted under a
 * conversation, TWO chat screens raced to write the array, and the empty one
 * could win.
 *
 * Now a selection names its conversation and carries that conversation's
 * messages, written in the same store update as the message id, and a later
 * sync is accepted only from the SAME conversation. A screen showing another
 * conversation cannot blank what was opened from this one.
 */
export interface ThoughtScope {
  /** `null` for a conversation that has not been created yet — the first turn on the new-chat screen. */
  conversationId: string | null;
  messages: Message[];
  status: ThoughtScopeStatus;
  /** The streaming hook's `isLoading` for this conversation: a turn is in flight. */
  isLoading: boolean;
  /** The turn that got no answer in this conversation, or `null`. */
  failedTurn: FailedTurn | null;
}

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
  rightPanel: RightPanel;
  thoughtMessageId: string | null;
  /**
   * Which tab the panel opens on. A caller that already knows what the reader
   * asked for — the Sources row under an answer — says so, instead of landing
   * them on Steps to go hunting.
   */
  thoughtTab: ThoughtTab;
  /** The conversation the selected message lives in, or `null` with nothing selected. */
  thoughtScope: ThoughtScope | null;
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
  /**
   * Open the panel on a message, with the conversation it was pressed in.
   * One update: there is no render in which the id is set and the messages
   * are not.
   */
  openThoughtPanel: (messageId: string, scope: ThoughtScope, tab?: ThoughtTab) => void;
  setThoughtTab: (tab: ThoughtTab) => void;
  /**
   * The chat screen's newest view of a conversation. Taken only when it is the
   * conversation the open selection belongs to; every other screen's write is
   * dropped, which is what keeps a second mounted chat from blanking the panel.
   */
  syncThoughtScope: (scope: ThoughtScope) => void;
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
      contextUsage: conversationId === null ? state.contextUsage : { ...state.contextUsage, [conversationId]: usage },
    })),
  thoughtMessageId: null,
  thoughtTab: "steps",
  thoughtScope: null,
  shortcutsDialogOpen: false,
  canvasArtifacts: [],
  activeAgentSessionId: null,
  activeAgentId: null,
  activeAgentConversationId: null,
  agentTerminal: null,
  codePanelView: 'changes',
  rightPanelWidth: RIGHT_PANEL_DEFAULT_WIDTH,

  toggleSidebar: () =>
    set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setSidebarOpen: (open) =>
    set({ sidebarOpen: open }),

  setRightPanel: (panel) =>
    set({
      rightPanel: panel,
      ...(panel === null && { thoughtMessageId: null, thoughtScope: null, codePanelView: 'changes' as const }),
    }),

  toggleRightPanel: (panel) =>
    set((state) => ({
      rightPanel: state.rightPanel === panel ? null : panel,
      ...(state.rightPanel === panel && { thoughtMessageId: null, thoughtScope: null }),
    })),

  openThoughtPanel: (messageId, scope, tab = 'steps') =>
    set({ rightPanel: 'thought', thoughtMessageId: messageId, thoughtScope: scope, thoughtTab: tab }),

  setThoughtTab: (tab) => set({ thoughtTab: tab }),

  syncThoughtScope: (scope) => {
    const current = get().thoughtScope;
    if (current === null || current.conversationId !== scope.conversationId) return;
    if (
      current.messages === scope.messages &&
      current.status === scope.status &&
      current.isLoading === scope.isLoading &&
      current.failedTurn === scope.failedTurn
    ) return;
    set({ thoughtScope: scope });
  },

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

  setShortcutsDialogOpen: (open) =>
    set({ shortcutsDialogOpen: open }),

  toggleShortcutsDialog: () =>
    set((state) => ({ shortcutsDialogOpen: !state.shortcutsDialogOpen })),

  addCanvasArtifact: (artifact) =>
    set((state) => ({ canvasArtifacts: [...state.canvasArtifacts, artifact] })),

  clearCanvasArtifacts: () =>
    set({ canvasArtifacts: [] }),

  setRightPanelWidth: (width) =>
    set({ rightPanelWidth: clampRightPanelWidth(width) }),
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
