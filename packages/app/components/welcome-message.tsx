import { useTranslation } from '@/lib/hooks/use-translation';
import { useColorScheme } from '@/lib/useColorScheme';
import { IdentityMark } from '@alia.onl/sdk';
import { Text } from '@oxy.so/bloom/typography';
import { getAccountDisplayName } from '@oxy.so/core';
import { useAuth } from '@oxy.so/services';
import { View } from 'react-native';
/**
 * The empty chat's greeting, as Alia had it: its mark beside "Hi {name},
 * what's on your mind?", resting at the foot of the thread over the composer.
 */
export const WelcomeMessage = () => {
  const { user, isAuthenticated } = useAuth();
  const { colors } = useColorScheme();
  const { t, locale } = useTranslation();

  // Oxy's own display name (display name, full name, handle…), not a copy of it.
  const greeting =
    isAuthenticated && user
      ? t('welcome.greetingNamed', { name: getAccountDisplayName(user, locale) })
      : t('welcome.greeting');

  return (
    <View className="flex-row items-center gap-2 py-3">
      <IdentityMark size={20} color={colors.primary} spinOnPress />
      <Text className="text-sm text-muted-foreground">{greeting}</Text>
    </View>
  );
};
