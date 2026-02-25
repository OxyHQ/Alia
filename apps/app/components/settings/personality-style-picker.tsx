import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { LinearGradient } from "expo-linear-gradient";
import { Sparkles } from "lucide-react-native";
import { PERSONALITY_STYLES, type PersonalityStyleId } from "@/lib/personality-styles";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";

interface PersonalityStylePickerProps {
  selectedStyle: string;
  onSelectStyle: (id: PersonalityStyleId) => void;
}

export function PersonalityStylePicker({
  selectedStyle,
  onSelectStyle,
}: PersonalityStylePickerProps) {
  const { t } = useTranslation();

  return (
    <View className="gap-1.5">
      <View className="flex-row items-center gap-2">
        <Sparkles size={18} className="text-primary" />
        <Text className="text-sm font-semibold">
          {t("settings.personalityStyle.title")}
        </Text>
      </View>
      <Text className="text-xs text-muted-foreground">
        {t("settings.personalityStyle.description")}
      </Text>

      <View className="flex-row flex-wrap gap-3 mt-1">
        {PERSONALITY_STYLES.map((style) => {
          const isSelected = selectedStyle === style.id;
          return (
            <Pressable
              key={style.id}
              onPress={() => onSelectStyle(style.id)}
              className="flex-1 min-w-[140px]"
            >
              <View
                className={cn(
                  "rounded-2xl overflow-hidden",
                  isSelected
                    ? "border-2 border-foreground"
                    : "border border-border"
                )}
              >
                <LinearGradient
                  colors={[style.gradient[0], style.gradient[1]]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={{ padding: 16, minHeight: 160 }}
                >
                  {/* Emoji */}
                  <Text className="text-3xl mb-2">{style.emoji}</Text>

                  {/* Name */}
                  <Text className="text-base font-bold text-white mb-1">
                    {style.name}
                  </Text>

                  {/* Sample greeting */}
                  <Text
                    className="text-xs text-white/80 leading-4"
                    numberOfLines={3}
                  >
                    {style.sampleGreeting}
                  </Text>
                </LinearGradient>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
