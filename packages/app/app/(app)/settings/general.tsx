import { View, ScrollView } from "react-native";
import { useTranslation } from "@/lib/hooks/use-translation";
import { GeneralSection } from "@/components/settings/general-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsGeneralScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.general")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <GeneralSection />
      </ScrollView>
    </View>
  );
}
