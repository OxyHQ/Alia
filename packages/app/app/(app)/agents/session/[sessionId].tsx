import apiClient from '@/lib/api/client';
import { useTranslation } from '@/lib/hooks/use-translation';
import type { AccentTone } from '@oxy.so/bloom/theme';
import { Badge } from '@oxy.so/bloom/badge';
import { Card, CardBody } from '@oxy.so/bloom/card';
import { Pre } from '@oxy.so/bloom/code';
import { Divider } from '@oxy.so/bloom/divider';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiArrowDownSLine } from '@oxy.so/bloom/icons/RiArrowDownSLine';
import { RiArrowUpSLine } from '@oxy.so/bloom/icons/RiArrowUpSLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { RiLightbulbLine } from '@oxy.so/bloom/icons/RiLightbulbLine';
import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { RiTerminalBoxLine } from '@oxy.so/bloom/icons/RiTerminalBoxLine';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { Loading } from '@oxy.so/bloom/loading';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

/**
 * Agent Session Activity — Timeline view of all agent actions in a session.
 *
 * Shows a chronological feed of tool calls, observations, errors, threats,
 * and model responses. Entries can be expanded for full details. Plain content
 * on the layout's surface: every entry is a Bloom `Card`, every label a Bloom
 * `Badge`.
 */

interface EventEntry {
  _id: string;
  seq: number;
  timestamp: number;
  type: string;
  content: string;
  metadata?: {
    toolName?: string;
    args?: Record<string, unknown>;
    exitCode?: number;
    durationMs?: number;
    tokenEstimate?: number;
  };
}

interface SessionInfo {
  status: string;
  task: string;
  result?: string;
  stats: {
    totalTokens: number;
    totalSteps: number;
    creditsCharged?: number;
    startedAt: string;
    completedAt?: string;
  };
}

/** Each event type's glyph, drawn inside its `Badge`. */
const EVENT_ICONS: Record<string, BloomIconComponent> = {
  action: RiTerminalBoxLine,
  observation: RiChat3Line,
  error: RiCloseCircleLine,
  system_message: RiAlertLine,
  thinking: RiLightbulbLine,
  response: RiChat3Line,
  complete: RiCheckboxCircleLine,
  threat_detected: RiShieldLine,
  user_message: RiChat3Line,
  plan_update: RiEditLine,
  plan_progress: RiEditLine,
  file_change: RiEditLine,
  source_found: RiGlobalLine,
};

/** Each event type's tone, from Bloom's accent recipe. */
const EVENT_TONES: Record<string, AccentTone> = {
  action: 'info',
  observation: 'success',
  error: 'error',
  system_message: 'warning',
  thinking: 'tertiary',
  response: 'default',
  complete: 'success',
  threat_detected: 'error',
  user_message: 'default',
  plan_update: 'primary',
  plan_progress: 'primary',
  file_change: 'warning',
  source_found: 'info',
};

/** The session's status, as a badge tone. */
function statusTone(status: string): AccentTone {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'running') return 'info';
  return 'default';
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(ms?: number): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function EventCard({ entry }: { entry: EventEntry }) {
  const [expanded, setExpanded] = useState(false);

  const isThreat =
    entry.type === 'threat_detected' || entry.content?.includes('THREAT');
  const isError = entry.type === 'error';

  return (
    <Card
      appearance="outline"
      tone={isThreat || isError ? 'danger' : undefined}
      onPress={() => setExpanded(!expanded)}
      accessibilityLabel={entry.type.replace(/_/g, ' ')}
    >
      <CardBody>
        <View className="gap-1.5 py-1">
          <View className="flex-row items-center gap-2">
            <Badge
              size="label-small"
              variant="subtle"
              color={EVENT_TONES[entry.type] ?? 'default'}
              icon={EVENT_ICONS[entry.type] ?? RiChat3Line}
              content={entry.type.replace(/_/g, ' ')}
            />
            {entry.metadata?.toolName && (
              <Muted
                numberOfLines={1}
                className="shrink text-sm text-muted-foreground"
              >
                {entry.metadata.toolName}
              </Muted>
            )}
            <View className="flex-1" />
            {entry.metadata?.durationMs && (
              <Muted>{formatDuration(entry.metadata.durationMs)}</Muted>
            )}
            <Muted>{formatTimestamp(entry.timestamp)}</Muted>
            {expanded ? (
              <RiArrowUpSLine size="sm" />
            ) : (
              <RiArrowDownSLine size="sm" />
            )}
          </View>

          <Text variant="body-regular" numberOfLines={expanded ? undefined : 2}>
            {entry.content}
          </Text>

          {expanded && entry.metadata?.args && (
            <Pre>{JSON.stringify(entry.metadata.args, null, 2)}</Pre>
          )}
        </View>
      </CardBody>
    </Card>
  );
}

export default function SessionActivityScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const { t } = useTranslation();

  const [entries, setEntries] = useState<EventEntry[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadActivity = useCallback(async () => {
    if (!sessionId) return;
    try {
      // Use the agentId 'any' since the route validates session ownership
      const res = await apiClient.get(
        `/agents/any/sessions/${sessionId}/activity`,
      );
      setEntries(res.data.entries || []);
      setSession(res.data.session || null);
    } catch (err) {
      // silent
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadActivity();
  }, [loadActivity]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadActivity();
  }, [loadActivity]);

  const threatCount = entries.filter(
    (e) => e.type === 'threat_detected' || e.content?.includes('THREAT'),
  ).length;
  const errorCount = entries.filter((e) => e.type === 'error').length;

  return (
    <View className="flex-1">
      <Stack.Screen
        options={{
          title: t('pages.agents.sessionTitle'),
          headerBackVisible: true,
        }}
      />
      {/* What this session was asked to do. */}
      {session && (
        <View className="px-4">
          <Muted numberOfLines={2}>{session.task}</Muted>
        </View>
      )}

      {/* Stats */}
      {session && (
        <View className="flex-row flex-wrap items-center gap-2 px-4 pt-3">
          <Badge
            size="label-small"
            variant="subtle"
            color={statusTone(session.status)}
            content={session.status}
          />
          <Badge
            size="label-small"
            variant="subtle"
            icon={RiTimeLine}
            content={t('pages.agents.sessionSteps', {
              count: session.stats.totalSteps,
            })}
          />
          <Badge
            size="label-small"
            variant="subtle"
            icon={RiHistoryLine}
            content={t('pages.agents.sessionEvents', { count: entries.length })}
          />
          {threatCount > 0 && (
            <Badge
              size="label-small"
              variant="subtle"
              color="error"
              icon={RiShieldLine}
              content={t('pages.agents.sessionThreats', { count: threatCount })}
            />
          )}
          {errorCount > 0 && (
            <Badge
              size="label-small"
              variant="subtle"
              color="error"
              icon={RiCloseCircleLine}
              content={t('pages.agents.sessionErrors', { count: errorCount })}
            />
          )}
        </View>
      )}

      <Divider spacing={12} />

      {/* Activity timeline */}
      {loading ? (
        <View className="flex-1 items-center justify-center">
          <Loading variant="spinner" />
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item._id || String(item.seq)}
          renderItem={({ item }) => <EventCard entry={item} />}
          contentContainerClassName="gap-2 px-4 pb-4"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <EmptyState
              icon={RiHistoryLine}
              title={t('pages.agents.sessionEmpty')}
            />
          }
        />
      )}
    </View>
  );
}
