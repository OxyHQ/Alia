import { capabilityIconForTool } from '@/lib/constants/capability-families';
import {
  useAgentActivity,
  type AgentActivityEvent,
  type AgentSource,
  type PlanProgress,
} from '@/lib/hooks/use-agent-activity';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useUIStore } from '@/lib/stores/ui-store';
import { AgentLogRow, AgentLogShimmerText, AgentLogWorkingRow, useAgentLogMotion } from '@oxy.so/bloom/agent-log';
import { AgentProgress } from '@oxy.so/bloom/agent-progress';
import { AgentThinking } from '@oxy.so/bloom/agent-thinking';
import { useAiChatShell } from '@oxy.so/bloom/ai-chat';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { LinkPreviewCard } from '@oxy.so/bloom/link-preview';
import { Notification } from '@oxy.so/bloom/notification';
import { StatBar } from '@oxy.so/bloom/stat-bar';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted, Text } from '@oxy.so/bloom/typography';
import * as WebBrowser from 'expo-web-browser';
import { useMemo, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';

/**
 * AgentPanel — the right panel showing an agent run as it happens.
 *
 * Two tabs (Steps | Sources) over the run's live events, the plan as Bloom's
 * `AgentProgress`, a pending approval as a warning `Notification` with its two
 * answers, and the action in flight as `AgentThinking` at the foot.
 *
 * There is no Files tab and no Browser tab. An agent has no workspace
 * filesystem — the `files` capability was retired with the sandbox it needed —
 * and its `browser` reads pages through Clarity as text, so there are no
 * screenshots to show. What it read appears under Sources.
 */

type Tab = 'steps' | 'sources';
type Translate = (key: string, params?: Record<string, unknown>) => string;

/** The events worth a line in the log; system noise is left out. */
const STEP_TYPES = new Set<AgentActivityEvent['type']>([
  'tool_call',
  'tool_result',
  'error',
  'threat',
  'complete',
  'thinking',
  'source_found',
  'response',
]);

function cut(text: string | undefined, max: number): string {
  return (text ?? '').slice(0, max);
}

/** One event as a line of the log, in the reader's language. */
export function agentStepLabel(event: AgentActivityEvent, t: Translate): string {
  const toolName = event.metadata?.toolName || '';
  switch (event.type) {
    case 'thinking':
      return t('panels.agent.step.thinking');
    case 'complete':
      return t('panels.agent.step.complete');
    case 'error':
      return t('panels.agent.step.error');
    case 'threat':
      return cut(event.content, 80) || t('panels.agent.step.threat');
    case 'system':
      return cut(event.content, 60);
    case 'tool_call': {
      const args = event.metadata?.args;
      if (toolName === 'browser')
        return t('panels.agent.step.browser', {
          action: args?.action || t('panels.agent.step.action'),
          target: cut(args?.url, 30) || cut(args?.query, 30),
        }).trim();
      if (toolName === 'plan')
        return args?.action === 'complete' ? t('panels.agent.step.completing') : t('panels.agent.step.updatingPlan');
      if (toolName === 'delegate') return t('panels.agent.step.delegate', { agent: args?.agent || 'agent' });
      return `${toolName}(${cut(event.content, 40)})`;
    }
    case 'tool_result':
      return cut(event.content, 80) || t('panels.agent.step.result');
    case 'source_found':
      return t('panels.agent.step.found', {
        title: event.metadata?.title || event.metadata?.url || t('panels.agent.step.source'),
      });
    case 'response':
      return cut(event.content, 80);
    default:
      return cut(event.content, 60);
  }
}

function openUrl(url: string) {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    void WebBrowser.openBrowserAsync(url);
  }
}

/** Plan labels are also `AgentProgress`'s keys, so a repeated one is numbered. */
function uniqueLabels(plan: PlanProgress): string[] {
  const seen = new Map<string, number>();
  return plan.items.map((item) => {
    const count = (seen.get(item.text) ?? 0) + 1;
    seen.set(item.text, count);
    return count === 1 ? item.text : `${item.text} (${count})`;
  });
}

function StepsTab({ events, isActive }: { events: AgentActivityEvent[]; isActive: boolean }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const reduce = useAgentLogMotion();
  const steps = useMemo(() => events.filter((e) => STEP_TYPES.has(e.type)), [events]);

  if (steps.length === 0) {
    return isActive ? (
      <AgentLogWorkingRow label={t('panels.agent.waitingToStart')} reduce={reduce} />
    ) : (
      <EmptyState variant="compact" description={t('panels.agent.noSteps')} />
    );
  }

  return (
    <View role="list">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const label = agentStepLabel(step, t);
        const failed = step.type === 'error' || step.type === 'threat';
        // The glyph comes from the CAPABILITY FAMILY that grants the tool, so
        // this log and the agent editor draw one concept one way. `color`, not
        // a class: some family glyphs are `Svg` whose fill a class cannot paint.
        const FamilyIcon = step.type === 'tool_call' ? capabilityIconForTool(step.metadata?.toolName || '') : undefined;
        return (
          <AgentLogRow key={`${step.timestamp}-${index}`} first={index === 0} last={last} reduce={reduce}>
            <View className="flex-row items-center gap-1.5 py-1">
              {step.type === 'complete' ? <RiCheckboxCircleLine size="sm" fill={colors.success} /> : null}
              {failed ? <RiErrorWarningLine size="sm" fill={colors.error} /> : null}
              {FamilyIcon ? <FamilyIcon size={14} color={colors.text} /> : null}
              <Text variant={step.type === 'complete' ? 'body-medium' : 'body-regular'} numberOfLines={2}>
                {isActive && last && label ? <AgentLogShimmerText>{label}</AgentLogShimmerText> : label}
              </Text>
            </View>
          </AgentLogRow>
        );
      })}
    </View>
  );
}

