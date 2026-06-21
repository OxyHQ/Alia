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
  colors?: string[];
  selected: string;
  onSelect: (color: string) => void;
  label?: string;
}

export function ColorPicker({
  colors = COLOR_OPTIONS,
  selected,
  onSelect,
  label = "Color",
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
            <View style={{ backgroundColor: color, flex: 1 }} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
