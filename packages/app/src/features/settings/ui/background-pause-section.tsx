import { useBackgroundPause } from '@/features/agents/runtime/use-agent-attention';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsRowsSkeleton } from '@/shared/ui/skeletons';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';

/** This page's own strings. */
const K = 'settings.assistant.attention';

/** Pause everything the person's agents and Alia would start on their own, and resume it. */
function PauseCard() {
  const { t } = useTranslation();
  const { paused, isPending, isError, change } = useBackgroundPause();

  if (isPending) return <SettingsRowsSkeleton control="switch" rows={1} />;
  if (isError) {
    return (
      <SettingsCard>
        <SettingsRow label={t(`${K}.loadFailed`)} />
      </SettingsCard>
    );
  }
  return (
    <SettingsCard>
      <SettingsRow label={t(`${K}.pauseAll`)} description={t(`${K}.pauseAllDescription`)}>
        <Switch
          accessibilityLabel={t(`${K}.pauseAll`)}
          checked={paused === true}
          disabled={change.isPending}
          onCheckedChange={async (on) => {
            try {
              await change.mutateAsync(on);
            } catch {
              toast.error(t(`${K}.pauseFailed`));
            }
          }}
        />
      </SettingsRow>
    </SettingsCard>
  );
}

/**
 * Pause everything that starts on its own: a section of the memory page. What one agent notices
 * (its heartbeat, what it hears, its inbox) is edited with the agent, in the agent editor.
 */
export function BackgroundPauseSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection label={t(`${K}.pauseTitle`)}>
      <PauseCard />
    </SettingsSection>
  );
}
