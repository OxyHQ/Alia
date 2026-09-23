import { useTranslation } from '@/lib/hooks/use-translation';
import { useColorScheme } from '@/lib/useColorScheme';
import { IdentityMark } from '@alia.onl/sdk';
import { Text } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services';
import { View } from 'react-native';
export const WelcomeMessage = () => {
  const { user, isAuthenticated } = useAuth();
  const { colors } = useColorScheme();
  const { t } = useTranslation();

  // Oxy identity rule: displayName with handle fallback.
  const name = user?.name?.displayName?.trim() || user?.username;
  const greeting =
    isAuthenticated && name
      ? t('welcome.greetingNamed', { name })
      : t('welcome.greeting');

  return (
    <View className="flex-row items-center gap-2 py-3">
      <IdentityMark size={20} color={colors.primary} spinOnPress />
      <Text className="text-sm text-muted-foreground">{greeting}</Text>
    </View>
  );
};
