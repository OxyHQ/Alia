import { FilesAndSources } from '@/components/execution/files-and-sources';
import { restoreOpenerFocus } from '@/components/execution/focus-return';
import { ToolStep } from '@/components/execution/tool-step';
import type { Message } from '@/lib/hooks/use-conversations';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useUIStore, type ThoughtTab } from '@/lib/stores/ui-store';
import {
  auditText,
  buildAuditTimeline,
  buildSteps,
  extractOutputs,
  extractSources,
  isLiveLifecycle,
  mergeSources,
  researchSourcesToSources,
  toolCallStatus,
  toolCallText,
  toolLabel,
  turnLifecycle,
  type AuditEntry,
  type OutputFile,
  type Source,
  type ThoughtStep,
  type TurnLifecycle,
} from '@/lib/thought-utils';
import { getToolIcon } from '@/lib/tool-registry';
import {
  AgentLogRow,
  AgentLogShimmerText,
  AgentLogWorkingRow,
  useAgentLogMotion,
} from '@oxy.so/bloom/agent-log';
import { useAiChatShell } from '@oxy.so/bloom/ai-chat';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiForbidLine } from '@oxy.so/bloom/icons/RiForbidLine';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { Loading } from '@oxy.so/bloom/loading';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted, Text } from '@oxy.so/bloom/typography';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useMemo, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';

/** One array for "nothing selected", so the memos below hold across renders. */
const NO_MESSAGES: Message[] = [];

function TabToggle({
  value,
  onChange,
}: {
  value: ThoughtTab;
  onChange: (t: ThoughtTab) => void;
}) {
  const { t } = useTranslation();
  const tabs: { key: ThoughtTab; label: string }[] = [
    { key: 'steps', label: t('thought.steps') },
    { key: 'sources', label: t('thought.sources') },
    { key: 'activity', label: t('thought.activity') },
  ];

  return (
    <Tabs
      variant="pill"
      value={value}
      onValueChange={(next) => onChange(next as ThoughtTab)}
    >
      {tabs.map((tab) => (
        <TabsTrigger key={tab.key} value={tab.key} label={tab.label} />
      ))}
    </Tabs>
  );
}

/**
 * The panel's own wording for every step that is not a tool. Tool steps keep
 * the label the registry gave them; these are lifecycle words, and they are
 * translated here rather than in `buildSteps` so the pure function stays free
 * of the locale.
 */
const STEP_LABEL_KEYS: Record<Exclude<ThoughtStep['type'], 'tool'>, string> = {
  thinking: 'thought.thinking',
  writing: 'thought.writing',
  waiting: 'thought.waitingApproval',
  done: 'thought.done',
  failed: 'thought.failed',
  cancelled: 'thought.cancelled',
};

/** A step that is a phase or an ending rather than a tool call. */
type PhaseStep = Omit<ThoughtStep, 'type'> & {
  type: Exclude<ThoughtStep['type'], 'tool'>;
};

/** The glyph of a pause or an ending; a phase that is working has none — the log's own shimmer says so. */
function PhaseIcon({ type }: { type: PhaseStep['type'] }) {
  const { colors } = useTheme();
  if (type === 'waiting') return <RiTimeLine size="sm" fill={colors.warning} />;
  if (type === 'done') return <RiCheckboxCircleLine size="sm" fill={colors.success} />;
  if (type === 'failed') return <RiCloseCircleLine size="sm" fill={colors.error} />;
  if (type === 'cancelled') return <RiForbidLine size="sm" fill={colors.textSecondary} />;
  return null;
}

/** A phase or ending as one line of the log. Not a control: there is nothing to expand. */
function PhaseRow({ step, isActive }: { step: PhaseStep; isActive: boolean }) {
  const { t } = useTranslation();
  const label = t(STEP_LABEL_KEYS[step.type]);
  const ending = step.type === 'done' || step.type === 'failed';
  return (
    <View className="flex-row items-center gap-1.5 py-1" accessible accessibilityLabel={label}>
      <PhaseIcon type={step.type} />
      <Text variant={ending ? 'body-medium' : 'body-regular'}>
        {isActive ? <AgentLogShimmerText>{label}</AgentLogShimmerText> : label}
      </Text>
    </View>
  );
}

/**
 * The turn's steps as Bloom's agent log: each tool call a `ToolStep` whose
 * input and output open in place, the phases and the ending as plain lines,
 * and — while the turn is thinking or writing — the log's working row at the
 * tail. Rows land as the runtime reports them, so the log is driven by real
 * events rather than a ticker.
 *
 * A tool step spins on ITS OWN state while the turn runs — not on being last
 * — so a finished tool after it cannot hide that it is still going, and a
 * call that never returned in a turn that is over sits still and says so.
 */
