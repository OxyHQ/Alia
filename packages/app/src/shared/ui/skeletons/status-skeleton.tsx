import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View } from 'react-native';

/**
 * A centred status block that is on its way (a mark, a title, a line and a button), the shape of
 * Bloom's `EmptyState`: for the cards of the sign-in flows (an invitation, an authorization) while
 * the account is still being read.
 */
export function StatusSkeleton() {
  return (
    <Skeleton.Region className="items-center gap-4 py-8">
      <Skeleton.Circle size={64} />
      <View className="items-center gap-2">
        <Skeleton.Box width={200} height={18} />
        <Skeleton.Box width={260} height={13} />
      </View>
      <Skeleton.Pill size={40} />
    </Skeleton.Region>
  );
}

/**
 * A row of cards that are on their way (the plans of the subscribe page): equal columns that wrap,
 * each the height of a real card, so the page does not move when they arrive.
 */
export function CardsSkeleton({ count = 3, height = 360 }: { count?: number; height?: number }) {
  return (
    <Skeleton.Region className="flex-row flex-wrap justify-center gap-4 py-4">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton.Box key={index} width={280} height={height} borderRadius={24} />
      ))}
    </Skeleton.Region>
  );
}
