import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo } from 'react';
import { OxyProvider, useOxy } from '@oxyhq/services';
import * as Linking from 'expo-linking';
import { Platform, View } from 'react-native';
import { vars } from 'nativewind';

import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useColorScheme } from '@/lib/useColorScheme';
import { useThemeStore } from '@/lib/stores/theme-store';
import { ACCENT_PRESETS, getAccentCSSVariables, applyAccentToDocument } from '@/lib/accent-presets';
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
        {Platform.OS === 'web' ? stack : <KeyboardProvider>{stack}</KeyboardProvider>}
      </View>
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
    <OxyProvider
      baseURL={OXY_API_URL}
      authRedirectUri={Platform.OS !== 'web' ? AUTH_REDIRECT_URI : undefined}
    >
      <AppContent />
    </OxyProvider>
  );
}
