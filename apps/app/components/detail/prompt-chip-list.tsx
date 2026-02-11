import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { ChevronRight } from 'lucide-react-native';

interface PromptChipListProps {
  items: string[];
  onPress?: (item: string) => void;
}

export function PromptChipList({ items, onPress }: PromptChipListProps) {
  return (
    <View className="gap-1.5">
      {items.map((item, i) => (
        <Pressable key={i} onPress={() => onPress?.(item)} className="active:opacity-70">
          <View className="flex-row items-center gap-2.5 py-2.5 px-3 bg-muted/40 rounded-lg">
            <Text className="text-[13px] text-foreground flex-1">"{item}"</Text>
            <ChevronRight size={13} className="text-muted-foreground" />
          </View>
        </Pressable>
      ))}
    </View>
  );
}
