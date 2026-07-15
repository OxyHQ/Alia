import { View, ScrollView } from "react-native";
import { useTranslation } from "@/lib/hooks/use-translation";
import { BotsSection } from "@/components/settings/bots-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsBotsScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.bots")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <BotsSection />
      </ScrollView>
    </View>
  );
}
