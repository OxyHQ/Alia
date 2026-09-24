import { useActivityGrid } from '@/lib/hooks/use-activity-grid';
import { useIsLargeScreen } from '@/lib/hooks/use-is-large-screen';
import { ActivityHeatmap } from '@oxy.so/bloom/activity-heatmap';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';

function formatDisplayDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * The thresholds between colour steps, at the quarters of the busiest day.
 *
 * Bloom's defaults (3 / 6 / 10) suit a uniform spread; an agent's days are
 * skewed, so the steps follow its own maximum the way the hand-drawn grid did.
 * Each threshold is at least 2, so the faintest step can still paint.
 */
function levelsFor(maxCount: number): number[] | undefined {
  if (maxCount < 4) return undefined;
  const steps = [0.25, 0.5, 0.75].map((ratio) =>
    Math.max(2, Math.ceil(ratio * maxCount) + 1),
  );
  return [...new Set(steps)];
}

interface ActivityGridProps {
  agentId: string;
  weeks?: number;
}

/** An agent's interactions per day, as Bloom's `ActivityHeatmap`. */
export function ActivityGrid({ agentId, weeks: weeksProp }: ActivityGridProps) {
  const isLargeScreen = useIsLargeScreen();
  const weeks = weeksProp ?? (isLargeScreen ? 52 : 20);

  const { data, isLoading } = useActivityGrid(agentId, weeks);
  const grid = useMemo(() => data?.grid ?? [], [data?.grid]);
  const totalSessions = data?.totalSessions ?? 0;

  if (isLoading) {
    return <Skeleton.Box width="100%" height={96} />;
  }

  return (
    <View className="gap-1.5">
      <Muted>
        {totalSessions} interaction{totalSessions !== 1 ? 's' : ''} in the last{' '}
        {weeks} weeks
      </Muted>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <ActivityHeatmap
          data={grid}
          numDays={weeks * 7}
          weekStartsOn={1}
          levels={levelsFor(data?.maxCount ?? 0)}
          onPressDay={(day) =>
            toast(
              `${day.count} interaction${day.count !== 1 ? 's' : ''} on ${formatDisplayDate(day.date)}`,
            )
          }
        />
      </ScrollView>
    </View>
  );
}
