import { View, ScrollView } from "react-native";
import { useTranslation } from "@/hooks/useTranslation";
import { SecuritySection } from "@/components/settings/security-section";
import { SettingsHeader } from "@/components/settings/settings-header";

export default function SettingsSecurityScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t("settings.sections.security")} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 max-w-2xl">
        <SecuritySection />
      </ScrollView>
    </View>
  );
}
