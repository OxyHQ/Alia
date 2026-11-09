import * as Skeleton from '@oxy.so/bloom/skeleton';
import { View } from 'react-native';

/**
 * A conversation's turns that are on their way: the person's bubbles at the end, the replies as
 * lines at the start, with the shape and the uneven widths of the real thread, so nothing moves
 * when it arrives. The one placeholder of every surface that waits for a thread (the chat, a
 * shared conversation).
 */
export function ThreadSkeleton() {
  return (
    <Skeleton.Region className="gap-5 py-4">
      <View className="items-end">
        <Skeleton.Box width="65%" height={48} borderRadius={24} />
      </View>
      <View className="items-start gap-2.5">
        <Skeleton.Box width="80%" height={14} borderRadius={8} />
        <Skeleton.Box width="70%" height={14} borderRadius={8} />
        <Skeleton.Box width="45%" height={14} borderRadius={8} />
      </View>
      <View className="items-end">
        <Skeleton.Box width="50%" height={40} borderRadius={24} />
      </View>
      <View className="items-start gap-2.5">
        <Skeleton.Box width="85%" height={14} borderRadius={8} />
        <Skeleton.Box width="60%" height={14} borderRadius={8} />
      </View>
    </Skeleton.Region>
  );
}
