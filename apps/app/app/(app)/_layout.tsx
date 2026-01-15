import { Drawer } from 'expo-router/drawer';
import { Redirect, Slot } from 'expo-router';
import { Sidebar } from '@/components/sidebar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useWindowDimensions } from 'react-native';
import { useAuthStore } from '@/lib/stores/auth-store';

export default function AppLayout() {
  // Use selector to avoid worklet serialization issues
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;

  // Redirect to login if not authenticated
  if (!isAuthenticated) {
    return <Redirect href="/login" />;
  }

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
      </Drawer>
    </GestureHandlerRootView>
  );
}
