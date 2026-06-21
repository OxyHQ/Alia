import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

const DOT_COLORS = {
  green: 'bg-green-500',
  orange: 'bg-orange-400',
  primary: 'bg-primary',
} as const;

interface BulletListProps {
  items: string[];
  color?: keyof typeof DOT_COLORS;
  muted?: boolean;
}

export function BulletList({ items, color = 'primary', muted = false }: BulletListProps) {
  return (
    <View className="gap-1.5">
      {items.map((item, i) => (
        <View key={i} className="flex-row items-start gap-2">
          <View className={cn('w-1 h-1 rounded-full mt-1.5', DOT_COLORS[color])} />
          <Text className={cn('text-[13px] flex-1', muted ? 'text-muted-foreground' : 'text-foreground')}>
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}
