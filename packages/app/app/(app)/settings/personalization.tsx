import { View, ScrollView } from "react-native";
import { useTranslation } from "@/lib/hooks/use-translation";
import { PersonalizationSection } from "@/components/settings/personalization-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsPersonalizationScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.personalization")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <PersonalizationSection />
      </ScrollView>
    </View>
  );
}
