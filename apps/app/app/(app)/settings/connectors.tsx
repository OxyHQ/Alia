import { View, ScrollView } from "react-native";
import { useTranslation } from "@/hooks/useTranslation";
import { ConnectorsSection } from "@/components/settings/connectors-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsConnectorsScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.connectors")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <ConnectorsSection />
      </ScrollView>
    </View>
  );
}