function StepsTab({
  steps,
  lifecycle,
}: {
  steps: ThoughtStep[];
  lifecycle: TurnLifecycle;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const reduce = useAgentLogMotion();
  const live = isLiveLifecycle(lifecycle);
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});

  if (steps.length === 0) {
    return <EmptyState variant="compact" description={t('thought.noSteps')} />;
  }

  const last = steps[steps.length - 1];
  const tail = live && (last.type === 'thinking' || last.type === 'writing') ? last : null;
  const rows = tail === null ? steps : steps.slice(0, -1);

  return (
    <View>
      <View role="list">
        {rows.map((step, index) => {
          const first = index === 0;
          const isLastRow = index === rows.length - 1;
          if (step.type !== 'tool') {
            return (
              <AgentLogRow key={`${step.type}-${index}`} first={first} last={isLastRow} reduce={reduce}>
                <PhaseRow step={{ ...step, type: step.type }} isActive={live && isLastRow && tail === null} />
              </AgentLogRow>
            );
          }
          const inv = step.invocation;
          const key = inv?.toolCallId || `tool-${index}`;
          const ToolIcon = getToolIcon(step.toolName || '');
          const status =
            inv === undefined ? (live ? 'running' : 'done') : toolCallStatus(inv, live);
          return (
            <AgentLogRow key={key} first={first} last={isLastRow} reduce={reduce}>
              <ToolStep
                title={step.toolName === undefined ? step.label : toolLabel(step.toolName, t)}
                status={status}
                icon={
                  <ToolIcon width={14} height={14} fill={status === 'error' ? colors.error : colors.text} />
                }
                input={inv === undefined ? '' : toolCallText(inv.args)}
                output={inv === undefined ? '' : toolCallText(inv.result)}
                sources={step.sources}
                expanded={openRows[key] === true}
                onToggle={() => setOpenRows((open) => ({ ...open, [key]: open[key] !== true }))}
              />
            </AgentLogRow>
          );
        })}
      </View>
      {tail === null ? null : (
        <AgentLogWorkingRow label={t(STEP_LABEL_KEYS[tail.type as PhaseStep['type']])} reduce={reduce} />
      )}
    </View>
  );
}

/** The conversation's audit trail as one agent log, oldest first. */
function ActivityTab({ entries }: { entries: AuditEntry[] }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const reduce = useAgentLogMotion();
  if (entries.length === 0) {
    return <EmptyState variant="compact" description={t('thought.noActivity')} />;
  }

  return (
    <View role="list">
      {entries.map((entry, index) => (
        <AgentLogRow key={entry.id} first={index === 0} last={index === entries.length - 1} reduce={reduce}>
          <View className="py-1">
            <View className="flex-row items-center gap-1.5">
              {entry.status === 'interrupted' ? <RiForbidLine size="xs" fill={colors.textSecondary} /> : null}
              <Text variant="body-regular" numberOfLines={1}>
                {entry.status === 'in_progress' ? (
                  <AgentLogShimmerText>{auditText(entry.label, t)}</AgentLogShimmerText>
                ) : (
                  auditText(entry.label, t)
                )}
              </Text>
            </View>
            {auditText(entry.description, t) ? (
              <Muted numberOfLines={1}>{auditText(entry.description, t)}</Muted>
            ) : null}
          </View>
        </AgentLogRow>
      ))}
    </View>
  );
}

/**
 * The panel has nothing to show for the selection, and the reason. Rendered
 * in place of the tabs' content so the three tabs never each say "none" about
 * a message whose data has simply not arrived.
 */
function SelectionState({ status }: { status: 'loading' | 'failed' | 'gone' }) {
  const { t } = useTranslation();
  const key =
    status === 'loading'
      ? 'thought.loading'
      : status === 'failed'
        ? 'thought.loadFailed'
        : 'thought.messageGone';
  return (
    <EmptyState
      variant="compact"
      illustration={status === 'loading' ? <Loading size="sm" iconSize={24} /> : undefined}
      description={t(key)}
    />
  );
}

/** Open a source where the platform reads the web. */
function openSource(source: Source): void {
  if (Platform.OS === 'web') {
    window.open(source.url, '_blank', 'noopener,noreferrer');
  } else {
    void WebBrowser.openBrowserAsync(source.url);
  }
}

/**
 * The execution panel: what the selected turn did, produced and read.
 *
 * It fills the workspace panel's slot (`WorkspacePanel`, opened with
 * `useUIStore().openThoughtPanel`); closing hands focus back to whatever
 * opened it.
 *
 * Everything shown comes from the selection's own scope and the lifecycle the
 * runtime stamps (#542, #543): a message not yet loaded is "loading", a load
 * that failed says so, a message cut out since is "gone", and none of them is
 * ever "no steps".
 */
