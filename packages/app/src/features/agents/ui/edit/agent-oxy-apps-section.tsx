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
  const { apps, status, setLevel } = oxyApps;
  if (status === 'hidden' || status === 'loading') return null;
  if (status === 'ready' && apps.length === 0) return null;

  return (
    <SettingsListGroup
      title={t('agents.oxyApps.title')}
      footer={status === 'failed' ? t('agents.oxyApps.loadFailed') : t('agents.oxyApps.footer')}
    >
      {apps.map((app) => (
        <SettingsListItem
          key={app.appId}
          title={app.name}
          showChevron={false}
          rightElement={
            <SegmentedControl
              testID={`oxy-app-level-${app.appId}`}
              label={t('agents.oxyApps.levelLabel', { app: app.name })}
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
