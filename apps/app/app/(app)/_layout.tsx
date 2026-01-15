import { Drawer } from 'expo-router/drawer';
import { Redirect, Slot } from 'expo-router';
import { Sidebar } from '@/components/sidebar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useWindowDimensions } from 'react-native';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useProjectsStore } from '@/lib/stores/projects-store';
import { useEffect } from 'react';

export default function AppLayout() {
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;
  const loadProjects = useProjectsStore((state) => state.loadProjects);

  // Load projects on mount
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Drawer
        drawerContent={() => <Sidebar />}
        screenOptions={{
          headerShown: false,
          drawerStyle: {
            width: 255,
            backgroundColor: 'transparent',
            borderRightWidth: 0,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.05,
            shadowRadius: 2,
            elevation: 1,
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
          name="login"
          options={{
            drawerItemStyle: { display: 'none' },
            title: 'Sign In',
          }}
        />
        <Drawer.Screen
          name="register"
          options={{
            drawerItemStyle: { display: 'none' },
            title: 'Sign Up',
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
      </Drawer>
    </GestureHandlerRootView>
  );
}
