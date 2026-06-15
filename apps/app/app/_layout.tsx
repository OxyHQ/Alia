import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { OxyProvider, useOxy } from '@oxyhq/services';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import { AppErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/sonner';
import { KeyboardProvider } from '@/lib/keyboard';
import { useColorScheme } from '@/lib/useColorScheme';
import { setTokenGetter } from '@/lib/api/client';
import 'react-native-reanimated';
import '../global.css';
import '@/lib/i18n';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(app)',
};

SplashScreen.preventAutoHideAsync();

const OXY_API_URL = process.env.EXPO_PUBLIC_OXY_API_URL || 'https://api.oxy.so';
const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ?? 'oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3';
const AUTH_REDIRECT_URI = Linking.createURL('/');

function AuthSetup({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useOxy();

  setTokenGetter(() => oxyServices.getAccessToken() || null);

  return <>{children}</>;
}

function AppContent() {
  const { colors } = useColorScheme();

  return (
    <AuthSetup>
      <KeyboardProvider>
        <Stack
          screenOptions={{
            contentStyle: {
              backgroundColor: colors.background,
            },
          }}
        >
          <Stack.Screen name="(app)" options={{ headerShown: false }} />
          <Stack.Screen name="(biglayout)" options={{ headerShown: false }} />
        </Stack>
      </KeyboardProvider>
      <Toaster />
    </AuthSetup>
  );
}

function RootLayout() {
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
    <AppErrorBoundary>
      <BloomThemeProvider
        defaultMode="system"
        defaultColorPreset="purple"
        fonts={false}
      >
        <OxyProvider
          baseURL={OXY_API_URL}
          clientId={OXY_CLIENT_ID}
          authRedirectUri={Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined}
        >
          <AppContent />
        </OxyProvider>
      </BloomThemeProvider>
    </AppErrorBoundary>
  );
}

export default RootLayout;
