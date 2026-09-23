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

/** The template's frame (`templates/shared/dashboard.tsx` in Bloom). */
const TEMPLATE_FRAME = { flex: 1, width: '100%', minWidth: 0, minHeight: 0 } as const;

export default function AppLayout() {
  const insets = useSafeAreaInsets();
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const loadFolders = useFoldersStore((state) => state.loadFolders);
  const loadFavorites = useFavoritesStore((state) => state.loadFavorites);
  const loadPinned = usePinnedStore((state) => state.loadPinned);
  const rightPanel = useUIStore((state) => state.rightPanel);
  const setRightPanel = useUIStore((state) => state.setRightPanel);
  const rightPanelWidth = useUIStore((state) => state.rightPanelWidth);

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
   * The template's two sidebars: the in-flow panel from `lg` up, and the drawer
   * copy (`mobile`, plain surface) below it. `NavRegion` keeps the closed drawer
   * out of the tab order and the screen-reader tree (#532).
   */
  const sidebar = useMemo(() => <Sidebar />, []);
  const mobileSidebar = useMemo(
    () => (
      <NavRegion>
        <Sidebar mobile />
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
        <View style={TEMPLATE_FRAME}>
        <AiChatShell
          sidebar={sidebar}
          mobileSidebar={mobileSidebar}
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
        </View>
        <CommandPalette />
        <KeyboardShortcutsDialog />
      </AliaSettingsProvider>
    </AppErrorBoundary>
  );
}
