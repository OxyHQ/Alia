import { WorkspaceBrowser } from '@/components/workspace-browser';
import type { AgentActivityState, PlanItem } from '@/lib/hooks/use-agent-activity';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@oxy.so/bloom/accordion';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Card, CardBody, CardHeader } from '@oxy.so/bloom/card';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { Item } from '@oxy.so/bloom/item';
import { Muted, Text } from '@oxy.so/bloom/typography';
import React, { useState } from 'react';
import { View } from 'react-native';

/**
 * AgentResultCard — the summary an agent run leaves in the chat when it ends.
 *
 * A Bloom `Card`: the outcome as a `Badge` beside the heading, the run's
 * numbers in one secondary line, an error as an `Admonition`, and the plan and
 * the workspace's files as two `Accordion` sections. The file browser mounts
 * only while its section is open — it fetches the session's files, and a
 * closed section asks for nothing.
 */

interface AgentResultCardProps {
  activity: AgentActivityState;
  sessionId: string;
  agentName?: string;
}

/** `42s`, `3m 5s`, `1h 2m` — how long the run took. */
export function formatRunDuration(startedAt: number | null, now: number): string {
  if (!startedAt) return '--';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const PLAN_ICON = {
  completed: RiCheckboxCircleLine,
  blocked: RiAlertLine,
} as const;

function PlanItemRow({ item }: { item: PlanItem }) {
  const Icon = PLAN_ICON[item.status as keyof typeof PLAN_ICON] ?? RiCloseCircleLine;
  return (
    <Item
      density="compact"
      role="listitem"
      leading={<Icon size="sm" />}
      title={item.text}
    />
  );
}

export const AgentResultCard = React.memo(function AgentResultCard({
  activity,
  sessionId,
  agentName,
}: AgentResultCardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string[]>([]);
  // Measured once, when the card first draws the finished run.
  const [now] = useState(() => Date.now());

  const { plan, isComplete, hasError, lastError, eventCount, startedAt } = activity;
  const isSuccess = isComplete && !hasError;

  const stats = [
    formatRunDuration(startedAt, now),
    t('chat.agentRun.steps', { count: String(eventCount) }),
    plan ? t('chat.agentRun.planItems', { done: String(plan.completed), total: String(plan.total) }) : null,
    activity.creditsCharged != null
      ? t('chat.agentRun.credits', { count: String(activity.creditsCharged) })
      : null,
  ].filter((part): part is string => part !== null);

  return (
    <Card>
      <CardHeader>
        <View className="flex-row items-center gap-2">
          <Badge
            variant="subtle"
            color={isSuccess ? 'success' : hasError ? 'error' : 'default'}
            content={t(isSuccess ? 'chat.agentRun.completed' : hasError ? 'chat.agentRun.failed' : 'chat.agentRun.unknown')}
          />
          <View className="min-w-0 flex-1">
            <Text variant="headline-semibold">
              {t(isSuccess ? 'chat.agentRun.taskComplete' : 'chat.agentRun.taskFailed')}
            </Text>
            {agentName ? <Muted>{t('chat.agentRun.by', { name: agentName })}</Muted> : null}
          </View>
        </View>
      </CardHeader>
      <CardBody>
        <View className="gap-3">
          <Muted>{stats.join(' · ')}</Muted>

          {hasError && lastError ? <Admonition type="error">{lastError}</Admonition> : null}

          <Accordion
            type="multiple"
            value={open}
            onValueChange={(next) => setOpen(Array.isArray(next) ? next : next ? [next] : [])}
          >
            {plan && plan.items.length > 0 ? (
              <AccordionItem value="plan">
                <AccordionTrigger>{t('chat.agentRun.planSummary')}</AccordionTrigger>
                <AccordionContent>
                  {plan.items.map((item) => (
                    <PlanItemRow key={item.id} item={item} />
                  ))}
                </AccordionContent>
              </AccordionItem>
            ) : null}
            <AccordionItem value="files">
              <AccordionTrigger>{t('chat.agentRun.files')}</AccordionTrigger>
              <AccordionContent>
                {open.includes('files') ? <WorkspaceBrowser sessionId={sessionId} /> : null}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </View>
      </CardBody>
    </Card>
  );
});
