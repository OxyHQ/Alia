import { AutomationEditor } from '@/components/automations/automation-editor';
import {
  automationStatusTone,
  type AutomationPillTone,
} from '@/components/automations/automation-pill';
import {
  actorLabel,
  automationTitle,
  triggerLabel,
} from '@/lib/automations/format';
import type { AutomationUpdateInput } from '@/lib/automations/types';
import { errorMessage } from '@/lib/errors/error-utils';
import {
  useAutomationOverview,
  useAutomationRuns,
  useUpdateAutomation,
} from '@/lib/hooks/use-automations';
import { useMyAgents } from '@/lib/hooks/use-my-agents';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiPencilLine } from '@oxy.so/bloom/icons/RiPencilLine';
import { Loading } from '@oxy.so/bloom/loading';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

const RUN_PAGE_SIZE = 20;

/** Stacking only: the column the page reads in. */
const CONTENT = {
  width: '100%',
  maxWidth: 768,
  alignSelf: 'center',
  paddingHorizontal: 16,
  paddingVertical: 16,
  gap: 20,
} as const;
/** Stacking only: a row of actions or badges. */
const ROW = {
  flexDirection: 'row',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
} as const;
const SPREAD = { ...ROW, justifyContent: 'space-between' } as const;
/** Stacking only: a vertical group. */
const STACK = { gap: 8 } as const;

/** The run status tones, in `Badge`'s palette. */
const BADGE_COLOR = {
  positive: 'success',
  warning: 'warning',
  danger: 'error',
  neutral: 'default',
} as const satisfies Record<AutomationPillTone, string>;

export default function AutomationHistoryScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const overview = useAutomationOverview();
  const runs = useAutomationRuns(id);
  const agents = useMyAgents();
  const updateAutomation = useUpdateAutomation();
  const [editorOpen, setEditorOpen] = useState(false);
  const [visibleRuns, setVisibleRuns] = useState(RUN_PAGE_SIZE);
  const automation = overview.data?.automations.find(
    (candidate) => candidate.id === id,
  );
  const agentNames = useMemo(
    () =>
      new Map(
        (agents.data ?? []).map((agent) => [
          agent._id,
          agent.name ?? agent.handle ?? `Agent ${agent._id.slice(0, 8)}`,
        ]),
      ),
    [agents.data],
  );
  const agentName = useCallback(
    (agentId: string) =>
      agentNames.get(agentId) ?? `Agent ${agentId.slice(0, 8)}`,
    [agentNames],
  );
  const agentOptions = useMemo(
    () =>
      (agents.data ?? []).map((agent) => ({
        id: agent._id,
        label: agent.name ?? agent.handle ?? `Agent ${agent._id.slice(0, 8)}`,
      })),
    [agents.data],
  );

  const timestampLabel = (timestamp: string | null): string => {
    if (!timestamp) return t('pages.automations.notStarted');
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
      ? t('pages.automations.unknownTime')
      : date.toLocaleString();
  };

  if (overview.isLoading || runs.isLoading) {
    return <Loading variant="spinner" />;
  }

  if (overview.isError || runs.isError) {
    return (
      <EmptyState
        title={t('pages.automations.historyLoadFailed')}
        action={{
          label: t('common.tryAgain'),
          onPress: () =>
            void Promise.all([overview.refetch(), runs.refetch()]),
        }}
      />
    );
  }

  if (!automation) {
    return (
      <EmptyState
        title={t('pages.automations.notFound')}
        action={{ label: t('common.back'), onPress: () => router.back() }}
      />
    );
  }

  const history = runs.data ?? [];
  const displayedRuns = history.slice(0, visibleRuns);
  const saveUpdate = async (update: AutomationUpdateInput) => {
    try {
      const result = await updateAutomation.mutateAsync({
        automationId: automation.id,
        update,
      });
      if (result.revocation?.failed) {
        toast.error(
          t('pages.automations.savedRevocationFailed', {
            count: result.revocation.failed,
          }),
        );
      } else {
        toast.success(t('pages.automations.saved'));
      }
      setEditorOpen(false);
    } catch (error: unknown) {
      toast.error(errorMessage(error, t('pages.automations.saveFailed')));
    }
  };

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={CONTENT}
      >
        <View style={SPREAD}>
          <Button
            tone="neutral"
            appearance="plain"
            size="sm"
            icon={RiArrowLeftLine}
            accessibilityLabel={t('common.back')}
            onPress={() => router.back()}
          />
          {!automation.legacyTriggerId ? (
            <Button
              tone="neutral"
              appearance="subtle"
              size="sm"
              leadingIcon={RiPencilLine}
              onPress={() => setEditorOpen(true)}
            >
              {t('common.edit')}
            </Button>
          ) : null}
        </View>

        <View style={STACK}>
          {/* The heading is the name; the objective (a legacy trigger's prompt) reads under it (#534). */}
          <Text variant="title-2-semibold" selectable>
            {automationTitle(automation)}
          </Text>
          <View style={ROW}>
            <Badge
              size="label-medium"
              variant="subtle"
              color={automation.enabled ? 'success' : 'default'}
              content={
                automation.enabled
                  ? t('pages.automations.active')
                  : t('pages.automations.stopped')
              }
            />
            {automation.legacyTriggerId ? (
              <Badge
                size="label-medium"
                variant="subtle"
                color="warning"
                content={t('pages.automations.legacy')}
              />
            ) : null}
          </View>
          {automation.name?.trim() ? (
            <Text variant="body-regular" selectable>
              {automation.objective}
            </Text>
          ) : null}
          <Muted selectable>{triggerLabel(automation.trigger)}</Muted>
          <Muted selectable>
            {t('pages.automations.actors', {
              actors: actorLabel(
                automation.actorSelection,
                agentName,
                Boolean(automation.legacyTriggerId),
              ),
            })}
          </Muted>
          {automation.actions.length > 0 ? (
            <Muted selectable>{t('pages.automations.usesConnectedApps')}</Muted>
          ) : null}
        </View>

        {displayedRuns.length > 0 ? (
          <SettingsListGroup
            title={t('pages.automations.runHistory')}
            footer={t('pages.automations.runCount', { count: history.length })}
          >
            {displayedRuns.map((run) => (
              <SettingsListItem
                key={run.id}
                title={timestampLabel(run.startedAt)}
                description={
                  run.selectedAgentId ? agentName(run.selectedAgentId) : 'Alia'
                }
                rightElement={
                  <Badge
                    size="label-small"
                    variant="subtle"
                    color={BADGE_COLOR[automationStatusTone(run.status)]}
                    content={run.status}
                  />
                }
              />
            ))}
          </SettingsListGroup>
        ) : (
          <EmptyState
            variant="compact"
            title={t('pages.automations.runHistory')}
            description={t('pages.automations.noRuns')}
          />
        )}
        {visibleRuns < history.length ? (
          <Button
            tone="neutral"
            appearance="subtle"
            onPress={() => setVisibleRuns((count) => count + RUN_PAGE_SIZE)}
          >
            {t('pages.automations.showMore')}
          </Button>
        ) : null}
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
    </>
  );
}
