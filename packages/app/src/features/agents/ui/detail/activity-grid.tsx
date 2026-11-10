import {
  CELL_SIZE,
  GAP,
  MAX_WEEKS,
  interactionsIn,
  localDay,
  weeksThatFit,
} from '@/features/agents/model/activity-window';
import { useActivityGrid } from '@/features/agents/runtime/use-activity-grid';
import { useTranslation } from '@/shared/i18n/use-translation';
import { ActivityHeatmap } from '@oxy.so/bloom/activity-heatmap';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';

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
  const steps = [0.25, 0.5, 0.75].map((ratio) => Math.max(2, Math.ceil(ratio * maxCount) + 1));
  return [...new Set(steps)];
}

/**
 * An agent's interactions per day, as Bloom's `ActivityHeatmap`: as many recent weeks as fit the
 * width the section has, ending today (`model/activity-window.ts` says why). A year is asked of the
 * API once; what is drawn and counted is the part of it that fits.
 */
export function ActivityGrid({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const { data, isLoading } = useActivityGrid(agentId, MAX_WEEKS);
  const grid = useMemo(() => data?.grid ?? [], [data?.grid]);
  // The day is read once per mount: a page left open past midnight keeps yesterday's edge until it
  // is opened again, which costs one empty cell.
  const today = useMemo(() => localDay(new Date()), []);

  const onLayout = (event: LayoutChangeEvent) => {
    const next = Math.floor(event.nativeEvent.layout.width);
    if (next !== width) setWidth(next);
  };

  const weeks = weeksThatFit(width);
  const interactions = useMemo(() => interactionsIn(grid, today, weeks), [grid, today, weeks]);

  return (
    <View className="gap-1.5" onLayout={onLayout}>
      {isLoading || width === 0 ? (
        <Skeleton.Box width="100%" height={96} />
      ) : (
        <>
          <Muted>
            {t('agents.activityGrid.summary', {
              interactions: t('agents.activityGrid.interactions', { count: interactions }),
              weeks,
            })}
          </Muted>
          <ActivityHeatmap
            data={grid}
            numDays={weeks * 7}
            endDate={today}
            cellSize={CELL_SIZE}
            gap={GAP}
            weekStartsOn={1}
            levels={levelsFor(data?.maxCount ?? 0)}
            onPressDay={(day) =>
              toast(
                t('agents.activityGrid.day', {
                  interactions: t('agents.activityGrid.interactions', { count: day.count }),
                  date: formatDisplayDate(day.date),
                }),
              )
            }
          />
        </>
      )}
    </View>
  );
}
