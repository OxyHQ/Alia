import { useTranslation } from '@/shared/i18n/use-translation';
import { GemieConnectedAccounts } from '@gemies/sdk/accounts';
import { SettingsCard, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { View } from 'react-native';

/**
 * Settings › Connected accounts (Gemies ADR 0035 as amended): the person's WhatsApp and Telegram,
 * connected once and granted to the gemies that may use them, Alia among them, at most one of
 * which answers each on its own. The panel is the SDK's (`@gemies/sdk/accounts`), the same one the
 * Gemies app draws in its Settings; this page gives it its card.
 */
export function AccountsSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection label={t('gemie.accounts.title')}>
      <SettingsCard>
        <View className="px-4">
          <GemieConnectedAccounts t={t} />
        </View>
      </SettingsCard>
    </SettingsSection>
  );
}
