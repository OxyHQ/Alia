import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo, useRef } from 'react';
import { OxyProvider, useOxy } from '@oxyhq/services';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';
import { ImageResolverProvider } from '@oxyhq/bloom/image-resolver';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import { AppErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/sonner';
import { AlertDialogHost } from '@oxyhq/bloom/alert-dialog';
import { BloomDialogProvider } from '@oxyhq/bloom/dialog';
import { KeyboardProvider } from '@/lib/keyboard';
import { useColorScheme } from '@/lib/useColorScheme';
import { setTokenGetter } from '@/lib/api/client';
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from '@/lib/themePersistence';
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

  // Registered during render (not an effect) because children's mount effects
  // fire API calls before a parent effect would run; guarded so it only re-runs
  // if the SDK instance ever changes instead of on every render.
  const registeredServicesRef = useRef<typeof oxyServices | null>(null);
  if (registeredServicesRef.current !== oxyServices) {
    registeredServicesRef.current = oxyServices;
    setTokenGetter(() => oxyServices.getAccessToken() || null);
  }

  // Resolve bare Oxy file IDs to loadable URLs for Bloom components (avatars in
  // ProfileButton, etc.). Single chokepoint: getFileDownloadUrl builds the
  // canonical cloud.oxy.so URL. Defaults to the 'thumb' rendition when a caller
  // omits the variant so list/sidebar avatars stay light.
  const resolveImageSource = useMemo(
    () => (id: string, variant?: string) => oxyServices.getFileDownloadUrl(id, variant ?? 'thumb'),
    [oxyServices],
  );

  return <ImageResolverProvider value={resolveImageSource}>{children}</ImageResolverProvider>;
}

function AppContent() {
  const { colors } = useColorScheme();

  // Mounted only after BloomThemeProvider's FontLoader resolves the default
  // Bloom fonts, so hiding the OS splash here leaves no unstyled-text flash.
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <AuthSetup>
      <BloomDialogProvider>
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
        <AlertDialogHost />
      </BloomDialogProvider>
    </AuthSetup>
  );
}

function RootLayout() {
  return (
    // BloomThemeProvider must sit ABOVE the error boundary: the boundary's
    // fallback screen reads useTheme(), so with the provider inside it any
    // caught error would crash the boundary itself.
    <BloomThemeProvider
      defaultMode="system"
      defaultColorPreset="purple"
      persistKey={BLOOM_THEME_PERSIST_KEY}
      storage={BLOOM_THEME_STORAGE}
    >
      <AppErrorBoundary>
        <OxyProvider
          baseURL={OXY_API_URL}
          clientId={OXY_CLIENT_ID}
          authRedirectUri={Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined}
        >
          <AppContent />
        </OxyProvider>
      </AppErrorBoundary>
    </BloomThemeProvider>
  );
}

export default RootLayout;
