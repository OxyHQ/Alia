import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { LinearGradient } from "expo-linear-gradient";
import { Check } from "lucide-react-native";
import { PERSONALITY_STYLES, type PersonalityStyleId } from "@/lib/personality-styles";
import { useTranslation } from "@/hooks/useTranslation";

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
    <View className="gap-2">
      <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
        {t("settings.personalityStyle.title")}
      </Text>

      <View className="flex-row flex-wrap gap-2.5">
        {PERSONALITY_STYLES.map((style) => {
          const isSelected = selectedStyle === style.id;
          return (
            <Pressable
              key={style.id}
              onPress={() => onSelectStyle(style.id)}
              className="flex-1 min-w-[140px]"
              style={{ opacity: isSelected ? 1 : 0.75 }}
            >
              <LinearGradient
                colors={style.gradient as [string, string, ...string[]]}
                start={{ x: 0, y: 0 }}
                end={{ x: 0.5, y: 1 }}
                style={{
                  borderRadius: 20,
                  padding: 16,
                  paddingBottom: 20,
                  minHeight: 170,
                  justifyContent: "space-between",
                }}
              >
                {/* Top row: emoji + check */}
                <View className="flex-row items-start justify-between">
                  <Text style={{ fontSize: 36 }}>{style.emoji}</Text>
                  {isSelected && (
                    <View
                      className="items-center justify-center"
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        backgroundColor: "rgba(255,255,255,0.3)",
                      }}
                    >
                      <Check size={14} color="#fff" strokeWidth={3} />
                    </View>
                  )}
                </View>

                {/* Bottom: name + greeting */}
                <View className="gap-1">
                  <Text
                    style={{
                      fontSize: 15,
                      fontWeight: "700",
                      color: "#fff",
                    }}
                  >
                    {style.name}
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: "rgba(255,255,255,0.7)",
                      lineHeight: 16,
                    }}
                    numberOfLines={3}
                  >
                    {style.sampleGreeting}
                  </Text>
                </View>
              </LinearGradient>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
