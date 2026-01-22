import { Drawer } from 'expo-router/drawer';
import { Redirect, Slot } from 'expo-router';
import { Sidebar } from '@/components/sidebar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useWindowDimensions } from 'react-native';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useProjectsStore } from '@/lib/stores/projects-store';
import { useRolesStore } from '@/lib/stores/roles-store';
import { useFoldersStore } from '@/lib/stores/folders-store';
import { useFavoritesStore } from '@/lib/stores/favorites-store';
import { useEffect } from 'react';
import { useColorScheme } from '@/lib/useColorScheme';

export default function AppLayout() {
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;
  const { colorScheme } = useColorScheme();
  const loadProjects = useProjectsStore((state) => state.loadProjects);
  const loadRoles = useRolesStore((state) => state.loadRoles);
  const loadFolders = useFoldersStore((state) => state.loadFolders);
  const loadFavorites = useFavoritesStore((state) => state.loadFavorites);

  // Load projects, roles, folders, and favorites on mount
  useEffect(() => {
    loadProjects();
    loadRoles();
    loadFolders();
    loadFavorites();
  }, [loadProjects, loadRoles, loadFolders, loadFavorites]);

  // Get drawer colors based on color scheme
  const drawerBackgroundColor = colorScheme === 'dark' ? '#151a2e' : '#fafafe'; // surface colors
  const drawerBorderColor = colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : '#e5e5e5'; // border colors

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Drawer
        drawerContent={() => <Sidebar />}
        screenOptions={{
          headerShown: false,
          drawerStyle: {
            width: 255,
            backgroundColor: drawerBackgroundColor,
            borderRightWidth: 1,
            borderRightColor: drawerBorderColor,
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
          name="settings/account"
          options={{
            drawerLabel: 'Account',
            title: 'Account',
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
          name="roles/[id]"
          options={{
            drawerItemStyle: { display: 'none' },
            title: 'Role Detail',
          }}
        />
      </Drawer>
    </GestureHandlerRootView>
  );
}
