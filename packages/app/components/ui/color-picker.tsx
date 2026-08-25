import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export const COLOR_OPTIONS = [
  "#3b82f6", // blue
  "#8b5cf6", // purple
  "#ec4899", // pink
  "#f59e0b", // amber
  "#10b981", // green
  "#06b6d4", // cyan
  "#f97316", // orange
  "#ef4444", // red
];

interface ColorPickerProps {
  colors?: readonly string[];
  selected: string;
  onSelect: (color: string) => void;
  label?: string;
  /**
   * What each swatch draws, when the value is not a colour to fill with.
   *
   * Projects and folders store a hex and a filled circle IS the choice. An
   * agent stores a Bloom preset key, and what the choice produces is its mark —
   * so the mark is what it offers, rather than a dot that stands for one.
   */
  renderSwatch?: (value: string) => React.ReactNode;
}

export function ColorPicker({
  colors = COLOR_OPTIONS,
  selected,
  onSelect,
  label = "Color",
  renderSwatch,
}: ColorPickerProps) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      <View className="flex-row flex-wrap gap-2">
        {colors.map((color) => (
          <Pressable
            key={color}
            onPress={() => onSelect(color)}
            className={cn(
              "h-10 w-10 rounded-full border-2 overflow-hidden",
              selected === color
                ? "border-foreground scale-110"
                : "border-transparent"
            )}
          >
            {renderSwatch ? (
              <View className="flex-1 items-center justify-center">{renderSwatch(color)}</View>
            ) : (
              <View style={{ backgroundColor: color, flex: 1 }} />
            )}
          </Pressable>
        ))}
      </View>
    </View>
  );
}
