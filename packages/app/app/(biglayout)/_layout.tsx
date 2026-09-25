import { Stack } from 'expo-router';
import { useColorScheme } from '@/shared/platform/useColorScheme';

export default function BigLayout() {
  const { colors } = useColorScheme();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // No top inset here: both pages stand on Bloom's `Screen` with a
        // `PageHeader`, which pads itself below the status bar on native.
        // Padding the stack as well put the header a status bar too low
        // (Pixel 8a, `docs/native-validation.mdx`).
        contentStyle: {
          backgroundColor: colors.background,
        },
      }}
    />
  );
}
