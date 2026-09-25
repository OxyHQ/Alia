import {
  actorLabel,
  canRunNow,
  policyReason,
  runStatusLabel,
  triggerLabel,
} from '@/features/automations/model/format';
import { useTranslation } from '@/shared/i18n/use-translation';
import type {
  AutomationDefinition,
  AutomationRun,
} from '@/shared/contracts/automations';
import {
  automationLifecycle,
  lifecycleLabel,
} from '@/features/automations/model/work-items';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  Card,
  CardFooter,
  CardTitle,
} from '@oxy.so/bloom/card';
import { RiPlayLine } from '@oxy.so/bloom/icons/RiPlayLine';
import { RiStopFill } from '@oxy.so/bloom/icons/RiStopFill';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { Item } from '@oxy.so/bloom/item';
import { Switch } from '@oxy.so/bloom/switch';
import { useTheme } from '@oxy.so/bloom/theme';
import type { AccentTone } from '@oxy.so/bloom/theme';
import { Muted } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import {
  automationStatusTone,
  type AutomationPillTone,
} from './automation-pill';

/** The lifecycle and run tones, spoken in Bloom's accent vocabulary. */
const BADGE_TONE: Record<AutomationPillTone, AccentTone> = {
  neutral: 'default',
  positive: 'success',
  warning: 'warning',
  danger: 'error',
};

function StatusBadge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: AutomationPillTone;
}) {
  return (
    <Badge
      size="label-small"
      variant="subtle"
      color={BADGE_TONE[tone]}
      content={label}
    />
  );
}

/**
 * One automation, with its controls.
 *
 * The heading is the objective, and every accessibility label names the
 * automation the same way the heading does (#534).
 *
 * `variant="compact"` is the row the unified Tasks list draws (#537): the
 * lifecycle, the schedule, the latest run and the controls, without the actor
 * and action breakdown the full card carries on the automation's own page.
 */
export function AutomationCard({
  automation,
  latestRun,
  agentName,
  busy,
  controlsDisabled,
  onToggle,
  onRun,
  onStop,
  onViewHistory,
  variant = 'full',
}: {
  automation: AutomationDefinition;
  latestRun?: AutomationRun;
  agentName: (agentId: string) => string;
  busy: boolean;
  controlsDisabled: boolean;
  onToggle: (automation: AutomationDefinition, enabled: boolean) => void;
  onRun: (automation: AutomationDefinition) => void;
  onStop: (automation: AutomationDefinition) => void;
  onViewHistory: (automation: AutomationDefinition) => void;
  variant?: 'full' | 'compact';
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const compact = variant === 'compact';
  const title = automation.objective;
  const lifecycle = lifecycleLabel(automationLifecycle(automation, latestRun), t);
  const lastReason = policyReason(latestRun);
  const iconProps = { width: 16, height: 16, fill: colors.textSecondary };

  return (
    <Card appearance="outline" accessibilityLabel={t('automations.card.label', { title })}>
      <Item
        title={<CardTitle>{title}</CardTitle>}
        trailing={
          <Switch
            accessibilityLabel={t(
              automation.enabled ? 'automations.card.pause' : 'automations.card.resume',
              { title },
            )}
            value={automation.enabled}
            disabled={controlsDisabled}
            onValueChange={(enabled) => onToggle(automation, enabled)}
          />
        }
      />
      <Item density="compact">
        {/* Stacking only: the badges wrap in a row. */}
        <View className="flex-row flex-wrap gap-2">
          <StatusBadge label={lifecycle.label} tone={lifecycle.tone} />
          {compact ? <StatusBadge label={t('automations.card.kind')} /> : null}
        </View>
      </Item>
      <Item
        density="compact"
        leading={<RiTimeLine {...iconProps} />}
        title={<Muted>{triggerLabel(automation.trigger, t)}</Muted>}
      />
      {compact ? null : (
        <Item
          density="compact"
          leading={<RiUserLine {...iconProps} />}
          title={
            <Muted>
              {actorLabel(automation.actorSelection, agentName, t)}
            </Muted>
          }
        />
      )}
      {latestRun ? (
        <Item
          density="compact"
          title={
            <Muted>
              {compact
                ? t('automations.card.latestRun')
                : t('automations.card.latestDecision')}
            </Muted>
          }
          subtitle={lastReason ? <Muted>{lastReason}</Muted> : undefined}
          trailing={
            <StatusBadge
              label={runStatusLabel(latestRun.status, t)}
              tone={automationStatusTone(latestRun.status)}
            />
          }
        />
      ) : null}

      <CardFooter>
        {/* The actions read from the start and wrap; history sits at the end. */}
        <View className="flex-1 flex-row flex-wrap items-center gap-2">
          {canRunNow(automation) ? (
            <Button
              tone="action"
              appearance="subtle"
              size="sm"
              leadingIcon={RiPlayLine}
              loading={busy}
              accessibilityRole="button"
              accessibilityLabel={t('automations.card.runLabel', { title })}
              disabled={controlsDisabled || !automation.enabled}
              onPress={() => onRun(automation)}
            >
              {t('automations.card.runNow')}
            </Button>
          ) : null}
          {automation.enabled ? (
            <Button
              tone="danger"
              appearance="plain"
              size="sm"
              leadingIcon={RiStopFill}
              accessibilityRole="button"
              accessibilityLabel={t('automations.card.stopLabel', { title })}
              disabled={controlsDisabled}
              onPress={() => onStop(automation)}
            >
              {t('automations.card.stop')}
            </Button>
          ) : compact ? null : (
            <StatusBadge label={t('automations.card.stopped')} />
          )}
          <Button
            tone="neutral"
            appearance="plain"
            size="sm"
            className="ml-auto"
            accessibilityRole="button"
            accessibilityLabel={t('automations.card.historyLabel', { title })}
            disabled={controlsDisabled}
            onPress={() => onViewHistory(automation)}
          >
            {compact
              ? t('automations.card.history')
              : t('automations.card.viewHistory')}
          </Button>
        </View>
      </CardFooter>
    </Card>
  );
}
