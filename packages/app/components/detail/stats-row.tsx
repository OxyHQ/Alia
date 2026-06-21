import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Star } from 'lucide-react-native';

interface StatsRowProps {
  rating: number;
  reviewCount: number;
  usageCount: number;
  forkCount: number;
  version: string;
}

export function StatsRow({ rating, reviewCount, usageCount, forkCount, version }: StatsRowProps) {
  const formattedUsage = usageCount > 1000 ? `${(usageCount / 1000).toFixed(1)}k` : usageCount;

  return (
    <View className="flex-row items-center gap-4 mb-4">
      <View className="flex-row items-center gap-1">
        <Star size={13} className="text-amber-500" fill="#f59e0b" />
        <Text className="text-[13px] font-bold text-foreground">{rating}</Text>
        <Text className="text-[11px] text-muted-foreground">({reviewCount})</Text>
      </View>
      <Text className="text-[11px] text-muted-foreground">·</Text>
      <Text className="text-[12px] text-muted-foreground">{formattedUsage} uses</Text>
      <Text className="text-[11px] text-muted-foreground">·</Text>
      <Text className="text-[12px] text-muted-foreground">{forkCount} forks</Text>
      <Text className="text-[11px] text-muted-foreground">·</Text>
      <Text className="text-[12px] text-muted-foreground">v{version}</Text>
    </View>
  );
}
