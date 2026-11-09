import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View } from 'react-native';

/**
 * A detail page that is on its way: a header (a mark, a title and a line) and the paragraphs
 * under it. For an agent, a skill, an invitation: the page's own frame is drawn at once and this
 * holds the place of what the lookup brings.
 */
export function DetailSkeleton({ paragraphs = 3 }: { paragraphs?: number }) {
  return (
    <Skeleton.Region className="gap-6 p-4">
      <View className="flex-row items-center gap-4">
        <Skeleton.Circle size={64} />
        <View className="flex-1 gap-2">
          <Skeleton.Box width="50%" height={20} />
          <Skeleton.Box width="30%" height={14} />
        </View>
      </View>
      <View className="gap-4">
        {Array.from({ length: paragraphs }, (_, index) => (
          <View key={index} className="gap-2">
            <Skeleton.Box width="100%" height={13} />
            <Skeleton.Box width="94%" height={13} />
            <Skeleton.Box width={index % 2 === 0 ? '62%' : '48%'} height={13} />
          </View>
        ))}
      </View>
    </Skeleton.Region>
  );
}
