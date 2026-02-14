import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";
import { LanguageSelector } from "@/components/language-selector";

export function GeneralSection() {
  const { mode, setColorScheme } = useColorScheme();
  const { t } = useTranslation();

  return (
    <View className="gap-5">
      {/* App Language */}
      <LanguageSelector />

      {/* Appearance */}
      <View className="gap-2">
        <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
          {t("settings.appearance.title")}
        </Text>

        <View className="flex-row gap-2">
          {/* Light */}
          <Pressable onPress={() => setColorScheme("light")} className="flex-1">
            <View
              className={`rounded-lg p-2 ${
                mode === "light" ? "border-2 border-primary" : "border border-border"
              }`}
            >
              <View className="bg-white rounded p-2 mb-1.5 aspect-[5/3]">
                <View className="flex-row gap-1 mb-1">
                  <View className="w-5 h-0.5 bg-gray-300 rounded" />
                  <View className="w-8 h-0.5 bg-gray-300 rounded" />
                </View>
                <View className="flex-row gap-1">
                  <View className="w-6 h-0.5 bg-gray-300 rounded" />
                  <View className="w-10 h-0.5 bg-gray-300 rounded" />
                </View>
              </View>
              <Text className="text-center text-xs font-medium text-foreground">
                {t("settings.appearance.light")}
              </Text>
            </View>
          </Pressable>

          {/* Follow System */}
          <Pressable onPress={() => setColorScheme("system")} className="flex-1">
            <View
              className={`rounded-lg p-2 ${
                mode === "system" ? "border-2 border-primary" : "border border-border"
              }`}
            >
              <View className="rounded overflow-hidden mb-1.5 aspect-[5/3]">
                <View className="flex-row flex-1">
                  <View className="flex-1 bg-white p-2">
                    <View className="flex-row gap-1 mb-1">
                      <View className="w-4 h-0.5 bg-gray-300 rounded" />
                      <View className="w-5 h-0.5 bg-gray-300 rounded" />
                    </View>
                    <View className="flex-row gap-1">
                      <View className="w-5 h-0.5 bg-gray-300 rounded" />
                    </View>
                  </View>
                  <View className="flex-1 bg-[#1a1a1a] p-2 items-end">
                    <View className="flex-row gap-1 mb-1">
                      <View className="w-4 h-0.5 bg-gray-600 rounded" />
                      <View className="w-5 h-0.5 bg-gray-600 rounded" />
                    </View>
                    <View className="flex-row gap-1">
                      <View className="w-5 h-0.5 bg-gray-600 rounded" />
                    </View>
                  </View>
                </View>
              </View>
              <Text className="text-center text-xs font-medium text-foreground">
                {t("settings.appearance.system")}
              </Text>
            </View>
          </Pressable>

          {/* Dark */}
          <Pressable onPress={() => setColorScheme("dark")} className="flex-1">
            <View
              className={`rounded-lg p-2 ${
                mode === "dark" ? "border-2 border-primary" : "border border-border"
              }`}
            >
              <View className="bg-[#1a1a1a] rounded p-2 mb-1.5 aspect-[5/3]">
                <View className="flex-row gap-1 mb-1">
                  <View className="w-5 h-0.5 bg-gray-600 rounded" />
                  <View className="w-8 h-0.5 bg-gray-600 rounded" />
                </View>
                <View className="flex-row gap-1">
                  <View className="w-6 h-0.5 bg-gray-600 rounded" />
                  <View className="w-10 h-0.5 bg-gray-600 rounded" />
                </View>
              </View>
              <Text className="text-center text-xs font-medium text-foreground">
                {t("settings.appearance.dark")}
              </Text>
            </View>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
