import { useEmailAlerts } from '@/features/settings/runtime/use-email-alerts';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Switch } from '@oxy.so/bloom/switch';
import { View } from 'react-native';

/** This page's own strings. */
const K = 'settings.assistant.proactive';

/**
 * When Alia and the agents may write first.
 *
 * Today one thing: an important email. Alia about the person's own Inbox; each
 * agent the person owns about its OWN mailbox (a sign-up verification, a reply
 * to something it sent). On by default; the limits (three a day, none while
 * the last two are unanswered) are the same for everybody and not a setting.
 */
export function ProactiveSection() {
  const { t } = useTranslation();
  const { alerts, loading, failed, setEnabled } = useEmailAlerts();

  if (loading) {
    return (
      <SettingsCard>
        <SettingsRow label={t('common.loading')}>
          <Skeleton.Box width={52} height={28} borderRadius={14} />
        </SettingsRow>
      </SettingsCard>
    );
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

      <SettingsSection label={t(`${K}.agentsTitle`)}>
        <SettingsCard>
          {alerts.agents.length === 0 ? (
            <SettingsRow label={t(`${K}.noAgents`)} />
          ) : (
            alerts.agents.map((agent) => {
              const name =
                agent.name ?? (agent.handle ? `@${agent.handle}` : t(`${K}.unnamedAgent`));
              return (
                <SettingsRow
                  key={agent.agentId}
                  label={name}
                  description={t(`${K}.agentEmailDescription`, { name })}
                >
                  <Switch
                    accessibilityLabel={t(`${K}.agentEmailLabel`, { name })}
                    checked={agent.enabled}
                    onCheckedChange={(enabled) => setEnabled(agent.agentId, enabled)}
                  />
                </SettingsRow>
              );
            })
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsCard>
        <SettingsRow label={t(`${K}.limitsLabel`)} description={t(`${K}.limitsDescription`)} />
      </SettingsCard>
    </View>
  );
}
