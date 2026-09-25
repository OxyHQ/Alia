import { useTranslation } from '@/shared/i18n/use-translation';
import { useColorScheme } from '@/shared/platform/useColorScheme';
import { IdentityMark } from '@alia.onl/sdk';
import { Text } from '@oxy.so/bloom/typography';
import { getAccountDisplayName } from '@oxy.so/core';
import { useAuth } from '@oxy.so/services';
import { View } from 'react-native';

/**
 * The empty chat's greeting, as Alia has always had it: its mark beside
 * "Hi {name}, what's on your mind?" at display size, centred in the thread —
 * stacked on a phone, side by side from `md`.
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
    <View className="flex-col items-center justify-center gap-3 md:flex-row">
      <IdentityMark size={38} color={colors.primary} spinOnPress />
      <Text selectable={false} className="text-center text-4xl tracking-tight text-foreground md:text-left">
        {greeting}
      </Text>
    </View>
  );
};
