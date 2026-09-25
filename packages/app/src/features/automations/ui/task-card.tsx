import { agentDisplayName } from '@/features/agents/model/identity';
import type { AgentActivityState } from '@/features/chat/runtime/use-agent-activity';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { TaskAgentRef, TaskSession } from '@/features/automations/runtime/use-tasks';
import { formatDuration, getToolPillLabel } from '@/features/chat/model/task-utils';
import { Badge, type BadgeIcon } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardFooter } from '@oxy.so/bloom/card';
import { RiArrowDownSLine } from '@oxy.so/bloom/icons/RiArrowDownSLine';
import { RiArrowUpSLine } from '@oxy.so/bloom/icons/RiArrowUpSLine';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiForbidLine } from '@oxy.so/bloom/icons/RiForbidLine';
import { RiLoader4Line } from '@oxy.so/bloom/icons/RiLoader4Line';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { Item } from '@oxy.so/bloom/item';
import type { AccentTone } from '@oxy.so/bloom/theme';
import { Muted } from '@oxy.so/bloom/typography';
import React, { useEffect, useMemo, useState } from 'react';
import Animated, { FadeIn } from 'react-native-reanimated';
import { View } from 'react-native';
import { AgentMarkRow } from './agent-mark-row';
import { TaskTimelineStep } from './task-timeline-step';

interface TaskCardProps {
  task: TaskSession;
  activity?: AgentActivityState | null;
  onPress?: () => void;
}

const COLLAPSED_STEP_COUNT = 5;

/**
 * A session's status as a Bloom badge: its word (an i18n key), its tone and
 * its mark. The words are the automations' lifecycle words, so a task and an
 * automation in the same list say "Running" the same way.
 */
const STATUS: Record<
  TaskSession['status'],
  { label: string; tone: AccentTone; icon: BadgeIcon }
> = {
  queued: { label: 'automations.lifecycle.queued', tone: 'default', icon: RiTimeLine },
  running: { label: 'automations.lifecycle.running', tone: 'info', icon: RiLoader4Line },
  completed: {
    label: 'automations.lifecycle.completed',
    tone: 'success',
    icon: RiCheckboxCircleLine,
  },
  failed: { label: 'automations.lifecycle.failed', tone: 'error', icon: RiCloseCircleLine },
  cancelled: { label: 'automations.lifecycle.cancelled', tone: 'default', icon: RiForbidLine },
};

export const TaskCard = React.memo(function TaskCard({
  task,
  activity,
  onPress,
}: TaskCardProps) {
  const { t } = useTranslation();
  const status = STATUS[task.status];
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState('');

  // Elapsed timer for running tasks
  useEffect(() => {
    const startedAt = task.stats.startedAt;
    if (task.status !== 'running' || !startedAt) {
      if (startedAt)
        setElapsed(formatDuration(Date.now() - new Date(startedAt).getTime()));
      return;
    }
    const update = () =>
      setElapsed(formatDuration(Date.now() - new Date(startedAt).getTime()));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [task.status, task.stats.startedAt]);

  // Merge real-time plan with static plan
  const planItems = useMemo(() => {
    if (activity?.plan?.items?.length) return activity.plan.items;
    return task.plan?.items ?? [];
  }, [activity?.plan?.items, task.plan?.items]);

  const completedCount = planItems.filter(
    (i) => i.status === 'completed',
  ).length;
  const totalCount = planItems.length;
  const hasTimeline = totalCount > 0;
  const needsCollapse = totalCount > COLLAPSED_STEP_COUNT;
  const visibleItems =
    needsCollapse && !expanded
      ? planItems.slice(0, COLLAPSED_STEP_COUNT)
      : planItems;

  // Current tool info for the in-progress step
  const currentToolName = activity?.currentAction?.toolName ?? null;
  const currentToolLabel = currentToolName
    ? getToolPillLabel(currentToolName, t)
    : null;

  // Build the agents list for the mark row
  const agents = useMemo(() => {
    // The names are Oxy's and may be unresolved, so the row is built through the
    // shared fallback rather than each mark inventing its own.
    const list: Array<{ _id: string; name: string; color: string | null }> = [];
    const push = (agent: TaskAgentRef) => {
      if (list.some((a) => a._id === agent._id)) return;
      list.push({
        _id: agent._id,
        name: agentDisplayName(agent),
        color: agent.color,
      });
    };
    if (task.agentId) push(task.agentId);
    for (const child of task.childAgents ?? []) push(child);
    return list;
  }, [task.agentId, task.childAgents]);

  return (
    <Animated.View entering={FadeIn.duration(300)}>
      {/* It opens the task, so it is a link — and not a `<button>` on web,
          which could not hold the card's own buttons. */}
      <Card appearance="outline" onPress={onPress} accessibilityRole="link">
        {/* Header: agent marks, elapsed time and the status badge */}
        <Item
          title={<AgentMarkRow agents={agents} />}
          subtitle={<Muted numberOfLines={2}>{task.task}</Muted>}
          trailing={
            <>
              {elapsed ? <Muted>{elapsed}</Muted> : null}
              <Badge
                size="label-small"
                variant="subtle"
                color={status.tone}
                icon={status.icon}
                content={t(status.label)}
              />
            </>
          }
        />
        {hasTimeline &&
          visibleItems.map((item, i) => (
            <TaskTimelineStep
              key={item.id}
              item={item}
              isLast={
                i === visibleItems.length - 1 && (expanded || !needsCollapse)
              }
              toolName={item.status === 'in_progress' ? currentToolName : null}
              toolLabel={
                item.status === 'in_progress' ? currentToolLabel : null
              }
            />
          ))}

        {/* Current action (when no plan yet) */}
        {!hasTimeline &&
          activity?.currentAction &&
          task.status === 'running' && (
            <Item
              density="compact"
              title={
                <Badge
                  size="label-medium"
                  variant="subtle"
                  icon={RiLoader4Line}
                  content={getToolPillLabel(activity.currentAction.toolName, t)}
                />
              }
            />
          )}

        {/* Result preview for completed tasks */}
        {task.result && task.status === 'completed' && !hasTimeline && (
          <Item
            density="compact"
            title={<Muted numberOfLines={2}>{task.result}</Muted>}
          />
        )}

        {hasTimeline && (
          <CardFooter>
            <View className="flex-1 flex-row items-center justify-between gap-2">
              <Muted>
                {t('tasks.stepsCompleted', {
                  done: completedCount,
                  count: totalCount,
                })}
              </Muted>
              {needsCollapse && (
                <Button
                  tone="neutral"
                  appearance="plain"
                  size="xs"
                  leadingIcon={expanded ? RiArrowUpSLine : RiArrowDownSLine}
                  onPress={() => setExpanded(!expanded)}
                >
                  {expanded
                    ? t('tasks.showLess')
                    : t('tasks.showAllSteps', { count: totalCount })}
                </Button>
              )}
            </View>
          </CardFooter>
        )}
      </Card>
    </Animated.View>
  );
});
