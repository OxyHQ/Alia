import { useTranslation } from '@/shared/i18n/use-translation';
import { ALIA_GEMIE_ID, GemieAccounts } from '@gemies/sdk/accounts';
import { SettingsCard, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { View } from 'react-native';

/**
 * The WhatsApp and Telegram accounts the person linked to Alia (Gemies ADR 0035). An account
 * belongs to one gemie; here it is always Alia's. The panel is the SDK's (`@gemies/sdk/accounts`),
 * the same one the Gemies app draws in each gemie's editor; this page gives it its card.
 */
export function AccountsSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection label={t('gemie.accounts.title')}>
      <SettingsCard>
        <View className="px-4">
          <GemieAccounts gemieId={ALIA_GEMIE_ID} name="Alia" t={t} />
        </View>
      </SettingsCard>
    </SettingsSection>
  );
}
