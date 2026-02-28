import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Sentry from '@sentry/react-native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo } from 'react';
import { OxyProvider, useOxy } from '@oxyhq/services';
import * as Linking from 'expo-linking';
import { Platform, View } from 'react-native';
import { vars } from 'nativewind';

import { AppErrorBoundary } from '@/components/error-boundary';
import { KeyboardProvider } from '@/lib/keyboard';
import { useColorScheme } from '@/lib/useColorScheme';
import { useThemeStore } from '@/lib/stores/theme-store';
import { ACCENT_PRESETS, getAccentCSSVariables, applyAccentToDocument } from '@/lib/accent-presets';
import { setTokenGetter } from '@/lib/api/client';
import 'react-native-reanimated';
import '../global.css';
import '@/lib/i18n';

const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn: SENTRY_DSN,
  // Disable Sentry in development unless a DSN is explicitly provided
  enabled: !!SENTRY_DSN,
  // Set tracesSampleRate to 1.0 to capture 100% of transactions for tracing.
  // Adjust in production to a lower value to reduce volume.
  tracesSampleRate: __DEV__ ? 1.0 : 0.2,
  // Capture 100% of error events
  sampleRate: 1.0,
  // Only send replays on error in production
  _experiments: {
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: __DEV__ ? 0 : 1.0,
  },
  debug: __DEV__,
});

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(app)',
};

SplashScreen.preventAutoHideAsync();

const OXY_API_URL = process.env.EXPO_PUBLIC_OXY_API_URL || 'https://api.oxy.so';
const AUTH_REDIRECT_URI = Linking.createURL('/');

function AuthSetup({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useOxy();

  // Set synchronously so token is available before child queries fire
  setTokenGetter(() => oxyServices.getAccessToken() || null);

  return <>{children}</>;
}

function AppContent() {
  const { colors, colorScheme } = useColorScheme();
  const accentColor = useThemeStore((s) => s.accentColor);

  // Web: apply accent CSS variables to document
  useEffect(() => {
    applyAccentToDocument(accentColor, colorScheme);
  }, [accentColor, colorScheme]);

  // Native: cascade accent CSS variables via NativeWind vars()
  const accentVars = useMemo(() => {
    if (accentColor === 'default') return undefined;
    const preset = ACCENT_PRESETS[accentColor];
    return vars(getAccentCSSVariables(preset, colorScheme));
  }, [accentColor, colorScheme]);

  const stack = (
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
  );

  return (
    <AuthSetup>
      <View style={[{ flex: 1 }, accentVars]}>
        <KeyboardProvider>{stack}</KeyboardProvider>
      </View>
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
      <OxyProvider
        baseURL={OXY_API_URL}
        authRedirectUri={Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined}
      >
        <AppContent />
      </OxyProvider>
    </AppErrorBoundary>
  );
}

export default Sentry.wrap(RootLayout);
