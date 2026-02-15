import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { useColorScheme } from "@/lib/useColorScheme";
import { useThemeStore } from "@/lib/stores/theme-store";
import { useTranslation } from "@/hooks/useTranslation";
import { LanguageSelector } from "@/components/language-selector";
import { ACCENT_PRESETS, ACCENT_COLOR_NAMES, type AccentColorName } from "@/lib/accent-presets";
import { cn } from "@/lib/utils";

/** Miniature app layout mimicking sidebar + main content */
function AppMiniature({ variant, accentHex }: { variant: "light" | "dark"; accentHex: string }) {
  const isLight = variant === "light";
  const sidebarBg = isLight ? "#f0f0f0" : "#141829";
  const mainBg = isLight ? "#ffffff" : "#0a0d1a";
  const lineBg = isLight ? "#d4d4d4" : "#2a2f3d";
  const titleBg = isLight ? "#a3a3a3" : "#4b5563";

  return (
    <View className="flex-row flex-1 rounded overflow-hidden">
      {/* Sidebar */}
      <View className="p-1 gap-0.5 justify-between" style={{ backgroundColor: sidebarBg, width: "27%" }}>
        <View className="gap-0.5">
          {/* New Chat button */}
          <View className="h-1.5 rounded-sm" style={{ backgroundColor: accentHex }} />
          {/* Nav items */}
          <View className="h-[1px] w-3/4 rounded-full mt-0.5" style={{ backgroundColor: lineBg }} />
          <View className="h-[1px] w-2/3 rounded-full" style={{ backgroundColor: lineBg }} />
          <View className="h-[1px] w-3/4 rounded-full" style={{ backgroundColor: lineBg }} />
          <View className="h-[1px] w-1/2 rounded-full" style={{ backgroundColor: lineBg }} />
        </View>
        {/* History items */}
        <View className="gap-0.5">
          <View className="h-[1px] w-2/3 rounded-full" style={{ backgroundColor: lineBg }} />
          <View className="h-[1px] w-3/4 rounded-full" style={{ backgroundColor: lineBg }} />
        </View>
      </View>
      {/* Main content */}
      <View className="flex-1 p-1.5 justify-between" style={{ backgroundColor: mainBg }}>
        {/* Greeting */}
        <View className="items-center gap-0.5 mt-0.5">
          <View className="h-[2px] w-3/5 rounded-full" style={{ backgroundColor: titleBg }} />
          <View className="h-[1px] w-2/5 rounded-full" style={{ backgroundColor: lineBg }} />
        </View>
        {/* Suggestion cards 2x2 */}
        <View className="gap-[2px] px-0.5">
          <View className="flex-row gap-[2px]">
            <View className="flex-1 h-1.5 rounded-sm" style={{ backgroundColor: lineBg }} />
            <View className="flex-1 h-1.5 rounded-sm" style={{ backgroundColor: lineBg }} />
          </View>
          <View className="flex-row gap-[2px]">
            <View className="flex-1 h-1.5 rounded-sm" style={{ backgroundColor: lineBg }} />
            <View className="flex-1 h-1.5 rounded-sm" style={{ backgroundColor: lineBg }} />
          </View>
        </View>
        {/* Input bar */}
        <View className="h-1.5 rounded-sm" style={{ backgroundColor: lineBg }} />
      </View>
    </View>
  );
}

export function GeneralSection() {
  const { mode, setColorScheme } = useColorScheme();
  const accentColor = useThemeStore((s) => s.accentColor);
  const setAccentColor = useThemeStore((s) => s.setAccentColor);
  const accentHex = ACCENT_PRESETS[accentColor].hex;
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
              className={`rounded-lg p-1.5 ${
                mode === "light" ? "border-2 border-primary" : "border border-border"
              }`}
            >
              <View className="mb-1.5 aspect-[5/3]">
                <AppMiniature variant="light" accentHex={accentHex} />
              </View>
              <Text className="text-center text-xs font-medium text-foreground">
                {t("settings.appearance.light")}
              </Text>
            </View>
          </Pressable>

          {/* Follow System */}
          <Pressable onPress={() => setColorScheme("system")} className="flex-1">
            <View
              className={`rounded-lg p-1.5 ${
                mode === "system" ? "border-2 border-primary" : "border border-border"
              }`}
            >
              <View className="rounded overflow-hidden mb-1.5 aspect-[5/3]">
                <View className="flex-row flex-1">
                  <View className="flex-1 overflow-hidden">
                    <AppMiniature variant="light" accentHex={accentHex} />
                  </View>
                  <View className="flex-1 overflow-hidden">
                    <AppMiniature variant="dark" accentHex={accentHex} />
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
              className={`rounded-lg p-1.5 ${
                mode === "dark" ? "border-2 border-primary" : "border border-border"
              }`}
            >
              <View className="mb-1.5 aspect-[5/3]">
                <AppMiniature variant="dark" accentHex={accentHex} />
              </View>
              <Text className="text-center text-xs font-medium text-foreground">
                {t("settings.appearance.dark")}
              </Text>
            </View>
          </Pressable>
        </View>
      </View>

      {/* Accent Color */}
      <View className="gap-2">
        <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
          {t("settings.accentColor.title")}
        </Text>

        <View className="flex-row gap-3 flex-wrap">
          {ACCENT_COLOR_NAMES.map((key) => {
            const preset = ACCENT_PRESETS[key];
            const isSelected = accentColor === key;
            return (
              <Pressable
                key={key}
                onPress={() => setAccentColor(key)}
                className="items-center gap-1.5"
              >
                <View
                  className={cn(
                    "w-8 h-8 rounded-full border-2",
                    isSelected ? "border-foreground scale-110" : "border-transparent"
                  )}
                  style={{ backgroundColor: preset.hex }}
                />
                <Text
                  className={cn(
                    "text-[10px]",
                    isSelected ? "text-foreground font-medium" : "text-muted-foreground"
                  )}
                >
                  {t(`settings.accentColor.${key}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}
