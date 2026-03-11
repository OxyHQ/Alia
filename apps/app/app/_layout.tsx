import FontAwesome from '@expo/vector-icons/FontAwesome';
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
import { APP_COLOR_PRESETS, getAppColorCSSVariables, applyAppColorToDocument } from '@/lib/app-color-presets';
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
const AUTH_REDIRECT_URI = Linking.createURL('/');

function AuthSetup({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useOxy();

  // Set synchronously so token is available before child queries fire
  setTokenGetter(() => oxyServices.getAccessToken() || null);

  return <>{children}</>;
}

function AppContent() {
  const { colors, colorScheme } = useColorScheme();
  const appColor = useThemeStore((s) => s.appColor);

  // Web: apply app color CSS variables to document
  useEffect(() => {
    applyAppColorToDocument(appColor, colorScheme);
  }, [appColor, colorScheme]);

  // Native: cascade app color CSS variables via NativeWind vars()
  const colorVars = useMemo(() => {
    if (appColor === 'purple') return undefined;
    const preset = APP_COLOR_PRESETS[appColor];
    return vars(getAppColorCSSVariables(preset, colorScheme));
  }, [appColor, colorScheme]);

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
      <View style={[{ flex: 1 }, colorVars]}>
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

export default RootLayout;