function SourcesTab({ sources }: { sources: AgentSource[] }) {
  const { t } = useTranslation();
  if (sources.length === 0) {
    return <EmptyState variant="compact" icon={RiSearchLine} description={t('panels.agent.noSources')} />;
  }

  return (
    <View className="gap-2">
      <Muted>{t('panels.agent.websites', { count: sources.length })}</Muted>
      {sources.map((source, index) => (
        <LinkPreviewCard
          key={`${source.url}-${index}`}
          url={source.url}
          title={source.title || source.url}
          siteName={source.domain}
          description={source.snippet.length > 0 ? source.snippet : undefined}
          onPress={() => openUrl(source.url)}
        />
      ))}
    </View>
  );
}

function PlanProgressView({ plan }: { plan: PlanProgress }) {
  const { t } = useTranslation();
  if (plan.items.length > 0) {
    return (
      <AgentProgress
        steps={uniqueLabels(plan)}
        completedCount={plan.completed}
        labels={{
          stepsLeft: (n) => t('panels.agent.stepsLeft', { count: n }),
          allCompleted: t('panels.agent.allCompleted'),
          minimize: t('panels.agent.minimizeSteps'),
          expand: t('panels.agent.expandSteps'),
        }}
      />
    );
  }
  return (
    <StatBar
      label={t('panels.agent.planSteps', { completed: plan.completed, total: plan.total })}
      value={plan.completed}
      max={plan.total}
    />
  );
}

export function AgentPanel() {
  const shell = useAiChatShell();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [activeTab, setActiveTab] = useState<Tab>('steps');
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const activeAgentSessionId = useUIStore((s) => s.activeAgentSessionId);
  const activeAgentId = useUIStore((s) => s.activeAgentId);

  const activity = useAgentActivity(activeAgentSessionId, activeAgentId);
  const isActive = !activity.isComplete && !activity.hasError;
  const approval = activity.approvalRequest;
  const current = activity.currentAction;
  const currentLabel = current
    ? `${current.toolName} ${current.content.length > 60 ? `${current.content.slice(0, 60)}…` : current.content}`.trim()
    : null;

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'steps', label: t('panels.agent.tabs.steps') },
    { key: 'sources', label: t('panels.agent.tabs.sources'), count: activity.sources.length || undefined },
  ];

  return (
    <View className="min-h-0 flex-1 gap-2.5 pt-2">
      <View className="h-[30px] flex-row items-center justify-between">
        <View className="min-w-0 shrink">
          <Tabs variant="pill" value={activeTab} onValueChange={(next) => setActiveTab(next as Tab)}>
            {tabs.map((tab) => (
              <TabsTrigger key={tab.key} value={tab.key} label={tab.label} count={tab.count} />
            ))}
          </Tabs>
        </View>
        {!shell?.compact && (
          <Button
            appearance="plain"
            tone="neutral"
            size="xs"
            accessibilityLabel={t('panels.agent.close')}
            onPress={() => setRightPanel(null)}
            icon={<RiCloseLine size="sm" fill={colors.textSecondary} />}
          />
        )}
      </View>

      <View className="flex-row items-center gap-2 px-4 py-1">
        {activity.isComplete ? (
          <RiCheckboxCircleLine size="sm" fill={colors.success} />
        ) : activity.hasError ? (
          <RiErrorWarningLine size="sm" fill={colors.error} />
        ) : null}
        <Text variant="headline-semibold">
          {activity.isComplete
            ? t('panels.agent.complete')
            : activity.hasError
              ? t('panels.agent.failed')
              : t('panels.agent.working')}
        </Text>
      </View>

      {activity.plan && activity.plan.total > 0 ? (
        <View className="px-4">
          <PlanProgressView plan={activity.plan} />
        </View>
      ) : null}

      {approval ? (
        <View className="px-4">
          <Notification
            status="warning"
            title={t('panels.agent.approvalRequired')}
            description={`${approval.toolName}: ${approval.description}`}
            dismissible={false}
            actions={[
              { label: t('panels.agent.deny'), onPress: () => activity.respondApproval(approval.requestId, false) },
              { label: t('panels.agent.approve'), onPress: () => activity.respondApproval(approval.requestId, true) },
            ]}
          />
        </View>
      ) : null}

      <ScrollView className="flex-1 px-4" contentContainerClassName="pb-6" showsVerticalScrollIndicator={false}>
        {activeTab === 'steps' ? (
          <StepsTab events={activity.events} isActive={isActive} />
        ) : (
          <SourcesTab sources={activity.sources} />
        )}
      </ScrollView>

      {currentLabel && isActive ? (
        <View className="px-4 py-2">
          <AgentThinking key={currentLabel} label={currentLabel} showTimer />
        </View>
      ) : null}
    </View>
  );
}
