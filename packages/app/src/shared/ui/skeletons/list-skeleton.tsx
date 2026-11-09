import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View } from 'react-native';

/** Widths that vary row to row: identical ones read as a pattern, not as text. */
const TITLE_WIDTHS = ['45%', '60%', '38%', '52%', '66%', '42%'] as const;
const LINE_WIDTHS = ['80%', '72%', '86%', '64%', '78%', '70%'] as const;

/**
 * The rows of a list that is on its way: a mark, a title and a line, shaped like Bloom's `Item` so
 * nothing moves when the data arrives. For every list screen (agents, teams, a session's log, the
 * notification feed): a screen that waits shows THIS, never a spinner or a "Loading" text.
 */
export function ListRowsSkeleton({
  rows = 6,
  mark = 'circle',
  lines = 2,
  className,
}: {
  rows?: number;
  /** What leads each row: an avatar (circle), a tile (square) or nothing. */
  mark?: 'circle' | 'tile' | 'none';
  /** Lines of text beside the mark (a title, plus one under it by default). */
  lines?: 1 | 2;
  className?: string;
}) {
  return (
    <Skeleton.Region className={className}>
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} className="flex-row items-center gap-3 p-3">
          {mark === 'circle' ? <Skeleton.Circle size={32} /> : null}
          {mark === 'tile' ? <Skeleton.Box width={32} height={32} borderRadius={8} /> : null}
          <View className="flex-1 gap-1.5">
            <Skeleton.Box width={TITLE_WIDTHS[index % TITLE_WIDTHS.length]} height={13} />
            {lines === 2 ? (
              <Skeleton.Box width={LINE_WIDTHS[index % LINE_WIDTHS.length]} height={11} />
            ) : null}
          </View>
        </View>
      ))}
    </Skeleton.Region>
  );
}
