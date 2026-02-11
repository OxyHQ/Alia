import { View } from 'react-native';
import { Text } from '@/components/ui/text';

interface PillListProps {
  items: string[];
}

export function PillList({ items }: PillListProps) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {items.map((item, i) => (
        <View key={i} className="px-2.5 py-1 bg-muted/60 rounded-full">
          <Text className="text-[12px] text-foreground">{item}</Text>
        </View>
      ))}
    </View>
  );
}
