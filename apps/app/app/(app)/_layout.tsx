import { Drawer } from 'expo-router/drawer';
import { Sidebar } from '@/components/sidebar';
import { RightPanel } from '@/components/right-panel';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { View, useWindowDimensions } from 'react-native';
import { useProjectsStore } from '@/lib/stores/projects-store';
import { useRolesStore } from '@/lib/stores/roles-store';
import { useFoldersStore } from '@/lib/stores/folders-store';
import { useFavoritesStore } from '@/lib/stores/favorites-store';
import { useUIStore } from '@/lib/stores/ui-store';
import { useEffect } from 'react';
import { useColorScheme } from '@/lib/useColorScheme';

export default function AppLayout() {
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;
  const { colorScheme, colors } = useColorScheme();
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const loadRoles = useRolesStore((state) => state.loadRoles);
  const loadFolders = useFoldersStore((state) => state.loadFolders);
  const loadFavorites = useFavoritesStore((state) => state.loadFavorites);
  const rightPanel = useUIStore((state) => state.rightPanel);

  // Load projects, roles, folders, and favorites on mount
  useEffect(() => {
    loadProjects();
    loadRoles();
    loadFolders();
    loadFavorites();
  }, [loadProjects, loadRoles, loadFolders, loadFavorites]);

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
                shadowOpacity: 0,
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
                drawerLabel: 'Chat',
                title: 'Chat',
              }}
            />
            <Drawer.Screen
              name="settings/index"
              options={{
                drawerLabel: 'Settings',
                title: 'Settings',
              }}
            />
            <Drawer.Screen
              name="settings/memory"
              options={{
                drawerLabel: 'Memory',
                title: 'Memory',
              }}
            />
            <Drawer.Screen
              name="settings/feedback"
              options={{
                drawerLabel: 'Feedback',
                title: 'Feedback',
              }}
            />
            <Drawer.Screen
              name="forgot-password"
              options={{
                drawerItemStyle: { display: 'none' },
                title: 'Forgot Password',
              }}
            />
            <Drawer.Screen
              name="library"
              options={{
                drawerItemStyle: { display: 'none' },
                title: 'Library',
              }}
            />
            <Drawer.Screen
              name="roles"
              options={{
                drawerItemStyle: { display: 'none' },
                title: 'Roles',
              }}
            />
            <Drawer.Screen
              name="automations"
              options={{
                drawerItemStyle: { display: 'none' },
                title: 'Automations',
              }}
            />
            <Drawer.Screen
              name="analytics"
              options={{
                drawerItemStyle: { display: 'none' },
                title: 'Analytics',
              }}
            />
            <Drawer.Screen
              name="skills"
              options={{
                drawerItemStyle: { display: 'none' },
                title: 'Skills',
              }}
            />
            <Drawer.Screen
              name="skills/[id]"
              options={{
                drawerItemStyle: { display: 'none' },
                title: 'Skill Detail',
              }}
            />
            <Drawer.Screen
              name="roles/[id]"
              options={{
                drawerItemStyle: { display: 'none' },
                title: 'Role Detail',
              }}
            />
          </Drawer>
        </View>
        {/* Right Panel - flex on desktop, modal on mobile */}
        {isLargeScreen && rightPanel && <RightPanel />}
      </View>
      {/* Mobile modal for right panel */}
      {!isLargeScreen && <RightPanel />}
    </GestureHandlerRootView>
  );
}
