import { useIsNavInFlow } from '@/components/app-shell/metrics';
import { NavRegion } from '@/components/app-shell/nav-region';
import { ShellNavProvider } from '@/components/app-shell/shell-nav';
import { CommandPalette } from '@/components/command-palette';
import { AppErrorBoundary } from '@/components/error-boundary';
import { restoreOpenerFocus } from '@/components/execution/focus-return';
import { KeyboardShortcutsDialog } from '@/components/keyboard-shortcuts-dialog';
import { RightPanel } from '@/components/right-panel';
import { AliaSettingsProvider } from '@/components/settings/alia-settings';
import { Sidebar } from '@/components/sidebar';
import { useLocalRuntime } from '@/lib/hooks/use-local-runtime';
import { useNotificationSetup } from '@/lib/hooks/use-notification-setup';
import { useWelcomeSuggestions } from '@/lib/hooks/use-suggestions';
import i18n from '@/lib/i18n';
import { useFavoritesStore } from '@/lib/stores/favorites-store';
import { useFoldersStore } from '@/lib/stores/folders-store';
import { usePinnedStore } from '@/lib/stores/pinned-store';
import { useProjectsStore } from '@/lib/stores/projects-store';
import { useUIStore } from '@/lib/stores/ui-store';
import { AiChatShell } from '@oxy.so/bloom/ai-chat';
import { useOxy } from '@oxy.so/services';
import { Stack } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Routes that handle their own top safe area insets
const SELF_INSET_ROUTES = new Set([
  'index',
  'c/[id]/index',
  '[username]',
  'settings',
]);

export default function AppLayout() {
  /** 1024: whether the nav is a column. `AiChatShell` decides this; see `metrics.ts`. */
  const navInFlow = useIsNavInFlow();
  const insets = useSafeAreaInsets();
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const loadFolders = useFoldersStore((state) => state.loadFolders);
  const loadFavorites = useFavoritesStore((state) => state.loadFavorites);
  const loadPinned = usePinnedStore((state) => state.loadPinned);
  const rightPanel = useUIStore((state) => state.rightPanel);
  const setRightPanel = useUIStore((state) => state.setRightPanel);
  const rightPanelWidth = useUIStore((state) => state.rightPanelWidth);
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);

  // Prefetch welcome suggestions so they're ready before any chat screen mounts
  useWelcomeSuggestions();

  // Push notification registration, tap handling, and real-time subscription
  useNotificationSetup();

  /**
   * Offer this device's own models to the account, if the person turned that on.
   *
   * Mounted here and only here: it holds ONE socket that answers provider
   * requests for a local model, and a second copy would be a second socket
   * announcing the same runtime.
   */
  useLocalRuntime();

  // Load projects, folders, favorites, and pinned for the signed-in account,
  // and again whenever it changes. Each store namespaces its storage by this
  // id and discards a load that resolves after the id moved on, so switching
  // profiles never shows one account's collections under another (#547).
  const { user } = useOxy();
  const userId = user?.id ?? null;
  useEffect(() => {
    loadProjects(userId);
    loadFolders(userId);
    loadFavorites(userId);
    loadPinned(userId);
  }, [userId, loadProjects, loadFolders, loadFavorites, loadPinned]);

  /**
   * The nav, once, for both of the shell's slots.
   *
   * The shell renders `sidebar` from `lg` up and `mobileSidebar` below it, and
   * never both, so one element serves both without ever being mounted twice.
   * Handing the same node to each is also the statement that Alia has ONE
   * sidebar: the column and the drawer are the same rows in a different frame,
   * which is why the drawer never needed a cut-down copy.
   *
   * `NavRegion` is what keeps the closed drawer out of the tab order and the
   * screen-reader tree (#532) and what publishes the shell's open/close to the
   * sidebar's own collapse control.
   */
  const nav = useMemo(
    () => (
      <NavRegion>
        <Sidebar />
      </NavRegion>
    ),
    [],
  );

  /** Names the veil that closes the nav drawer, and the shell's own controls. */
  const shellLabels = useMemo(
    () => ({
      openNavigation: i18n.t('nav.openNavigation'),
      closeNavigation: i18n.t('nav.closeNavigation'),
    }),
    [],
  );

  // The router owns routes; Bloom owns the frame and the chat header's insets.
  const screenOptions = ({ route }: { route: { name: string } }) => ({
    headerShown: false,
    contentStyle: {
      paddingTop: SELF_INSET_ROUTES.has(route.name) ? 0 : insets.top,
      backgroundColor: 'transparent',
    },
  });

  return (
    <AppErrorBoundary>
      <AliaSettingsProvider>
        <AiChatShell
          sidebar={nav}
          mobileSidebar={nav}
          sidebarCollapsed={navInFlow && !sidebarOpen}
          labels={shellLabels}
          defaultPanelWidth={rightPanelWidth}
          panelOpen={rightPanel !== null}
          onPanelOpenChange={(open) => {
            if (!open) {
              setRightPanel(null);
              if (rightPanel === 'thought') restoreOpenerFocus();
            }
          }}
          panelLabel={
            rightPanel === 'thought'
              ? i18n.t('thought.title')
              : (rightPanel ?? 'Details')
          }
          panel={
            rightPanel
              ? (width) => (
                  <View style={{ width, minHeight: 0, height: '100%' }}>
                    <RightPanel width={width} />
                  </View>
                )
              : undefined
          }
        >
          <ShellNavProvider>
            <Stack screenOptions={screenOptions}>
              <Stack.Screen
                name="c/[id]/index"
                options={{ title: i18n.t('nav.chat') }}
              />
            </Stack>
          </ShellNavProvider>
        </AiChatShell>
        <CommandPalette />
        <KeyboardShortcutsDialog />
      </AliaSettingsProvider>
    </AppErrorBoundary>
  );
}
