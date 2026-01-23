import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { OxyProvider, useOxy } from '@oxyhq/services';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Toaster } from '@/components/sonner';
import { useColorScheme } from '@/lib/useColorScheme';
import { setSessionGetter } from '@/lib/api/client';
import 'react-native-reanimated';
import '../global.css';
import '@/lib/i18n';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(app)',
};

SplashScreen.preventAutoHideAsync();

const OXY_API_URL = process.env.EXPO_PUBLIC_OXY_API_URL || 'https://api.oxy.so';
const AUTH_REDIRECT_URI = Linking.createURL('/');

function AuthSetup({ children }: { children: React.ReactNode }) {
  const { activeSessionId } = useOxy();

  useEffect(() => {
    setSessionGetter(() => activeSessionId ?? null);
  }, [activeSessionId]);

  return <>{children}</>;
}

function AppContent() {
  const { colorScheme } = useColorScheme();

  return (
    <AuthSetup>
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
    </AuthSetup>
  );
}

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    Inter: require('../assets/fonts/Inter-VariableFont_opsz,wght.ttf'),
    'Inter-Italic': require('../assets/fonts/Inter-Italic-VariableFont_opsz,wght.ttf'),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <OxyProvider
          baseURL={OXY_API_URL}
          authRedirectUri={Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined}
        >
          <AppContent />
        </OxyProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
