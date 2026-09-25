import { AutomationEditor } from '@/components/automations/automation-editor';
import {
  automationStatusTone,
  type AutomationPillTone,
} from '@/components/automations/automation-pill';
import {
  actorLabel,
  triggerLabel,
} from '@/lib/automations/format';
import type { AutomationUpdateInput } from '@/lib/automations/types';
import { errorMessage } from '@/lib/errors/error-utils';
import {
  useAutomationOverview,
  useAutomationRuns,
  useUpdateAutomation,
} from '@/lib/hooks/use-automations';
import { agentLabel, useAgentNames } from '@/lib/hooks/agents/use-agent-names';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiPencilLine } from '@oxy.so/bloom/icons/RiPencilLine';
import { Loading } from '@oxy.so/bloom/loading';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

const RUN_PAGE_SIZE = 20;

/** Stacking only: a row of actions or badges. */
const ROW = 'flex-row flex-wrap items-center gap-2';

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
  const { agents, agentName } = useAgentNames();
  const updateAutomation = useUpdateAutomation();
  const [editorOpen, setEditorOpen] = useState(false);
  const [visibleRuns, setVisibleRuns] = useState(RUN_PAGE_SIZE);
  const automation = overview.data?.automations.find(
    (candidate) => candidate.id === id,
  );
  const agentOptions = useMemo(
    () =>
      (agents ?? []).map((agent) => ({ id: agent._id, label: agentLabel(agent) })),
    [agents],
  );

  const timestampLabel = (timestamp: string | null): string => {
    if (!timestamp) return t('pages.automations.notStarted');
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
      ? t('pages.automations.unknownTime')
      : date.toLocaleString();
  };

  /** The header while there is no automation to name: just the way back. */
  const backOnly = <Stack.Screen options={{ headerBackVisible: true }} />;

  if (overview.isLoading || runs.isLoading) {
    return (
      <>
        {backOnly}
        <Loading variant="spinner" />
      </>
    );
  }

  if (overview.isError || runs.isError) {
    return (
      <>
        {backOnly}
        <EmptyState
          title={t('pages.automations.historyLoadFailed')}
          action={{
            label: t('common.tryAgain'),
            onPress: () =>
              void Promise.all([overview.refetch(), runs.refetch()]),
          }}
        />
      </>
    );
  }

  if (!automation) {
    return (
      <>
        {backOnly}
        <EmptyState
          title={t('pages.automations.notFound')}
          action={{ label: t('common.back'), onPress: () => router.back() }}
        />
      </>
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
      <Stack.Screen
        options={{
          title: automation.objective,
          headerBackVisible: true,
          headerRight: () => (
            <ButtonGroup accessibilityLabel={t('common.edit')}>
              <ButtonGroupItem
                iconOnly
                leadingIcon={RiPencilLine}
                accessibilityLabel={t('common.edit')}
                onPress={() => setEditorOpen(true)}
              />
            </ButtonGroup>
          ),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="w-full max-w-[768px] self-center gap-5 p-4"
      >
        <View className="gap-2">
          {/* The heading is the objective (#534). */}
          <Text variant="title-2-semibold" selectable>
            {automation.objective}
          </Text>
          <View className={ROW}>
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
          </View>
          <Muted selectable>{triggerLabel(automation.trigger)}</Muted>
          <Muted selectable>
            {t('pages.automations.actors', {
              actors: actorLabel(automation.actorSelection, agentName),
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
      <AutomationEditor
        key={`${automation.updatedAt}:${editorOpen}`}
        automation={automation}
        agents={agentOptions}
        open={editorOpen}
        saving={updateAutomation.isPending}
        onClose={() => setEditorOpen(false)}
        onSave={saveUpdate}
      />
    </>
  );
}
