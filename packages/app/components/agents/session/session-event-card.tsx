import {
  isThreatEntry,
  type EventEntry,
} from '@/lib/hooks/agents/use-session-activity';
import type { AccentTone } from '@oxy.so/bloom/theme';
import { Badge } from '@oxy.so/bloom/badge';
import { Card, CardBody } from '@oxy.so/bloom/card';
import { Pre } from '@oxy.so/bloom/code';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiArrowDownSLine } from '@oxy.so/bloom/icons/RiArrowDownSLine';
import { RiArrowUpSLine } from '@oxy.so/bloom/icons/RiArrowUpSLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiLightbulbLine } from '@oxy.so/bloom/icons/RiLightbulbLine';
import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { RiTerminalBoxLine } from '@oxy.so/bloom/icons/RiTerminalBoxLine';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useState } from 'react';
import { View } from 'react-native';

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

/** One event of the session, expandable to its full content and arguments. */
export function SessionEventCard({ entry }: { entry: EventEntry }) {
  const [expanded, setExpanded] = useState(false);

  const isThreat = isThreatEntry(entry);
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
