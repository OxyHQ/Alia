import { Drawer } from 'expo-router/drawer';
import { Redirect, Slot } from 'expo-router';
import { DeveloperSidebar } from '@/components/developer-sidebar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useWindowDimensions } from 'react-native';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useDeveloperStore } from '@/lib/stores/developer-store';
import { useEffect } from 'react';

export default function DevelopersLayout() {
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;
  const fetchApps = useDeveloperStore((state) => state.fetchApps);
  const fetchDeveloperStats = useDeveloperStore((state) => state.fetchDeveloperStats);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  // Load developer data on mount
  useEffect(() => {
    if (isAuthenticated) {
      fetchApps().catch(console.error);
      fetchDeveloperStats().catch(console.error);
    }
  }, [isAuthenticated, fetchApps, fetchDeveloperStats]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Drawer
        drawerContent={() => <DeveloperSidebar />}
        screenOptions={{
          headerShown: false,
          drawerStyle: {
            width: 255,
            backgroundColor: 'transparent',
            borderRightWidth: 0,
            boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.05)',
            elevation: 1,
          },
          drawerType: isLargeScreen ? 'permanent' : 'front',
          swipeEnabled: !isLargeScreen,
          overlayColor: isLargeScreen ? 'transparent' : 'rgba(0, 0, 0, 0.5)',
        }}
      >
        <Drawer.Screen
          name="developers/index"
          options={{
            drawerItemStyle: { display: 'none' },
            title: 'Developer Portal',
          }}
        />
        <Drawer.Screen
          name="developers/apps/new"
          options={{
            drawerItemStyle: { display: 'none' },
            title: 'Create App',
          }}
        />
        <Drawer.Screen
          name="developers/apps/[id]"
          options={{
            drawerItemStyle: { display: 'none' },
            title: 'App Detail',
          }}
        />
        <Drawer.Screen
          name="developers/apps/[id]/usage"
          options={{
            drawerItemStyle: { display: 'none' },
            title: 'Usage Statistics',
          }}
        />
        <Drawer.Screen
          name="developers/documentation"
          options={{
            drawerItemStyle: { display: 'none' },
            title: 'Documentation',
          }}
        />
        <Drawer.Screen
          name="developers/examples"
          options={{
            drawerItemStyle: { display: 'none' },
            title: 'Examples',
          }}
        />
      </Drawer>
    </GestureHandlerRootView>
  );
}
