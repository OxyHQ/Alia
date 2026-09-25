import {
  sessionAlertCounts,
  type EventEntry,
  type SessionInfo,
} from '@/features/agents/runtime/use-session-activity';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { AccentTone } from '@oxy.so/bloom/theme';
import { Badge } from '@oxy.so/bloom/badge';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { Muted } from '@oxy.so/bloom/typography';
import { View } from 'react-native';

/** The session's status, as a badge tone. */
function statusTone(status: string): AccentTone {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'running') return 'info';
  return 'default';
}

/** What the session was asked to do, then its status and counts. */
export function SessionSummary({
  session,
  entries,
}: {
  session: SessionInfo;
  entries: readonly EventEntry[];
}) {
  const { t } = useTranslation();
  const { threats: threatCount, errors: errorCount } =
    sessionAlertCounts(entries);

  return (
    <>
      {/* What this session was asked to do. */}
      <View className="px-4">
        <Muted numberOfLines={2}>{session.task}</Muted>
      </View>

      {/* Stats */}
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
    </>
  );
}
