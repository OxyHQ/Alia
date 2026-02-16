import { Drawer } from 'expo-router/drawer';
import { Sidebar } from '@/components/sidebar';
import { RightPanel } from '@/components/right-panel';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { View, useWindowDimensions } from 'react-native';
import { useProjectsStore } from '@/lib/stores/projects-store';
import { useRolesStore } from '@/lib/stores/roles-store';
import { useAgentsStore } from '@/lib/stores/agents-store';
import { useFoldersStore } from '@/lib/stores/folders-store';
import { useFavoritesStore } from '@/lib/stores/favorites-store';
import { usePinnedStore } from '@/lib/stores/pinned-store';
import { useUIStore } from '@/lib/stores/ui-store';
import { useEffect } from 'react';
import { useColorScheme } from '@/lib/useColorScheme';
import { CommandPalette } from '@/components/command-palette';
import { KeyboardShortcutsDialog } from '@/components/keyboard-shortcuts-dialog';
import i18n from '@/lib/i18n';

export default function AppLayout() {
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;
  const { colorScheme, colors } = useColorScheme();
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const loadRoles = useRolesStore((state) => state.loadRoles);
  const loadAgents = useAgentsStore((state) => state.loadAgents);
  const loadFolders = useFoldersStore((state) => state.loadFolders);
  const loadFavorites = useFavoritesStore((state) => state.loadFavorites);
  const loadPinned = usePinnedStore((state) => state.loadPinned);
  const rightPanel = useUIStore((state) => state.rightPanel);

  // Load projects, roles, folders, favorites, and pinned on mount
  useEffect(() => {
    loadProjects();
    loadRoles();
    loadAgents();
    loadFolders();
    loadFavorites();
    loadPinned();
  }, [loadProjects, loadRoles, loadAgents, loadFolders, loadFavorites, loadPinned]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={{ flex: 1, flexDirection: isLargeScreen ? 'row' : 'column' }}>
        <View style={{ flex: 1 }}>
          <Drawer
            drawerContent={() => <Sidebar />}
            screenOptions={{
              headerShown: false,
              drawerStyle: {
                width: 255,
                backgroundColor: colors.background,
                borderRightWidth: 0,
                boxShadow: 'none',
                elevation: 0,
              },
              drawerType: isLargeScreen ? 'permanent' : 'front',
              swipeEnabled: !isLargeScreen,
              overlayColor: isLargeScreen ? 'transparent' : 'rgba(0, 0, 0, 0.5)',
            }}
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
            <Drawer.Screen
              name="settings/memory"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.memory'),
              }}
            />
            <Drawer.Screen
              name="settings/general"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.general'),
              }}
            />
            <Drawer.Screen
              name="settings/usage"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.billing'),
              }}
            />
            <Drawer.Screen
              name="settings/personalization"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.personalization'),
              }}
            />
            <Drawer.Screen
              name="settings/connectors"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.connectors'),
              }}
            />
            <Drawer.Screen
              name="settings/feedback"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.feedback'),
              }}
            />
            <Drawer.Screen
              name="settings/whatsapp"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.whatsapp'),
              }}
            />
            <Drawer.Screen
              name="settings/telegram-gateway"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.telegramGateway'),
              }}
            />
            <Drawer.Screen
              name="settings/signal-gateway"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.signalGateway'),
              }}
            />
            <Drawer.Screen
              name="forgot-password"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.forgotPassword'),
              }}
            />
            <Drawer.Screen
              name="favorites"
              options={{
                drawerItemStyle: { display: 'none' },
                title: 'Favorites',
              }}
            />
            <Drawer.Screen
              name="library"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.library'),
              }}
            />
            <Drawer.Screen
              name="roles"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.roles'),
              }}
            />
            <Drawer.Screen
              name="automations"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.automations'),
              }}
            />
            <Drawer.Screen
              name="skills"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.skills'),
              }}
            />
            <Drawer.Screen
              name="agents"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.agents'),
              }}
            />
            <Drawer.Screen
              name="skills/[id]"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.skillDetail'),
              }}
            />
            <Drawer.Screen
              name="roles/[id]"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.roleDetail'),
              }}
            />
            <Drawer.Screen
              name="agents/create"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.createAgent'),
              }}
            />
            <Drawer.Screen
              name="agents/[id]"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.agentDetail'),
              }}
            />
            <Drawer.Screen
              name="invite/[code]"
              options={{
                drawerItemStyle: { display: 'none' },
                title: i18n.t('nav.invite'),
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
  );
}
