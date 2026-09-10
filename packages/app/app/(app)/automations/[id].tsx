import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { ArrowLeft, Pencil } from 'lucide-react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ContentPanel } from '@oxy.so/bloom/content-panel';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { AutomationEditor } from '@/components/automations/automation-editor';
import { AutomationPill, automationStatusTone } from '@/components/automations/automation-pill';
import {
  actorLabel,
  automationTitle,
  triggerLabel,
} from '@/lib/automations/format';
import type { AutomationRun, AutomationUpdateInput } from '@/lib/automations/types';
import { useAutomationOverview, useAutomationRuns, useUpdateAutomation } from '@/lib/hooks/use-automations';
import { useMyAgents } from '@/lib/hooks/use-my-agents';
import { useColorScheme } from '@/lib/useColorScheme';
import { errorMessage } from '@/lib/errors/error-utils';

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
        <AutomationPill label={run.status} tone={automationStatusTone(run.status)} />
      </View>
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
  const updateAutomation = useUpdateAutomation();
  const [editorOpen, setEditorOpen] = useState(false);
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
  const agentOptions = useMemo(() => (agents.data ?? []).map((agent) => ({
    id: agent._id,
    label: agent.name ?? agent.handle ?? `Agent ${agent._id.slice(0, 8)}`,
  })), [agents.data]);

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
  const saveUpdate = async (update: AutomationUpdateInput) => {
    try {
      const result = await updateAutomation.mutateAsync({ automationId: automation.id, update });
      if (result.revocation?.failed) {
        toast.error(`Saved, but ${result.revocation.failed} old authorizations could not be revoked`);
      } else {
        toast.success('Automation updated and authority revalidated');
      }
      setEditorOpen(false);
    } catch (error: unknown) {
      toast.error(errorMessage(error, 'Failed to update automation'));
    }
  };

  return (
    <ContentPanel surfaceClassName="bg-background">
      <ScrollView
        className="flex-1 bg-background"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="px-5 py-4 gap-5 max-w-3xl w-full mx-auto"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          className="h-9 w-9 items-center justify-center rounded-full active:bg-muted"
        >
          <ArrowLeft size={18} color={colors.foreground} />
        </Pressable>

        <View className="gap-3">
          {/* The heading is the name; the objective (a legacy trigger's prompt) reads under it (#534). */}
          <View className="flex-row flex-wrap items-center gap-2">
            <Text className="flex-1 text-2xl font-bold text-foreground" selectable>
              {automationTitle(automation)}
            </Text>
            <AutomationPill
              label={automation.enabled ? 'Active' : 'Stopped'}
              tone={automation.enabled ? 'positive' : 'neutral'}
            />
            {automation.legacyTriggerId ? (
              <AutomationPill label="Legacy transition" tone="warning" />
            ) : null}
            {!automation.legacyTriggerId ? (
              <Button
                size="sm"
                variant="outline"
                onPress={() => setEditorOpen(true)}
                className="ml-auto"
              >
                <Pencil size={14} color={colors.foreground} />
                <Text>Edit</Text>
              </Button>
            ) : null}
          </View>
          {automation.name?.trim() ? (
            <Text className="text-base text-foreground" selectable>
              {automation.objective}
            </Text>
          ) : null}
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
          {automation.actions.length > 0 ? (
            <Text className="text-xs text-muted-foreground" selectable>
              Uses approved connected apps
            </Text>
          ) : null}
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
      {!automation.legacyTriggerId ? (
        <AutomationEditor
          key={`${automation.updatedAt}:${editorOpen}`}
          automation={automation}
          agents={agentOptions}
          open={editorOpen}
          saving={updateAutomation.isPending}
          onClose={() => setEditorOpen(false)}
          onSave={saveUpdate}
        />
      ) : null}
    </ContentPanel>
  );
}
