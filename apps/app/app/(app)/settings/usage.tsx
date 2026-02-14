import { View, ScrollView } from "react-native";
import { useTranslation } from "@/hooks/useTranslation";
import { UsageSection } from "@/components/settings/usage-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsUsageScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.usage")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <UsageSection />
      </ScrollView>
    </View>
  );
}
