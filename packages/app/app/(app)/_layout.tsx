import { Stack } from 'expo-router';
import { AiChatShell } from '@oxy.so/bloom/ai-chat';
import { Sidebar } from '@/components/sidebar';
import { RightPanel } from '@/components/right-panel';
import { AppErrorBoundary } from '@/components/error-boundary';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { View } from 'react-native';
import { NavRegion } from '@/components/app-shell/nav-region';
import { ShellNavProvider } from '@/components/app-shell/shell-nav';
import {
  NAV_PANEL_WIDTH,
  NAV_RAIL_WIDTH,
  useIsNavInFlow,
} from '@/components/app-shell/metrics';
import { useProjectsStore } from '@/lib/stores/projects-store';
import { useFoldersStore } from '@/lib/stores/folders-store';
import { useFavoritesStore } from '@/lib/stores/favorites-store';
import { usePinnedStore } from '@/lib/stores/pinned-store';
import { useUIStore } from '@/lib/stores/ui-store';
import { useEffect, useMemo } from 'react';
import { useColorScheme } from '@/lib/useColorScheme';
import { useOxy } from '@oxy.so/services';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CommandPalette } from '@/components/command-palette';
import { KeyboardShortcutsDialog } from '@/components/keyboard-shortcuts-dialog';
import i18n from '@/lib/i18n';
import { useWelcomeSuggestions } from '@/lib/hooks/use-suggestions';
import { useNotificationSetup } from '@/lib/hooks/use-notification-setup';
import { useLocalRuntime } from '@/lib/hooks/use-local-runtime';
import { useIsLargeScreen } from '@/lib/hooks/use-is-large-screen';

// Routes that handle their own top safe area insets
const SELF_INSET_ROUTES = new Set(['index', 'c/[id]/index', '[username]', 'settings']);

/**
 * The shell's own frame, flattened.
 *
 * `AiChatShell` draws itself as a 12px-inset card with a 16px gutter between
 * the nav column and the workspace, which is Bloom's AI-chat template and is
 * not Alia's layout: Alia's sidebar meets its content edge to edge and the
 * scene carries its own 8px gutter (`md:p-2 md:pl-0`, below). `style` is
 * applied after the shell's own root style, so naming the three properties
 * here is the whole of the override.
 *
 * `backgroundColor` is Alia's `background` rather than Bloom's `background-full`
 * for the same reason: it is the colour the expo-router `Drawer` painted, and
 * the colour the sidebar and every scene paint on top of. It travels with
 * `surface={false}`, which stops the shell painting `background-full` on the
 * root AND on the workspace — the workspace's paint would otherwise sit over a
 * scene that already has one, one token out.
 */
function useShellFrame() {
  const { colors } = useColorScheme();
  return useMemo(
    () => ({ padding: 0, gap: 0, backgroundColor: colors.background }),
    [colors.background],
  );
}

export default function AppLayout() {
  /**
   * 768: still what decides whether the right panel is a column beside the chat
   * or a modal over it. Deliberately NOT the nav's breakpoint — these are two
   * different questions and they were only ever one number by coincidence.
   */
  const isLargeScreen = useIsLargeScreen();
  /** 1024: whether the nav is a column. `AiChatShell` decides this; see `metrics.ts`. */
  const navInFlow = useIsNavInFlow();
  const insets = useSafeAreaInsets();
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const loadFolders = useFoldersStore((state) => state.loadFolders);
  const loadFavorites = useFavoritesStore((state) => state.loadFavorites);
  const loadPinned = usePinnedStore((state) => state.loadPinned);
  const rightPanel = useUIStore((state) => state.rightPanel);
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const shellFrame = useShellFrame();

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

  /**
   * The scenes.
   *
   * A `Stack` where there was a `Drawer`, because the drawer the `Drawer` was
   * for is `AiChatShell`'s now and what is left of the navigator is its actual
   * job: owning the routes, the URLs, the browser's back and forward, and the
   * platform's own back. `screenLayout` and `sceneContainerStyle` are gone with
   * it — one scene is on screen at a time, so the gutter band that wrapped each
   * scene wraps the navigator instead and says the same thing in one place.
   *
   * `VISIBLE_ROUTES` and `drawerItemStyle` are gone too, and were always
   * vestigial: they hid routes from the drawer's built-in item list, which was
   * never rendered — `drawerContent` replaced it with Alia's sidebar on the
   * first day.
   *
   * The per-route top inset survives as `contentStyle`, which is the same idea
   * with a different name: a screen in `SELF_INSET_ROUTES` places its own safe
   * area (the chat header does it inside its 56px band), and everything else is
   * pushed clear of the notch here.
   */
  const screenOptions = ({ route }: { route: { name: string } }) => ({
    headerShown: false,
    contentStyle: {
      paddingTop: SELF_INSET_ROUTES.has(route.name) ? 0 : insets.top,
      // The scene's own surface is painted by the gutter band below; a second
      // opaque layer here would sit over the 8px inset and fill it in.
      backgroundColor: 'transparent',
    },
  });

  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={{ flex: 1, flexDirection: isLargeScreen ? 'row' : 'column' }}>
        <View style={{ flex: 1 }}>
          <AiChatShell
            sidebar={nav}
            mobileSidebar={nav}
            sidebarWidth={NAV_PANEL_WIDTH}
            /* The 56px icon rail. `sidebarOpen` is the same persisted flag that
               used to set `drawerStyle.width`; below `lg` there is no column to
               narrow, so the flag says nothing there. */
            sidebarCollapsed={navInFlow && !sidebarOpen}
            collapsedSidebarWidth={NAV_RAIL_WIDTH}
            surface={false}
            style={shellFrame}
            labels={shellLabels}
          >
            {/* Only the gutter band: `ContentPanel` refuses to nest, so each
                scene composes its own panel(s) and a two-pane scene can render
                them as siblings. `pl-0` keeps the content meeting the nav. */}
            <ShellNavProvider>
              <View className="flex-1 bg-background md:p-2 md:pl-0">
                <Stack screenOptions={screenOptions}>
                  <Stack.Screen name="c/[id]/index" options={{ title: i18n.t('nav.chat') }} />
                  <Stack.Screen name="settings" options={{ title: i18n.t('nav.settings') }} />
                </Stack>
              </View>
            </ShellNavProvider>
          </AiChatShell>
        </View>
        {/* Right Panel - flex on desktop, modal on mobile */}
        {isLargeScreen && rightPanel && <RightPanel />}
      </View>
      {/* Mobile modal for right panel */}
      {!isLargeScreen && <RightPanel />}
      <CommandPalette />
      <KeyboardShortcutsDialog />
      </GestureHandlerRootView>
    </AppErrorBoundary>
  );
}
