import { View, ScrollView } from "react-native";
import { useTranslation } from "@/lib/hooks/use-translation";
import { LocalModelsSection } from "@/components/settings/local-models-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsLocalModelsScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.localModels")} showBack />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <LocalModelsSection />
      </ScrollView>
    </View>
  );
}
