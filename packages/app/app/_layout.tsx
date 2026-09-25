import '../global.css';
import { useNavigationTheme } from '@oxy.so/bloom/theme';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';
import { ImageResolverProvider } from '@oxy.so/bloom/image-resolver';
import { BloomProvider } from '@oxy.so/bloom/provider';
import {
  preventNativeSplashAutoHide,
  useHideNativeSplashWhenReady,
} from '@oxy.so/expo-splash';
import { OxyProvider, useOxy } from '@oxy.so/services';
import * as Linking from 'expo-linking';
import { Slot, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo, useRef } from 'react';
import { Platform } from 'react-native';

import { AppErrorBoundary } from '@/shell/error-boundary';
import { setTokenGetter } from '@/shared/api/client';
import '@/shared/i18n';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@/shared/i18n';
import { useI18nStore } from '@/shared/i18n/i18n-store';
import {
  BLOOM_THEME_PERSIST_KEY,
  BLOOM_THEME_STORAGE,
} from '@/shared/platform/themePersistence';
import { useColorScheme } from '@/shared/platform/useColorScheme';
import 'react-native-reanimated';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(app)',
};

preventNativeSplashAutoHide();

const OXY_API_URL = process.env.EXPO_PUBLIC_OXY_API_URL || 'https://api.oxy.so';
const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3';
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
    () => (id: string, variant?: string) =>
      oxyServices.getFileDownloadUrl(id, variant ?? 'thumb'),
    [oxyServices],
  );

  return (
    <ImageResolverProvider value={resolveImageSource}>
      {children}
    </ImageResolverProvider>
  );
}

function AppContent() {
  const navigationTheme = useNavigationTheme();
  const { colors, isDarkColorScheme } = useColorScheme();

  // Mounted only after BloomProvider's FontLoader resolves the default
  // Bloom fonts, so hiding the OS splash here leaves no unstyled-text flash.
  useHideNativeSplashWhenReady(true);

  return (
    <ThemeProvider value={navigationTheme}>
    <AuthSetup>
      {/* No <KeyboardProvider> here: OxyProvider mounts the app's one (its
          KeyboardBoundary), and there must be exactly one. Each provider
          suspends its keyboard callback while a <Modal> is up and resumes it
          from the dialog's dismiss listener, of which a dialog keeps only the
          last — so with a second provider, the first sheet or popover left
          one suspended and the composer stopped rising with the keyboard
          until a restart (#608, Android). Gate: one-keyboard-provider.test.ts */}
      {/* Web scrolls the document: native-stack's web scene is absolutely
          positioned, which would pin every page to one screen. */}
      {Platform.OS === 'web' ? (
        <Slot />
      ) : (
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
      )}
      {/* Neither a <ToastOutlet /> nor a <SurfaceHost /> here, for the same
          reason: OxyProvider mounts both (its <SurfaceProvider> renders the
          host next to its children). A second outlet renders every toast
          twice, and a second host renders every surface twice — two stacked
          panels over two backdrops, whose enter/exit animations then run
          independently and visibly desync. */}
      <ConnectionStatusToasts />
      {/* The bar's icons follow Alia's resolved theme, not the OS's: with a
          theme picked in the app they can differ, and Android draws the app
          edge to edge, so light icons would vanish on a light surface. */}
      <StatusBar style={isDarkColorScheme ? 'light' : 'dark'} />
    </AuthSetup>
    </ThemeProvider>
  );
}

function RootLayout() {
  return (
    // The single Bloom root (theme, haptics, scroll restoration, tab-bar
    // minimize progress). It must sit ABOVE the error boundary: the boundary's
    // fallback screen reads useTheme(), so with the provider inside it any
    // caught error would crash the boundary itself.
    <BloomProvider
      defaultMode="system"
      defaultColorPreset="purple"
      persistKey={BLOOM_THEME_PERSIST_KEY}
      storage={BLOOM_THEME_STORAGE}
    >
      <AppErrorBoundary>
        <OxyProvider
          baseURL={OXY_API_URL}
          clientId={OXY_CLIENT_ID}
          authRedirectUri={
            Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined
          }
          // Wires Alia's own i18n-js instance to Oxy's resolved language (the
          // signed-in account's primary locale, or the device/guest locale
          // when signed out) — Oxy decides WHICH language; `useI18nStore`
          // keeps owning the translation catalogs and library. See ADR 0022
          // in OxyHQServices (`docs/adr/0022-app-i18n-follows-oxy-language.md`).
          language={{
            supportedLocales: SUPPORTED_LOCALES,
            fallbackLocale: DEFAULT_LOCALE,
            onChange: useI18nStore.getState().setLocale,
            onError: (error, locale) => {
              console.error(
                'Failed to follow the Oxy-resolved language',
                error,
                { locale },
              );
            },
          }}
        >
          <AppContent />
        </OxyProvider>
      </AppErrorBoundary>
    </BloomProvider>
  );
}

export default RootLayout;
