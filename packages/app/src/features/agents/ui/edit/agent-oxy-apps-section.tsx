import type { ReactNode } from 'react';
import { Linking } from 'react-native';
import type { AgentOxyApps, OxyAppLevel } from '@/features/agents/runtime/use-agent-oxy-apps';
import { useTranslation } from '@/shared/i18n/use-translation';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';

const LEVEL_LABELS: Record<OxyAppLevel, string> = {
  none: 'agents.oxyApps.none',
  read: 'agents.oxyApps.read',
  act: 'agents.oxyApps.act',
};

/**
 * "Apps de Oxy": what of its OWNER's data the agent may use, one row per Oxy
 * app with three levels — *Nada* · *Ver* · *Ver y actuar* (ADR 0015).
 *
 * Every app starts at *Nada*; the owner turns on what the agent needs. The
 * agent's own account (its own inbox) is not here: it is the agent's, so there
 * is nothing to grant. The accounts app's Agency tab is the advanced view of
 * the same grants.
 *
 * Shown only to the owner — anybody else is answered 403 and sees nothing.
 */
export function AgentOxyAppsSection({ oxyApps }: { oxyApps: AgentOxyApps }) {
  const { t } = useTranslation();
  return (
    <AppLevelsSection levels={oxyApps} copy="agents.oxyApps">
      <SettingsListItem
        title={t('agents.templates.organizationAccess')}
        description={t('agents.templates.organizationAccessHint')}
        accessibilityRole="link"
        onPress={() => void Linking.openURL('https://accounts.oxy.so/agency')}
      />
    </AppLevelsSection>
  );
}

/**
 * "Para quien lo usa": what the agent may do, per Oxy app, on the data of
 * WHOEVER uses it — its published ceiling (ADR 0020 §2, Oxy ADR 0042). The
 * person using a public or shared agent gets at most this on their OWN
 * account; the owner's data is never reached this way.
 *
 * Shown to whoever operates the agent, an app's project operator included;
 * anybody else is answered 403 and sees nothing.
 */
export function AgentRequesterAppsSection({ requesterApps }: { requesterApps: AgentOxyApps }) {
  return (
    <AppLevelsSection
      levels={requesterApps}
      copy="agents.requesterApps"
      testIdPrefix="requester-app-level"
    />
  );
}

/** One row per Oxy app with its levels, under a title and an explaining footer. */
function AppLevelsSection({
  levels,
  copy,
  testIdPrefix = 'oxy-app-level',
  children,
}: {
  levels: AgentOxyApps;
  /** The catalog prefix of `title`, `footer`, `loadFailed` and `levelLabel`. */
  copy: 'agents.oxyApps' | 'agents.requesterApps';
  testIdPrefix?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { apps, status, setLevel } = levels;
  if (status === 'hidden' || status === 'loading') return null;

  return (
    <SettingsListGroup
      title={t(`${copy}.title`)}
      footer={status === 'failed' ? t(`${copy}.loadFailed`) : t(`${copy}.footer`)}
    >
      {children}
      {apps.map((app) => (
        <SettingsListItem
          key={app.appId}
          title={app.name}
          showChevron={false}
          rightElement={
            <SegmentedControl
              testID={`${testIdPrefix}-${app.appId}`}
              label={t(`${copy}.levelLabel`, { app: app.name })}
              type="radio"
              size="xs"
              value={app.level}
              onValueChange={(next: string) => setLevel(app, next as OxyAppLevel)}
            >
              {app.levels.map((level) => (
                <SegmentedControlItem key={level} value={level}>
                  <SegmentedControlItemText>{t(LEVEL_LABELS[level])}</SegmentedControlItemText>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          }
        />
      ))}
    </SettingsListGroup>
  );
}
