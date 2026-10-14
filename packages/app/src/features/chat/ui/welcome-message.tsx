import { useTranslation } from '@/shared/i18n/use-translation';
import { AliaWelcomeMessage } from '@alia.onl/sdk';
import { getAccountDisplayName } from '@oxy.so/core';
import { useAuth } from '@oxy.so/services';

/**
 * The empty chat's greeting: the SDK chat's `AliaWelcomeMessage` (its mark beside the greeting
 * at display size, centred in the thread), with the app's words.
 */
export const WelcomeMessage = () => {
  const { user, isAuthenticated } = useAuth();
  const { t, locale } = useTranslation();

  // Oxy's own display name (display name, full name, handle…), not a copy of it.
  const greeting =
    isAuthenticated && user
      ? t('welcome.greetingNamed', { name: getAccountDisplayName(user, locale) })
      : t('welcome.greeting');

  return <AliaWelcomeMessage greeting={greeting} />;
};
