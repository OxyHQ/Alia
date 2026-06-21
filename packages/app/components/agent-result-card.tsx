/**
 * AgentResultCard — Rich summary card shown in chat when an agent completes a task.
 *
 * Displays: title, agent info, duration, step count, plan summary, deliverable files.
 * Includes a "View Files" toggle that expands the WorkspaceBrowser inline.
 */

import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  CheckCircle,
  XCircle,
  Clock,
  Layers,
  ChevronDown,
  ChevronUp,
  FolderTree,
  AlertTriangle,
  Coins,
} from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';
import { WorkspaceBrowser } from '@/components/workspace-browser';
import type { AgentActivityState, PlanItem } from '@/lib/hooks/use-agent-activity';

interface AgentResultCardProps {
  activity: AgentActivityState;
  sessionId: string;
  agentName?: string;
}

function formatDuration(startedAt: number | null): string {
  if (!startedAt) return '--';
  const ms = Date.now() - startedAt;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function CompletedPlanSummary({ items }: { items: PlanItem[] }) {
  const completed = items.filter(i => i.status === 'completed').length;
  const total = items.length;

  return (
    <View className="gap-1">
      {items.map(item => (
        <View key={item.id} className="flex-row items-start gap-2">
          {item.status === 'completed' ? (
            <CheckCircle size={12} color="#22c55e" style={{ marginTop: 2 }} />
          ) : item.status === 'blocked' ? (
            <AlertTriangle size={12} color="#f59e0b" style={{ marginTop: 2 }} />
          ) : (
            <XCircle size={12} color="#6b7280" style={{ marginTop: 2 }} />
          )}
          <Text
            className={`text-xs flex-1 ${item.status === 'completed' ? 'text-muted-foreground' : 'text-foreground'}`}
            numberOfLines={1}
          >
            {item.text}
          </Text>
        </View>
      ))}
      {total > 0 && (
        <Text className="text-[10px] text-muted-foreground mt-1">
          {completed}/{total} steps completed
        </Text>
      )}
    </View>
  );
}

export const AgentResultCard = React.memo(function AgentResultCard({
  activity,
  sessionId,
  agentName,
}: AgentResultCardProps) {
  const { colors } = useColorScheme();
  const [showPlan, setShowPlan] = useState(false);
  const [showFiles, setShowFiles] = useState(false);

  const { plan, isComplete, hasError, lastError, eventCount, startedAt } = activity;
  const isSuccess = isComplete && !hasError;
  const duration = formatDuration(startedAt);

  const statusColor = isSuccess ? '#22c55e' : hasError ? '#ef4444' : '#6b7280';
  const StatusIcon = isSuccess ? CheckCircle : hasError ? XCircle : Clock;
  const statusLabel = isSuccess ? 'Completed' : hasError ? 'Failed' : 'Unknown';

  return (
    <Animated.View
      entering={FadeIn.duration(300)}
      className="rounded-xl border border-border bg-background overflow-hidden my-2"
    >
      {/* Status banner */}
      <View
        className="flex-row items-center gap-2 px-3 py-2.5"
        style={{ backgroundColor: statusColor + '15' }}
      >
        <StatusIcon size={16} color={statusColor} />
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">
            {isSuccess ? 'Task Complete' : 'Task Failed'}
          </Text>
          {agentName && (
            <Text className="text-[10px] text-muted-foreground">
              by {agentName}
            </Text>
          )}
        </View>
      </View>

      {/* Stats row */}
      <View className="flex-row items-center gap-4 px-3 py-2 border-b border-border">
        <View className="flex-row items-center gap-1">
          <Clock size={12} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">{duration}</Text>
        </View>
        <View className="flex-row items-center gap-1">
          <Layers size={12} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">{eventCount} steps</Text>
        </View>
        {plan && (
          <Text className="text-xs text-muted-foreground">
            {plan.completed}/{plan.total} plan items
          </Text>
        )}
        {(activity as any).creditsCharged != null && (
          <View className="flex-row items-center gap-1">
            <Coins size={12} color={colors.mutedForeground} />
            <Text className="text-xs text-muted-foreground">{(activity as any).creditsCharged} credits</Text>
          </View>
        )}
      </View>

      {/* Error message */}
      {hasError && lastError && (
        <View className="px-3 py-2 border-b border-border">
          <Text className="text-xs text-red-400" numberOfLines={3}>
            {lastError}
          </Text>
        </View>
      )}

      {/* Plan summary (collapsible) */}
      {plan && plan.items.length > 0 && (
        <View className="border-b border-border">
          <Pressable
            onPress={() => setShowPlan(!showPlan)}
            className="flex-row items-center justify-between px-3 py-2 active:bg-muted/50"
          >
            <Text className="text-xs font-medium text-foreground">Plan Summary</Text>
            {showPlan
              ? <ChevronUp size={14} color={colors.mutedForeground} />
              : <ChevronDown size={14} color={colors.mutedForeground} />
            }
          </Pressable>
          {showPlan && (
            <View className="px-3 pb-2">
              <CompletedPlanSummary items={plan.items} />
            </View>
          )}
        </View>
      )}

      {/* Files toggle */}
      <View>
        <Pressable
          onPress={() => setShowFiles(!showFiles)}
          className="flex-row items-center justify-between px-3 py-2 active:bg-muted/50"
        >
          <View className="flex-row items-center gap-2">
            <FolderTree size={14} color={colors.primary} />
            <Text className="text-xs font-medium text-foreground">Workspace Files</Text>
          </View>
          {showFiles
            ? <ChevronUp size={14} color={colors.mutedForeground} />
            : <ChevronDown size={14} color={colors.mutedForeground} />
          }
        </Pressable>
        {showFiles && (
          <View className="px-2 pb-2">
            <WorkspaceBrowser sessionId={sessionId} />
          </View>
        )}
      </View>
    </Animated.View>
  );
});
