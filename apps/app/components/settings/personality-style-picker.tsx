import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import type { LucideIcon } from "lucide-react-native";
import {
  Check,
  Heart,
  Zap,
  Coffee,
  Sparkles,
  Lightbulb,
  GraduationCap,
  Flame,
} from "lucide-react-native";
import { PERSONALITY_STYLES, PERSONALITY_STYLE_MAP, type PersonalityStyleId, type PersonalityStyleUI } from "@/lib/personality-styles";
import { useTranslation } from "@/hooks/useTranslation";
import { usePersonalitySamplePhrase } from "@/hooks/usePersonalitySamplePhrase";
import React, { useEffect, useCallback } from "react";

const ICON_MAP: Record<string, LucideIcon> = {
  Heart,
  Zap,
  Coffee,
  Sparkles,
  Lightbulb,
  GraduationCap,
  Flame,
};

interface PersonalityStylePickerProps {
  selectedStyle: string;
  onSelectStyle: (id: PersonalityStyleId) => void;
}

export function PersonalityStylePicker({
  selectedStyle,
  onSelectStyle,
}: PersonalityStylePickerProps) {
  const { t } = useTranslation();
  const { phrase, isStreaming, fetchPhrase } = usePersonalitySamplePhrase();
  const currentStyleId: PersonalityStyleId =
    PERSONALITY_STYLE_MAP[selectedStyle as PersonalityStyleId]
      ? (selectedStyle as PersonalityStyleId)
      : "clarity";

  useEffect(() => {
    fetchPhrase(currentStyleId);
  }, [currentStyleId, fetchPhrase]);

  const handleSelect = useCallback(
    (id: PersonalityStyleId) => {
      onSelectStyle(id);
      // fetchPhrase is triggered by the useEffect on currentStyleId
    },
    [onSelectStyle],
  );

  return (
    <View className="gap-5">
      {/* Header */}
      <View className="gap-1">
        <Text className="text-xl font-bold text-foreground">
          {t("settings.personalityStyle.title")}
        </Text>
        <Text className="text-sm text-muted-foreground">
          {t("settings.personalityStyle.description")}
        </Text>
      </View>

      {/* Streamed sample phrase */}
      <View className="min-h-[56px] justify-center">
        <Text
          className="text-lg text-foreground italic leading-7"
          numberOfLines={4}
        >
          "{phrase || "..."}"
          {isStreaming && (
            <Text className="text-lg text-muted-foreground">|</Text>
          )}
        </Text>
      </View>

      {/* Personality list */}
      <View className="bg-card rounded-2xl overflow-hidden border border-border">
        {PERSONALITY_STYLES.map((style, index) => (
          <PersonalityRow
            key={style.id}
            style={style}
            isSelected={currentStyleId === style.id}
            isLast={index === PERSONALITY_STYLES.length - 1}
            onPress={() => handleSelect(style.id)}
          />
        ))}
      </View>
    </View>
  );
}

const PersonalityRow = React.memo(function PersonalityRow({
  style,
  isSelected,
  isLast,
  onPress,
}: {
  style: PersonalityStyleUI;
  isSelected: boolean;
  isLast: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const IconComponent = ICON_MAP[style.icon];

  return (
    <Pressable
      onPress={onPress}
      className="active:opacity-70"
    >
      <View className={`flex-row items-center px-4 py-3.5 gap-3 ${!isLast ? "border-b border-border" : ""}`}>
        {/* Icon circle */}
        <View
          className="items-center justify-center"
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: `${style.color}18`,
          }}
        >
          {IconComponent && (
            <IconComponent size={20} color={style.color} />
          )}
        </View>

        {/* Name + tagline */}
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text className="text-[15px] font-semibold text-foreground">
              {style.name}
            </Text>
            {style.popular && (
              <View className="bg-primary/15 rounded-full px-2 py-0.5">
                <Text className="text-[10px] font-bold text-primary uppercase tracking-wider">
                  {t("settings.personalityStyle.popular")}
                </Text>
              </View>
            )}
          </View>
          <Text className="text-[13px] text-muted-foreground">
            {style.tagline}
          </Text>
        </View>

        {/* Checkmark */}
        {isSelected ? (
          <View
            className="items-center justify-center"
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: style.color,
            }}
          >
            <Check size={14} color="#fff" strokeWidth={3} />
          </View>
        ) : (
          <View
            className="items-center justify-center border-2 border-muted-foreground/30"
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
            }}
          />
        )}
      </View>
    </Pressable>
  );
});
