import type {
  AgentActivityState,
  AgentScreenshot,
} from '@/lib/hooks/use-agent-activity';
import { useTranslation } from '@/lib/hooks/use-translation';
import { getToolPillLabel } from '@/lib/task-utils';
import { Admonition } from '@oxy.so/bloom/admonition';
import { AgentProgress } from '@oxy.so/bloom/agent-progress';
import { AgentThinking } from '@oxy.so/bloom/agent-thinking';
import { Badge } from '@oxy.so/bloom/badge';
import { Card, CardBody, CardHeader } from '@oxy.so/bloom/card';
import { Muted } from '@oxy.so/bloom/typography';
import { Image } from 'expo-image';
import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

/**
 * AgentTaskCard — an agent run in progress, inline in the chat.
 *
 * Bloom all the way down: a `Card` whose header carries the run's status as a
 * `Badge` with the elapsed time, the plan as `AgentProgress` (its rings are the
 * checklist), what the agent is doing right now as `AgentThinking`, and an
 * error as an `Admonition`. The tool is named by its product label, never by
 * its internal name.
 */

interface AgentTaskCardProps {
  activity: AgentActivityState;
}

/** `42s`, `3m 5s` — how long the run has been going. */
export function formatRunElapsed(startedAt: number | null, now: number): string {
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The plan's lines as `AgentProgress` steps. The steps are also its React keys,
 * and a plan can repeat a line ("Run the tests" twice), so a repeat is told
 * apart by its position rather than dropped.
 */
export function uniqueStepLabels(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return count === 1 ? text : `${text} (${count})`;
  });
}

function ScreenshotThumbnail({ screenshot }: { screenshot: AgentScreenshot }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={screenshot.url}
      onPress={() => setExpanded((open) => !open)}
      className="overflow-hidden rounded-lg"
    >
      <Image
        source={{ uri: `data:image/png;base64,${screenshot.base64}` }}
        className={expanded ? 'h-[200px] w-[320px]' : 'h-[75px] w-[120px]'}
        contentFit="cover"
      />
    </Pressable>
  );
}

export const AgentTaskCard = React.memo(function AgentTaskCard({ activity }: AgentTaskCardProps) {
  const { t } = useTranslation();
  const { plan, screenshots, currentAction, isComplete, hasError, lastError, eventCount, startedAt, latestResponse } =
    activity;
  const [now, setNow] = useState(() => Date.now());

  // The clock runs while the agent does; a finished run keeps its last reading.
  useEffect(() => {
    if (!startedAt || isComplete) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [startedAt, isComplete]);

  // Nothing to show yet
  if (!plan && !currentAction && eventCount === 0) return null;

  const elapsed = formatRunElapsed(startedAt, now);
  const status = isComplete
    ? { color: 'success' as const, label: t('chat.agentRun.complete') }
    : hasError
      ? { color: 'error' as const, label: t('chat.agentRun.error') }
      : { color: 'info' as const, label: t('chat.agentRun.working') };

  return (
    <Card>
      <CardHeader>
        <View className="flex-row items-center justify-between gap-2">
          <Badge variant="subtle" color={status.color} content={status.label} />
          <Muted>
            {[elapsed, plan && plan.total > 0 ? `${plan.completed}/${plan.total}` : '']
              .filter((part) => part !== '')
              .join(' · ')}
          </Muted>
        </View>
      </CardHeader>
      <CardBody>
        <View className="gap-3">
          {plan && plan.items.length > 0 ? (
            <AgentProgress
              steps={uniqueStepLabels(plan.items.map((item) => item.text))}
              completedCount={plan.completed}
            />
          ) : null}

          {currentAction && !isComplete ? (
            <AgentThinking
              variant="wave"
              label={
                currentAction.content
                  ? `${getToolPillLabel(currentAction.toolName)} · ${
                      currentAction.content.length > 80
                        ? `${currentAction.content.slice(0, 80)}…`
                        : currentAction.content
                    }`
                  : getToolPillLabel(currentAction.toolName)
              }
            />
          ) : null}

          {latestResponse && !isComplete ? (
            <Muted numberOfLines={4}>
              {latestResponse.length > 200 ? `${latestResponse.slice(0, 200)}…` : latestResponse}
            </Muted>
          ) : null}

          {hasError && lastError ? <Admonition type="error">{lastError}</Admonition> : null}

          {screenshots.length > 0 ? (
            <View className="gap-1.5">
              <Muted>{t('chat.agentRun.browser')}</Muted>
              <View className="flex-row flex-wrap gap-2">
                {screenshots.map((s, i) => (
                  <ScreenshotThumbnail key={`ss-${i}`} screenshot={s} />
                ))}
              </View>
            </View>
          ) : null}
        </View>
      </CardBody>
    </Card>
  );
});
