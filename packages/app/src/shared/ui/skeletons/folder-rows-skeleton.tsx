import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View } from 'react-native';

/** Widths that vary row to row: identical ones read as a pattern, not as text. */
const ROW_WIDTHS = ['58%', '72%', '48%'] as const;

/**
 * A sidebar folder that is on its way: its label and, indented under it, the contact rows (an
 * avatar, a name and a line) it will hold, shaped like the sidebar's own so nothing moves when the
 * folders arrive. For the Spaces section: it waits with THIS, never a spinner or a "Loading" line.
 */
export function FolderRowsSkeleton({ rows = 2, className }: { rows?: number; className?: string }) {
  return (
    <Skeleton.Region className={className}>
      <View className="gap-3 px-2 py-1">
        <Skeleton.Box width="30%" height={11} />
        {Array.from({ length: rows }, (_, index) => (
          <View key={index} className="flex-row items-center gap-3 pl-3">
            <Skeleton.Circle size={36} />
            <View className="flex-1 gap-1.5">
              <Skeleton.Box width={ROW_WIDTHS[index % ROW_WIDTHS.length]} height={13} />
              <Skeleton.Box width="80%" height={11} />
            </View>
          </View>
        ))}
      </View>
    </Skeleton.Region>
  );
}
