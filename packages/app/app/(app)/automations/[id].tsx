import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ContentPanel } from '@oxyhq/bloom/content-panel';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { AutomationPill, automationStatusTone } from '@/components/automations/automation-pill';
import {
  actorLabel,
  autonomyLabel,
  decisionReason,
  humanizeIdentifier,
  policyReason,
  resourceLabel,
  triggerLabel,
} from '@/lib/automations/format';
import type { AutomationRun } from '@/lib/automations/types';
import {
  useAutomationOverview,
  useAutomationRuns,
  useAutomationRunSteps,
} from '@/lib/hooks/use-automations';
import { useMyAgents } from '@/lib/hooks/use-my-agents';
import { useColorScheme } from '@/lib/useColorScheme';

const RUN_PAGE_SIZE = 20;

function timestampLabel(timestamp: string | null): string {
  if (!timestamp) return 'Not started';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
}

function RunCard({
  run,
  agentName,
}: {
  run: AutomationRun;
  agentName: (agentId: string) => string;
}) {
  const { colors } = useColorScheme();
  const [expanded, setExpanded] = useState(false);
  const steps = useAutomationRunSteps(run.id, expanded);
  const reason = policyReason(run);

  return (
    <View className="rounded-2xl border border-border bg-surface p-4 gap-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text className="text-sm font-medium text-foreground" selectable>
            {timestampLabel(run.startedAt)}
          </Text>
          <Text className="text-xs text-muted-foreground" selectable>
            {run.selectedAgentId ? agentName(run.selectedAgentId) : 'Alia'}
          </Text>
        </View>
        <AutomationPill
          label={humanizeIdentifier(run.status)}
          tone={automationStatusTone(run.status)}
        />
      </View>

      {reason ? (
        <Text className="text-xs text-muted-foreground" selectable>
          Policy: {reason}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
        className="flex-row items-center self-start rounded-lg py-1.5 active:opacity-60"
      >
        <Text className="mr-1 text-xs font-medium text-primary">
          {expanded ? 'Hide steps' : 'View steps'}
        </Text>
        {expanded ? (
          <ChevronUp size={14} color={colors.primary} />
        ) : (
          <ChevronDown size={14} color={colors.primary} />
        )}
      </Pressable>

      {expanded ? (
        steps.isLoading ? (
          <ActivityIndicator size="small" color={colors.mutedForeground} />
        ) : steps.isError ? (
          <View className="items-start gap-2">
            <Text className="text-xs text-destructive" selectable>Could not load run steps.</Text>
            <Button size="sm" variant="outline" onPress={() => void steps.refetch()}>Retry</Button>
          </View>
        ) : steps.data && steps.data.length > 0 ? (
          <View className="gap-2">
            {steps.data.map((step) => {
              const stepReason = decisionReason(step.policyDecision);
              const actor = step.actorType === 'agent' && step.agentId
                ? agentName(step.agentId)
                : 'Alia';
              return (
                <View key={step.id} className="rounded-xl bg-muted p-3 gap-1.5">
                  <View className="flex-row items-start justify-between gap-2">
                    <Text className="flex-1 text-xs font-medium text-foreground" selectable>
                      {step.position + 1}. {step.tool}
                    </Text>
                    <AutomationPill
                      label={humanizeIdentifier(step.status)}
                      tone={automationStatusTone(step.status)}
                    />
                  </View>
                  <Text className="text-xs text-muted-foreground" selectable>
                    {resourceLabel(step.resource)} · {actor}
                  </Text>
                  {stepReason ? (
                    <Text className="text-xs text-muted-foreground" selectable>
                      Policy: {stepReason}
                    </Text>
                  ) : null}
                  {step.auditEventId ? (
                    <Text className="text-[11px] text-muted-foreground" selectable>
                      Audit: {step.auditEventId}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : (
          <Text className="text-xs text-muted-foreground" selectable>No recorded steps.</Text>
        )
      ) : null}
    </View>
  );
}

export default function AutomationHistoryScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useColorScheme();
  const overview = useAutomationOverview();
  const runs = useAutomationRuns(id);
  const agents = useMyAgents();
  const [visibleRuns, setVisibleRuns] = useState(RUN_PAGE_SIZE);
  const automation = overview.data?.automations.find((candidate) => candidate.id === id);
  const agentNames = useMemo(() => new Map(
    (agents.data ?? []).map((agent) => [
      agent._id,
      agent.name ?? agent.handle ?? `Agent ${agent._id.slice(0, 8)}`,
    ]),
  ), [agents.data]);
  const agentName = useCallback(
    (agentId: string) => agentNames.get(agentId) ?? `Agent ${agentId.slice(0, 8)}`,
    [agentNames],
  );

  if (overview.isLoading || runs.isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  if (overview.isError || runs.isError) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6 gap-3">
        <Text className="text-sm text-muted-foreground text-center" selectable>
          Could not load this automation history.
        </Text>
        <Button
          size="sm"
          variant="outline"
          onPress={() => void Promise.all([overview.refetch(), runs.refetch()])}
        >
          Retry
        </Button>
      </View>
    );
  }

  if (!automation) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6 gap-3">
        <Text className="text-sm text-muted-foreground" selectable>Automation not found.</Text>
        <Button size="sm" variant="outline" onPress={() => router.back()}>Go back</Button>
      </View>
    );
  }

  const history = runs.data ?? [];
  const displayedRuns = history.slice(0, visibleRuns);

  return (
    <ContentPanel surfaceClassName="bg-background">
      <ScrollView
        className="flex-1 bg-background"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="px-5 py-4 gap-5 max-w-3xl w-full mx-auto"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to automations"
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-muted"
        >
          <ArrowLeft size={18} color={colors.foreground} />
        </Pressable>

        <View className="gap-3">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="flex-1 text-2xl font-bold text-foreground" selectable>
              {automation.objective}
            </Text>
            <AutomationPill
              label={automation.enabled ? 'Active' : 'Stopped'}
              tone={automation.enabled ? 'positive' : 'neutral'}
            />
            <AutomationPill label={autonomyLabel(automation.maximumAutonomy)} />
            {automation.legacyTriggerId ? (
              <AutomationPill label="Legacy transition" tone="warning" />
            ) : null}
          </View>
          <Text className="text-sm text-muted-foreground" selectable>
            {triggerLabel(automation.trigger)}
          </Text>
          <Text className="text-sm text-muted-foreground" selectable>
            Actors: {actorLabel(
              automation.actorSelection,
              agentName,
              Boolean(automation.legacyTriggerId),
            )}
          </Text>
          {automation.resources.map((resource) => (
            <Text
              key={`${resource.appId}:${resource.effectiveAccountId}:${resource.resourceType}:${resource.resourceId}`}
              className="text-xs text-muted-foreground"
              selectable
            >
              Resource: {resourceLabel(resource)}
            </Text>
          ))}
          {automation.actions.map((action) => (
            <Text key={action.id} className="text-xs text-muted-foreground" selectable>
              Action: {resourceLabel(action.resource)} · {action.tool}
            </Text>
          ))}
        </View>

        <View className="gap-3">
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-lg font-semibold text-foreground">Run history</Text>
            <Text className="text-xs text-muted-foreground" selectable>{history.length} runs</Text>
          </View>
          {displayedRuns.length > 0 ? displayedRuns.map((run) => (
            <RunCard key={run.id} run={run} agentName={agentName} />
          )) : (
            <View className="rounded-2xl border border-border bg-surface p-4">
              <Text className="text-sm text-muted-foreground" selectable>No runs recorded yet.</Text>
            </View>
          )}
          {visibleRuns < history.length ? (
            <Button
              variant="outline"
              onPress={() => setVisibleRuns((count) => count + RUN_PAGE_SIZE)}
            >
              Show more
            </Button>
          ) : null}
        </View>
      </ScrollView>
    </ContentPanel>
  );
}
