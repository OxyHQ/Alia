import { View } from "react-native";
import { useAuth } from "@oxyhq/services";
import { Text } from "@/components/ui/text";
import { AliaMark } from '@alia.onl/sdk';
import { useTranslation } from "@/hooks/useTranslation";

export const WelcomeMessage = () => {
  const { user, isAuthenticated } = useAuth();
  const { t } = useTranslation();

  // Oxy identity rule: displayName with handle fallback.
  const name = user?.name?.displayName?.trim() || user?.username;
  const greeting = isAuthenticated && name
    ? t('welcome.greetingNamed', { name })
    : t('welcome.greeting');

  return (
    <View className="flex-row items-center justify-center gap-3 px-4">
      <AliaMark size={38} />
      <Text className="text-4xl tracking-tight text-foreground">
        {greeting}
      </Text>
    </View>
  );
};
