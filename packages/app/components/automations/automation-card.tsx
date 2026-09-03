import { ActivityIndicator, Pressable, View } from 'react-native';
import { Clock, Play, ShieldCheck, Square, Users } from 'lucide-react-native';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import {
  actorLabel,
  autonomyLabel,
  canRunNow,
  humanizeIdentifier,
  policyReason,
  resourceLabel,
  triggerLabel,
} from '@/lib/automations/format';
import type { AutomationDefinition, AutomationRun } from '@/lib/automations/types';
import { useColorScheme } from '@/lib/useColorScheme';
import { AutomationPill, automationStatusTone } from './automation-pill';

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
}) {
  const { colors } = useColorScheme();
  const lastReason = policyReason(latestRun);
  const actionSummary = automation.actions.length > 0
    ? automation.actions.map((action) => (
      `${resourceLabel(action.resource)} · ${action.tool}`
    )).join(' → ')
    : automation.legacyTriggerId
      ? 'Legacy prompt execution'
      : automation.resources.length > 0
        ? automation.resources.map((resource) => (
          resourceLabel(resource)
        )).join(' → ')
        : 'No effectful actions configured';

  return (
    <View className="rounded-2xl border border-border bg-surface p-4 gap-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-2">
          <Text className="text-base font-semibold text-foreground" selectable>{automation.objective}</Text>
          <View className="flex-row flex-wrap gap-2">
            <AutomationPill label={automation.executionMode === 'observe' ? 'Observe' : 'Execute'} />
            <AutomationPill label={autonomyLabel(automation.maximumAutonomy)} />
            {automation.legacyTriggerId ? (
              <AutomationPill label="Legacy transition" tone="warning" />
            ) : null}
          </View>
        </View>
        <Switch
          value={automation.enabled}
          disabled={controlsDisabled}
          onValueChange={(enabled) => onToggle(automation, enabled)}
        />
      </View>

      <View className="gap-2">
        <View className="flex-row items-center gap-2">
          <Clock size={14} color={colors.mutedForeground} />
          <Text className="flex-1 text-xs text-muted-foreground" selectable>
            {triggerLabel(automation.trigger)}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Users size={14} color={colors.mutedForeground} />
          <Text className="flex-1 text-xs text-muted-foreground" selectable>
            {actorLabel(automation.actorSelection, agentName, Boolean(automation.legacyTriggerId))}
          </Text>
        </View>
        <View className="flex-row items-start gap-2">
          <ShieldCheck size={14} color={colors.mutedForeground} />
          <Text className="flex-1 text-xs text-muted-foreground" selectable>{actionSummary}</Text>
        </View>
      </View>

      {latestRun ? (
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
      ) : null}

      <View className="flex-row items-center gap-2">
        {canRunNow(automation) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Run ${automation.objective}`}
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
            accessibilityLabel={`Stop ${automation.objective}`}
            disabled={controlsDisabled}
            onPress={() => onStop(automation)}
            className="flex-row items-center rounded-lg px-3 py-2 active:bg-destructive/10 disabled:opacity-40"
          >
            <Square size={13} className="text-destructive" />
            <Text className="ml-1.5 text-xs font-medium text-destructive">
              {automation.legacyTriggerId ? 'Stop' : 'Stop and revoke'}
            </Text>
          </Pressable>
        ) : (
          <AutomationPill label="Stopped" />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`View history for ${automation.objective}`}
          disabled={controlsDisabled}
          onPress={() => onViewHistory(automation)}
          className="ml-auto rounded-lg px-3 py-2 active:bg-muted disabled:opacity-40"
        >
          <Text className="text-xs font-medium text-foreground">View history</Text>
        </Pressable>
      </View>
    </View>
  );
}
