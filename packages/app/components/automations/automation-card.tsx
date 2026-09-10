import { ActivityIndicator, Pressable, View } from 'react-native';
import { Clock, Play, Square, Users } from 'lucide-react-native';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import {
  actorLabel,
  automationTitle,
  canRunNow,
  humanizeIdentifier,
  policyReason,
  triggerLabel,
} from '@/lib/automations/format';
import type { AutomationDefinition, AutomationRun } from '@/lib/automations/types';
import { automationLifecycle, lifecycleLabel } from '@/lib/automations/work-items';
import { useColorScheme } from '@/lib/useColorScheme';
import { AutomationPill, automationStatusTone } from './automation-pill';

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
  const { colors } = useColorScheme();
  const compact = variant === 'compact';
  const title = automationTitle(automation);
  const hasName = Boolean(automation.name?.trim());
  const lifecycle = lifecycleLabel(automationLifecycle(automation, latestRun));
  const lastReason = policyReason(latestRun);

  return (
    <View
      className="rounded-2xl border border-border bg-surface p-4 gap-3"
      accessibilityLabel={`Automation ${title}`}
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1.5">
          <Text className="text-base font-semibold text-foreground" selectable>{title}</Text>
          {hasName ? (
            <Text
              className="text-sm text-muted-foreground"
              numberOfLines={compact ? 2 : undefined}
              selectable
            >
              {automation.objective}
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            <AutomationPill label={lifecycle.label} tone={lifecycle.tone} />
            {compact ? (
              <AutomationPill label="Automation" />
            ) : (
              <>
                {automation.legacyTriggerId ? (
                  <AutomationPill label="Legacy transition" tone="warning" />
                ) : null}
              </>
            )}
          </View>
        </View>
        <View accessibilityLabel={`${automation.enabled ? 'Pause' : 'Resume'} ${title}`}>
          <Switch
            value={automation.enabled}
            disabled={controlsDisabled}
            onValueChange={(enabled) => onToggle(automation, enabled)}
          />
        </View>
      </View>

      <View className="gap-2">
        <View className="flex-row items-center gap-2">
          <Clock size={14} color={colors.mutedForeground} />
          <Text className="flex-1 text-xs text-muted-foreground" selectable>
            {triggerLabel(automation.trigger)}
          </Text>
        </View>
        {compact ? null : (
          <>
            <View className="flex-row items-center gap-2">
              <Users size={14} color={colors.mutedForeground} />
              <Text className="flex-1 text-xs text-muted-foreground" selectable>
                {actorLabel(automation.actorSelection, agentName, Boolean(automation.legacyTriggerId))}
              </Text>
            </View>
          </>
        )}
      </View>

      {latestRun ? (
        compact ? (
          <View className="flex-row items-center gap-2">
            <Text className="text-xs text-muted-foreground">Latest run</Text>
            <AutomationPill
              label={humanizeIdentifier(latestRun.status)}
              tone={automationStatusTone(latestRun.status)}
            />
            {lastReason ? (
              <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1} selectable>
                {lastReason}
              </Text>
            ) : null}
          </View>
        ) : (
          <View className="rounded-xl bg-muted p-3 gap-1">
            <View className="flex-row items-center justify-between gap-2">
              <Text className="text-xs font-medium text-foreground">Latest decision</Text>
              <AutomationPill
                label={humanizeIdentifier(latestRun.status)}
                tone={automationStatusTone(latestRun.status)}
              />
            </View>
            {lastReason ? (
              <Text className="text-xs text-muted-foreground" selectable>{lastReason}</Text>
            ) : null}
          </View>
        )
      ) : null}

      <View className="flex-row flex-wrap items-center gap-2">
        {canRunNow(automation) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Run ${title}`}
            disabled={controlsDisabled || !automation.enabled}
            onPress={() => onRun(automation)}
            className="flex-row items-center rounded-lg bg-primary/10 px-3 py-2 active:bg-primary/20 disabled:opacity-40"
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Play size={14} color={colors.primary} />
            )}
            <Text className="ml-1.5 text-xs font-medium text-primary">Run now</Text>
          </Pressable>
        ) : null}
        {automation.enabled ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Stop ${title}`}
            disabled={controlsDisabled}
            onPress={() => onStop(automation)}
            className="flex-row items-center rounded-lg px-3 py-2 active:bg-destructive/10 disabled:opacity-40"
          >
            <Square size={13} className="text-destructive" />
            <Text className="ml-1.5 text-xs font-medium text-destructive">
              {automation.legacyTriggerId ? 'Stop' : 'Stop and revoke'}
            </Text>
          </Pressable>
        ) : compact ? null : (
          <AutomationPill label="Stopped" />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`View history for ${title}`}
          disabled={controlsDisabled}
          onPress={() => onViewHistory(automation)}
          className="ml-auto rounded-lg px-3 py-2 active:bg-muted disabled:opacity-40"
        >
          <Text className="text-xs font-medium text-foreground">
            {compact ? 'History' : 'View history'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
