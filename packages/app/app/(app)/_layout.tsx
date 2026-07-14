import { Drawer } from 'expo-router/drawer';
import { Sidebar } from '@/components/sidebar';
import { RightPanel } from '@/components/right-panel';
import { AppErrorBoundary } from '@/components/error-boundary';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { View, useWindowDimensions } from 'react-native';
import { useProjectsStore } from '@/lib/stores/projects-store';
import { useRolesStore } from '@/lib/stores/roles-store';
import { useAgentsStore } from '@/lib/stores/agents-store';
import { useFoldersStore } from '@/lib/stores/folders-store';
import { useFavoritesStore } from '@/lib/stores/favorites-store';
import { usePinnedStore } from '@/lib/stores/pinned-store';
import { useUIStore } from '@/lib/stores/ui-store';
import { useCallback, useEffect } from 'react';
import { useColorScheme } from '@/lib/useColorScheme';
import { useTheme } from '@oxyhq/bloom/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CommandPalette } from '@/components/command-palette';
import { KeyboardShortcutsDialog } from '@/components/keyboard-shortcuts-dialog';
import i18n from '@/lib/i18n';
import { useWelcomeSuggestions, useSessionSuggestionGeneration } from '@/lib/hooks/use-suggestions';
import { useNotificationSetup } from '@/lib/hooks/use-notification-setup';

// Routes visible in the drawer sidebar
const VISIBLE_ROUTES = new Set(['c/[id]/index', 'settings/index']);

// Routes that handle their own top safe area insets
// All settings/* routes are covered by the startsWith('settings/') check in screenOptions
const SELF_INSET_ROUTES = new Set(['index', 'c/[id]/index', 'settings']);

export default function AppLayout() {
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;
  const { colorScheme, colors } = useColorScheme();
  const { colors: themeColors } = useTheme();
  const insets = useSafeAreaInsets();
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const loadRoles = useRolesStore((state) => state.loadRoles);
  const loadAgents = useAgentsStore((state) => state.loadAgents);
  const loadFolders = useFoldersStore((state) => state.loadFolders);
  const loadFavorites = useFavoritesStore((state) => state.loadFavorites);
  const loadPinned = usePinnedStore((state) => state.loadPinned);
  const rightPanel = useUIStore((state) => state.rightPanel);
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);

  // Prefetch welcome suggestions so they're ready before any chat screen mounts
  useWelcomeSuggestions();
  useSessionSuggestionGeneration();

  // Push notification registration, tap handling, and real-time subscription
  useNotificationSetup();

  // Load projects, roles, folders, favorites, and pinned on mount
  useEffect(() => {
    loadProjects();
    loadRoles();
    loadAgents();
    loadFolders();
    loadFavorites();
    loadPinned();
  }, [loadProjects, loadRoles, loadAgents, loadFolders, loadFavorites, loadPinned]);

  const renderDrawerContent = useCallback(() => <Sidebar />, []);

  const screenOptions = useCallback(({ route }: { route: { name: string } }) => ({
    headerShown: false,
    sceneContainerStyle: {
      paddingTop: SELF_INSET_ROUTES.has(route.name) || route.name.startsWith('settings/') ? 0 : insets.top,
    },
    drawerStyle: {
      // Desktop collapse: the permanent drawer narrows to an icon rail
      // (the sidebar renders icon-only rows at this width).
      width: isLargeScreen && !sidebarOpen ? 64 : 255,
      backgroundColor: colors.background,
      borderRightWidth: 0,
      boxShadow: 'none' as const,
      elevation: 0,
    },
    drawerType: isLargeScreen ? ('permanent' as const) : ('front' as const),
    swipeEnabled: !isLargeScreen,
    overlayColor: isLargeScreen ? 'transparent' : themeColors.overlay,
    drawerItemStyle: VISIBLE_ROUTES.has(route.name) ? undefined : { display: 'none' as const },
  }), [insets.top, colors.background, isLargeScreen, sidebarOpen, themeColors.overlay]);

  return (
    <AppErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={{ flex: 1, flexDirection: isLargeScreen ? 'row' : 'column' }}>
        <View style={{ flex: 1 }}>
          <Drawer
            drawerContent={renderDrawerContent}
            screenOptions={screenOptions}
          >
            <Drawer.Screen
              name="c/[id]/index"
              options={{
                drawerLabel: i18n.t('nav.chat'),
                title: i18n.t('nav.chat'),
              }}
            />
            <Drawer.Screen
              name="settings/index"
              options={{
                drawerLabel: i18n.t('nav.settings'),
                title: i18n.t('nav.settings'),
              }}
            />
          </Drawer>
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
