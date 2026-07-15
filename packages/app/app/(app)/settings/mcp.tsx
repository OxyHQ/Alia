import { View, ScrollView } from "react-native";
import { useTranslation } from "@/lib/hooks/use-translation";
import { McpSection } from "@/components/settings/mcp-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsMcpScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.mcp")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <McpSection />
      </ScrollView>
    </View>
  );
}
