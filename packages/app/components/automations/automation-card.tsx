import {
  actorLabel,
  automationTitle,
  canRunNow,
  humanizeIdentifier,
  policyReason,
  triggerLabel,
} from '@/lib/automations/format';
import type {
  AutomationDefinition,
  AutomationRun,
} from '@/lib/automations/types';
import {
  automationLifecycle,
  lifecycleLabel,
} from '@/lib/automations/work-items';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import {
  Card,
  CardDescription,
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
 * The heading is the NAME the person gave it and the objective (for a legacy
 * trigger, the prompt) sits underneath — two automations with the same prompt
 * must read as two different things, and every accessibility label names the
 * automation the same way the heading does (#534). Only when there is no name
 * does the objective stand in.
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
  const compact = variant === 'compact';
  const title = automationTitle(automation);
  const hasName = Boolean(automation.name?.trim());
  const lifecycle = lifecycleLabel(automationLifecycle(automation, latestRun));
  const lastReason = policyReason(latestRun);
  const iconProps = { width: 16, height: 16, fill: colors.textSecondary };

  return (
    <Card appearance="outline" accessibilityLabel={`Automation ${title}`}>
      <Item
        title={<CardTitle>{title}</CardTitle>}
        subtitle={
          hasName ? (
            <CardDescription numberOfLines={compact ? 2 : undefined}>
              {automation.objective}
            </CardDescription>
          ) : undefined
        }
        trailing={
          <Switch
            accessibilityLabel={`${automation.enabled ? 'Pause' : 'Resume'} ${title}`}
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
          {compact ? (
            <StatusBadge label="Automation" />
          ) : automation.legacyTriggerId ? (
            <StatusBadge label="Legacy transition" tone="warning" />
          ) : null}
        </View>
      </Item>
      <Item
        density="compact"
        leading={<RiTimeLine {...iconProps} />}
        title={<Muted>{triggerLabel(automation.trigger)}</Muted>}
      />
      {compact ? null : (
        <Item
          density="compact"
          leading={<RiUserLine {...iconProps} />}
          title={
            <Muted>
              {actorLabel(
                automation.actorSelection,
                agentName,
                Boolean(automation.legacyTriggerId),
              )}
            </Muted>
          }
        />
      )}
      {latestRun ? (
        <Item
          density="compact"
          title={<Muted>{compact ? 'Latest run' : 'Latest decision'}</Muted>}
          subtitle={lastReason ? <Muted>{lastReason}</Muted> : undefined}
          trailing={
            <StatusBadge
              label={humanizeIdentifier(latestRun.status)}
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
              accessibilityLabel={`Run ${title}`}
              disabled={controlsDisabled || !automation.enabled}
              onPress={() => onRun(automation)}
            >
              Run now
            </Button>
          ) : null}
          {automation.enabled ? (
            <Button
              tone="danger"
              appearance="plain"
              size="sm"
              leadingIcon={RiStopFill}
              accessibilityRole="button"
              accessibilityLabel={`Stop ${title}`}
              disabled={controlsDisabled}
              onPress={() => onStop(automation)}
            >
              {automation.legacyTriggerId ? 'Stop' : 'Stop and revoke'}
            </Button>
          ) : compact ? null : (
            <StatusBadge label="Stopped" />
          )}
          <Button
            tone="neutral"
            appearance="plain"
            size="sm"
            className="ml-auto"
            accessibilityRole="button"
            accessibilityLabel={`View history for ${title}`}
            disabled={controlsDisabled}
            onPress={() => onViewHistory(automation)}
          >
            {compact ? 'History' : 'View history'}
          </Button>
        </View>
      </CardFooter>
    </Card>
  );
}
