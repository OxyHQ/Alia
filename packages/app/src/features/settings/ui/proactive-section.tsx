import { useEmailAlerts } from '@/features/notifications/runtime/use-email-alerts';
import { SettingsRowsSkeleton } from '@/shared/ui/skeletons';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { View } from 'react-native';

/** This page's own strings. */
const K = 'settings.assistant.proactive';

/**
 * When Alia and the agents may write first.
 *
 * Today one thing: an important email, Alia about the person's own Inbox. Each agent's own mailbox
 * is a switch in that agent's editor. On by default; the limits (three a day, none while
 * the last two are unanswered) are the same for everybody and not a setting.
 */
export function ProactiveSection() {
  const { t } = useTranslation();
  const { alerts, loading, failed, setEnabled } = useEmailAlerts();

  if (loading) {
    return <SettingsRowsSkeleton control="switch" />;
  }
  if (failed || !alerts) {
    return (
      <SettingsCard>
        <SettingsRow label={t(`${K}.loadFailed`)} />
      </SettingsCard>
    );
  }

  return (
    <View className="w-full gap-6">
      <SettingsSection label={t(`${K}.emailTitle`)}>
        <SettingsCard>
          <SettingsRow
            label={t(`${K}.aliaEmailLabel`)}
            description={t(`${K}.aliaEmailDescription`)}
          >
            <Switch
              accessibilityLabel={t(`${K}.aliaEmailLabel`)}
              checked={alerts.alia.enabled}
              onCheckedChange={(enabled) => setEnabled(null, enabled)}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsCard>
        <SettingsRow label={t(`${K}.limitsLabel`)} description={t(`${K}.limitsDescription`)} />
      </SettingsCard>
    </View>
  );
}
