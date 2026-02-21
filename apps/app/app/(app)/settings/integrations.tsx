import { View, ScrollView } from "react-native";
import { useTranslation } from "@/hooks/useTranslation";
import { IntegrationsSection } from "@/components/settings/integrations-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsIntegrationsScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.integrations")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <IntegrationsSection />
      </ScrollView>
    </View>
  );
}
