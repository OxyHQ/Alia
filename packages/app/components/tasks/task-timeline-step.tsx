import type { PlanItem } from '@/lib/hooks/use-agent-activity';
import { Badge } from '@oxy.so/bloom/badge';
import { RiCheckboxBlankCircleLine } from '@oxy.so/bloom/icons/RiCheckboxBlankCircleLine';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons/RiCheckboxCircleFill';
import { RiErrorWarningFill } from '@oxy.so/bloom/icons/RiErrorWarningFill';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted, Text } from '@oxy.so/bloom/typography';
import React from 'react';

interface TaskTimelineStepProps {
  item: PlanItem;
  isLast: boolean;
  toolName?: string | null;
  toolLabel?: string | null;
}

/** A step's state, as a 16px mark in the colour that state reads in. */
function StepIcon({ item }: { item: PlanItem }) {
  const { colors } = useTheme();
  const size = { width: 16, height: 16 };
  if (item.status === 'completed') {
    return <RiCheckboxCircleFill {...size} fill={colors.success} />;
  }
  if (item.status === 'in_progress') {
    return <Loading variant="spinner" iconSize={14} color={colors.warning} />;
  }
  if (item.status === 'blocked') {
    return <RiErrorWarningFill {...size} fill={colors.error} />;
  }
  return <RiCheckboxBlankCircleLine {...size} fill={colors.textTertiary} />;
}

/**
 * One step of a task's plan: a Bloom `Item` with the step's state as its
 * leading mark and, while it is the step in progress, the tool it is using as a
 * badge underneath.
 */
export const TaskTimelineStep = React.memo(function TaskTimelineStep({
  item,
  toolLabel,
}: TaskTimelineStepProps) {
  const isActive = item.status === 'in_progress';
  const isDone = item.status === 'completed';

  return (
    <Item
      density="compact"
      role="listitem"
      leading={<StepIcon item={item} />}
      title={
        isDone || isActive ? (
          <Text variant="body-medium">{item.text}</Text>
        ) : (
          <Muted>{item.text}</Muted>
        )
      }
      subtitle={
        isActive && toolLabel ? (
          <Badge size="label-small" variant="subtle" content={toolLabel} />
        ) : undefined
      }
    />
  );
});
