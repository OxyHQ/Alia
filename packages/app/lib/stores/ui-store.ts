import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Message } from '@/lib/hooks/use-conversations';
import type { FailedTurn } from '@/components/chat/turn-failure';

type RightPanel = 'credits' | 'thought' | 'canvas' | 'agent' | null;

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
  shortcutsDialogOpen: boolean;
  canvasArtifacts: CanvasArtifact[];
  activeAgentSessionId: string | null;
  activeAgentId: string | null;
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
  openAgentPanel: (sessionId: string, agentId: string) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  toggleShortcutsDialog: () => void;
  addCanvasArtifact: (artifact: CanvasArtifact) => void;
  clearCanvasArtifacts: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
  sidebarOpen: true,
  rightPanel: null,
  thoughtMessageId: null,
  thoughtTab: "steps",
  thoughtScope: null,
  shortcutsDialogOpen: false,
  canvasArtifacts: [],
  activeAgentSessionId: null,
  activeAgentId: null,

  toggleSidebar: () =>
    set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setSidebarOpen: (open) =>
    set({ sidebarOpen: open }),

  setRightPanel: (panel) =>
    set({ rightPanel: panel, ...(panel === null && { thoughtMessageId: null, thoughtScope: null }) }),

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
      // The intro no longer records anything: whether somebody has met Alia is
      // whether they have an account, not what their browser remembers.
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
      }),
    },
  ),
);
