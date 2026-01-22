import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { OxyProvider } from '@oxyhq/services';
import * as Linking from 'expo-linking';
import { PortalHost } from '@rn-primitives/portal';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Toaster } from '@/components/sonner';
import { OxyAuthSetup } from '@/components/OxyAuthSetup';
import { useColorScheme } from '@/lib/useColorScheme';
import 'react-native-reanimated';
import '../global.css';
import '@/lib/i18n'; // Initialize i18n

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(app)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

// Oxy auth configuration
const OXY_API_URL = process.env.EXPO_PUBLIC_OXY_API_URL || 'https://api.oxy.so';
const AUTH_REDIRECT_URI = Linking.createURL('/');

function RootLayoutContent() {
  const { colorScheme } = useColorScheme();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <OxyProvider baseURL={OXY_API_URL} authRedirectUri={AUTH_REDIRECT_URI}>
          <OxyAuthSetup>
            <Stack
              screenOptions={{
                contentStyle: {
                  backgroundColor: colorScheme === 'dark' ? '#0a0d1a' : '#ffffff',
                },
              }}
            >
              <Stack.Screen name="(app)" options={{ headerShown: false }} />
              <Stack.Screen name="(developers)" options={{ headerShown: false }} />
            </Stack>
            <PortalHost />
            <Toaster position="bottom-center" />
          </OxyAuthSetup>
        </OxyProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    Inter: require('../assets/fonts/Inter-VariableFont_opsz,wght.ttf'),
    'Inter-Italic': require('../assets/fonts/Inter-Italic-VariableFont_opsz,wght.ttf'),
    ...FontAwesome.font,
  });

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return <RootLayoutContent />;
}
