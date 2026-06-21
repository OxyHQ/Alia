import { Stack } from 'expo-router';
import { useColorScheme } from '@/lib/useColorScheme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function BigLayout() {
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: {
          backgroundColor: colors.background,
          paddingTop: insets.top,
        },
      }}
    />
  );
}