export function ThoughtPanel() {
  const { colors } = useTheme();
  const shell = useAiChatShell();
  const { t } = useTranslation();
  const activeTab = useUIStore((s) => s.thoughtTab);
  const setActiveTab = useUIStore((s) => s.setThoughtTab);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const thoughtMessageId = useUIStore((s) => s.thoughtMessageId);
  const scope = useUIStore((s) => s.thoughtScope);
  const canvasArtifacts = useUIStore((s) => s.canvasArtifacts);

  /**
   * The scope's messages are the conversation the selection was made in and
   * nothing else — a screen showing another conversation never gets to write
   * here (see `syncThoughtScope`), so a miss below is about THIS conversation:
   * still loading, failed to load, or a message that has since been cut out
   * of it by an edit or a regenerate.
   */
  const messages = scope?.messages ?? NO_MESSAGES;
  const message = useMemo(
    () => messages.find((m) => m.id === thoughtMessageId),
    [messages, thoughtMessageId],
  );

  const lifecycle = useMemo<TurnLifecycle>(() => {
    if (!message) return 'completed';
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant');
    return turnLifecycle(message, {
      isLoading: scope?.isLoading ?? false,
      isLastAssistant: lastAssistant?.id === message.id,
      failedTurn: scope?.failedTurn ?? null,
    });
  }, [message, messages, scope?.isLoading, scope?.failedTurn]);

  const steps = useMemo(
    () => (message ? buildSteps(message, lifecycle) : []),
    [message, lifecycle],
  );

  // A research answer's sources come from its persisted `deepResearch`
  // invocation after a reload and from the live progress event before one;
  // both are read so the tab is the same either way.
  const sources = useMemo(
    () =>
      message
        ? mergeSources(
            extractSources(message.toolInvocations),
            researchSourcesToSources(message.researchProgress?.sources),
          )
        : [],
    [message],
  );

  const outputs = useMemo(
    () => (message ? extractOutputs(message.toolInvocations) : []),
    [message],
  );

  /**
   * An output opens in the canvas only while the canvas holds its artifact —
   * the streaming hook adds one per generated file under the invocation's
   * id, and nothing persists it. A reloaded thread lists the file by name and
   * offers no press, rather than a press that opens an empty canvas.
   */
  const openOutput = useCallback(
    (output: OutputFile): boolean => {
      if (!canvasArtifacts.some((artifact) => artifact.id === output.id))
        return false;
      setRightPanel('canvas');
      return true;
    },
    [canvasArtifacts, setRightPanel],
  );

  const auditEntries = useMemo(
    () =>
      buildAuditTimeline(messages, {
        isLoading: scope?.isLoading ?? false,
        failedTurn: scope?.failedTurn ?? null,
      }),
    [messages, scope?.isLoading, scope?.failedTurn],
  );

  const close = useCallback(() => {
    setRightPanel(null);
    restoreOpenerFocus();
  }, [setRightPanel]);

  /**
   * Which of the three things a missing message means. A message that IS
   * here but whose conversation is still loading is shown as it is — the
   * live turn is exactly that — so only a miss consults the status.
   */
  const emptyState: 'loading' | 'failed' | 'gone' | null =
    message !== undefined
      ? null
      : scope === null || scope.status === 'loading'
        ? 'loading'
        : scope.status === 'failed'
          ? 'failed'
          : 'gone';

  const content =
    emptyState !== null ? (
      <SelectionState status={emptyState} />
    ) : activeTab === 'steps' ? (
      <StepsTab steps={steps} lifecycle={lifecycle} />
    ) : activeTab === 'sources' ? (
      <FilesAndSources
        outputs={outputs}
        sources={sources}
        onOpenOutput={openOutput}
        onOpenSource={openSource}
      />
    ) : (
      <ActivityTab entries={auditEntries} />
    );

  return (
    <View className="min-h-0 flex-1 gap-2.5 pt-2">
      <View className="h-[30px] flex-row items-center justify-between">
        <View className="min-w-0 shrink">
          <TabToggle value={activeTab} onChange={setActiveTab} />
        </View>
        {!shell?.compact && (
          <Button
            appearance="plain"
            tone="neutral"
            size="xs"
            accessibilityLabel={t('common.close')}
            onPress={close}
            icon={<RiCloseLine size="sm" fill={colors.textSecondary} />}
          />
        )}
      </View>

      <ScrollView className="flex-1 px-4" contentContainerClassName="pb-4" showsVerticalScrollIndicator={false}>
        {content}
      </ScrollView>
    </View>
  );
}
