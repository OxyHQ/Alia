import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import type { PromptCompletion } from "@/lib/prompt-completions";

interface PromptAutocompleteProps {
  completions: PromptCompletion[];
  onSelect: (completion: PromptCompletion) => void;
}

export function PromptAutocomplete({
  completions,
  onSelect,
}: PromptAutocompleteProps) {
  if (completions.length === 0) return null;

  return (
    <View className="pb-2">
      {completions.map((item) => (
        <Pressable
          key={item.text}
          onPress={() => onSelect(item)}
          className="px-3 py-2.5 rounded-lg active:bg-muted/50"
        >
          <Text className="text-sm leading-5" numberOfLines={1}>
            <Text className="text-foreground">
              {item.text.slice(0, item.matchStart)}
            </Text>
            <Text className="text-primary font-medium">
              {item.text.slice(item.matchStart, item.matchEnd)}
            </Text>
            <Text className="text-foreground">
              {item.text.slice(item.matchEnd)}
            </Text>
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
